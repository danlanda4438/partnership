"use client";
// Reads the spreadsheets in the browser (they never leave this computer as files), builds the
// same reconciliation report as the dry run, then sends the import to the app in small pieces.
import { useState } from "react";
import {
  applyVerification, buildChunks, buildPlan, buildReport, readWorkbook, renderReportHtml,
  type ImportChunk, type Report, type Snapshot,
} from "@gleeday/migration";
import { finishImport, importChunk, startImport } from "./actions";

type Role = "affiliates" | "coMarketing" | "mediaPr" | "listings" | "index" | "verification";
const ROLE_LABEL: Record<Role, string> = {
  affiliates: "Affiliates", coMarketing: "Co-Marketing", mediaPr: "Media & PR", listings: "Listings",
  index: "Partnerships index", verification: "Verification (optional)",
};

// Identified by their tabs, so file names don't matter.
function identify(s: Snapshot): Role | null {
  const has = (n: string) => s.tabs.some((t) => t.name.trim().toLowerCase() === n.toLowerCase());
  if (has("Lead actual status")) return "verification";
  if (has("Outreach update Nov8") || has("Source registry") && has("Partners") && has("Outreach totals Nov8")) return "index";
  if (has("Gleeday Affiliate Prospects")) return "affiliates";
  if (has("Venues")) return "coMarketing";
  if (has("Gleeday Listing Prospects")) return "listings";
  if (has("Outreach") && has("Prospects")) return "mediaPr";
  return null;
}

type Phase = "idle" | "reading" | "review" | "importing" | "done" | "error";

export function ImportClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<Partial<Record<Role, Snapshot>>>({});
  const [unknown, setUnknown] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [chunks, setChunks] = useState<ImportChunk[]>([]);
  const [progress, setProgress] = useState({ done: 0, label: "" });
  const [totals, setTotals] = useState<Record<string, { created: number; existing: number; skipped: number }>>({});
  const [error, setError] = useState<string | null>(null);

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    setPhase("reading"); setError(null);
    try {
      const next = { ...files }; const bad: string[] = [];
      for (const f of Array.from(list)) {
        const snap = await readWorkbook(new Uint8Array(await f.arrayBuffer()), f.name);
        const role = identify(snap);
        if (role) next[role] = snap; else bad.push(f.name);
      }
      setFiles(next); setUnknown(bad);
      const required: Role[] = ["affiliates", "coMarketing", "mediaPr", "listings", "index"];
      if (required.every((r) => next[r])) {
        const plan = buildPlan({ affiliates: next.affiliates!, coMarketing: next.coMarketing!, mediaPr: next.mediaPr!, listings: next.listings!, index: next.index! });
        const verification = next.verification ? applyVerification(plan, next.verification) : undefined;
        const snaps = [next.affiliates!, next.coMarketing!, next.mediaPr!, next.listings!, next.index!, ...(next.verification ? [next.verification] : [])];
        setReport(buildReport(plan, snaps.slice(0, 5), verification));
        setChunks(buildChunks(plan, snaps));
        setPhase("review");
      } else setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the files"); setPhase("error");
    }
  }

  async function runImport() {
    if (!report) return;
    setPhase("importing"); setError(null); setTotals({});
    const started = await startImport({ files: Object.values(files).map((s) => ({ name: s!.fileName, sha256: s!.fileSha256 })), chunks: chunks.length });
    if (!started.ok || !started.data) { setError(started.error ?? "Could not start"); setPhase("error"); return; }
    const batch = started.data;
    const acc: typeof totals = {};
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      setProgress({ done: i, label: c.label });
      let res = await importChunk(batch, c.kind, c.items);
      if (!res.ok) res = await importChunk(batch, c.kind, c.items);   // one retry; writes are idempotent
      if (!res.ok || !res.data) {
        setError(`${c.label}: ${res.error ?? "failed"}. Nothing is lost: run the import again to continue.`);
        await finishImport(batch, "failed", { failed_at: c.label, totals: acc });
        setPhase("error"); return;
      }
      const t = (acc[c.kind] ??= { created: 0, existing: 0, skipped: 0 });
      t.created += res.data.created; t.existing += res.data.existing; t.skipped += res.data.skipped;
      setTotals({ ...acc });
    }
    const { snapshot: _snapshot, ...summary } = report;
    void _snapshot;
    await finishImport(batch, "completed", { ...summary, totals: acc });
    setProgress({ done: chunks.length, label: "Done" });
    setPhase("done");
  }

  const roles = Object.keys(ROLE_LABEL) as Role[];
  const pct = chunks.length ? Math.round((progress.done / chunks.length) * 100) : 0;
  const LABEL: Record<string, string> = { source_rows: "Archived rows", orgs: "Organizations", contacts: "People", opps: "Opportunities",
    events: "Evidence events", finalize: "Statuses set", offers: "Offers", tasks: "Follow-up tasks" };

  return (
    <div className="stack-gap">
      <section className="card narrow">
        <h3>1. Choose the spreadsheet downloads</h3>
        <p className="muted small">Download each Google Sheet as Excel (File → Download → Microsoft Excel) and select them all here. They're read in your browser; the sheets themselves aren't changed.</p>
        <input type="file" accept=".xlsx" multiple onChange={(e) => onFiles(e.target.files)} disabled={phase === "reading" || phase === "importing"} aria-label="Spreadsheet files" />
        <ul className="plain small top-gap">
          {roles.map((r) => (
            <li key={r}>{files[r] ? "✓" : "○"} {ROLE_LABEL[r]}{files[r] ? <span className="muted"> — {files[r]!.fileName}</span> : null}</li>
          ))}
        </ul>
        {unknown.length ? <p className="flash bad small">Not recognized: {unknown.join(", ")}</p> : null}
        {phase === "reading" ? <p className="muted small">Reading files…</p> : null}
      </section>

      {report ? (
        <section className="card">
          <div className="section-head">
            <h3>2. Review</h3>
            <span className="muted small">{chunks.length} pieces to send</span>
          </div>
          <iframe title="Reconciliation report" className="report-frame" srcDoc={renderReportHtml(report)} />
        </section>
      ) : null}

      {report ? (
        <section className="card narrow">
          <h3>3. Import</h3>
          <p className="small">This adds the records to the app. Running it again is safe: nothing is duplicated, and anything changed since (by you or the bots) is kept. Your Google Sheets stay as they are. Switching over to the app as the source of truth is a separate step.</p>
          {phase === "importing" || phase === "done" ? (
            <>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${phase === "done" ? 100 : pct}%` }} /></div>
              <p className="small muted">{phase === "done" ? "Import complete." : `${progress.label} (${progress.done + 1} of ${chunks.length})`}</p>
              <table className="small">
                <tbody>
                  {Object.entries(totals).map(([k, t]) => (
                    <tr key={k}><td>{LABEL[k] ?? k}</td><td className="num">{t.created} new</td><td className="num muted">{t.existing} already there</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {phase === "review" || phase === "error" ? <button type="button" onClick={runImport}>Import into the app</button> : null}
          {phase === "done" ? <p className="flash ok">Imported. Open a pipeline to see the records.</p> : null}
        </section>
      ) : null}

      {error ? <p className="flash bad" role="alert">{error}</p> : null}
    </div>
  );
}
