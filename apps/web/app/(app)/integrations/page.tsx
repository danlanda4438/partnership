import { ChannelName, Empty, PageHeader, Pill, When } from "@/components/ui";
import { requireWorkspace } from "@/lib/context";
import type { Integrations } from "@/lib/types";

export const dynamic = "force-dynamic";

// What the brief requires. Shown as "not configured" until a real, verified connection exists.
const EXPECTED = [
  { provider: "google_sheets", label: "Google Sheets", note: "Read-only source for the one-time migration (Phase 2)." },
  { provider: "instantly", label: "Instantly", note: "Campaign events and labels (Phase 5). No automatic campaign launch or resume." },
  { provider: "gmail", label: "Gmail", note: "Bots send through their existing access after approval and report message IDs (Phase 4–5)." },
  { provider: "routine_webhook", label: "Bot routines", note: "Webhook triggers that notify bots of work (Phase 4)." },
  { provider: "command_center", label: "Command Center", note: "Separate system. Connects only through an agreed contract (Phase 6)." },
];

// Company-owned sources named in the brief (shown until the registry is imported).
const KNOWN_SOURCES = [
  { title: "Affiliates", tabs: "Gleeday Affiliate Prospects", url: "https://docs.google.com/spreadsheets/d/1Lwpn3GCAFsieczIvJ_HC4VrhuO-vwusqjV-eBRreWVw/edit" },
  { title: "Co-Marketing", tabs: "Venues · Platforms & integrations · Products & tech", url: "https://docs.google.com/spreadsheets/d/1ZjCO-gX1_VTOJ7M2WYIWvhNfyleU2YDLNcrgIw9k3uM/edit" },
  { title: "Media & PR", tabs: "Outreach + supporting tabs", url: "https://docs.google.com/spreadsheets/d/1tvoWy9r2H5jO7lIzkmmAOsCZSCNMj-rmkeP5SS5U_ZY/edit" },
  { title: "Listings", tabs: "Gleeday Listing Prospects · Paid options", url: "https://docs.google.com/spreadsheets/d/1TRbIhsv8KKaoKWrcdZP_PhUTcKRvx59mBU0-jYyPQCs/edit" },
  { title: "Partnerships index / source registry", tabs: "Registry of all Gleeday workbooks", url: "https://docs.google.com/spreadsheets/d/1nIEaRyVMjgSMK_auvvp1b6uBNHFDReEXfhAV9Jbx0P0/edit" },
];

export default async function IntegrationsPage() {
  const { db, workspace } = await requireWorkspace();
  const d = await db.call<Integrations>("ui_integrations", { p_workspace_id: workspace.id });

  return (
    <>
      <PageHeader title="Integrations & sources" subtitle="Connection health and where every record came from. A connection shows as healthy only after a real, verified check." />

      <section>
        <h2>Connections</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Connection</th><th>Status</th><th>Account</th><th>Last check</th><th>Notes</th></tr></thead>
            <tbody>
              {EXPECTED.map((e) => {
                const c = d.connections.find((x) => x.provider === e.provider);
                return (
                  <tr key={e.provider}>
                    <td>{c?.display_name ?? e.label}</td>
                    <td><Pill value={c?.status ?? "not_configured"} /></td>
                    <td>{c?.account_identity ?? <span className="muted">—</span>}</td>
                    <td>{c?.last_checked_at ? <When at={c.last_checked_at} relative /> : <span className="muted">Never</span>}</td>
                    <td className="small">{c?.blocked_reason ?? c?.last_error ?? <span className="muted">{e.note}</span>}</td>
                  </tr>
                );
              })}
              {d.connections.filter((c) => !EXPECTED.some((e) => e.provider === c.provider)).map((c) => (
                <tr key={c.id}>
                  <td>{c.display_name}</td><td><Pill value={c.status} /></td><td>{c.account_identity ?? "—"}</td>
                  <td>{c.last_checked_at ? <When at={c.last_checked_at} relative /> : "Never"}</td><td className="small">{c.blocked_reason ?? c.last_error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Campaign health</h2>
        {d.campaigns.length === 0 ? <Empty>No campaigns synced yet (Instantly connects in Phase 5).</Empty> : (
          <ul className="list compact">
            {d.campaigns.map((c) => (
              <li key={c.id}>
                <div className="list-main"><strong>{c.name}</strong><span className="muted">{c.provider} · <ChannelName kind={c.channel_kind} />{c.health_note ? ` · ${c.health_note}` : ""}</span></div>
                <span className="list-side"><Pill value={c.status} /> {c.status_checked_at ? <span className="muted small"><When at={c.status_checked_at} relative /></span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Source registry</h2>
        {d.source_files.length === 0 ? (
          <>
            <p className="muted small">Nothing imported yet. These company-owned sources will be snapshotted read-only in Phase 2; the sheets themselves are never changed.</p>
            <ul className="list compact">
              {KNOWN_SOURCES.map((s) => (
                <li key={s.url}>
                  <div className="list-main"><a href={s.url} target="_blank" rel="noreferrer"><strong>{s.title}</strong></a><span className="muted">{s.tabs}</span></div>
                  <span className="list-side"><Pill value="not_configured" label="Not imported" /></span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Source</th><th>Channel</th><th className="num">Tabs</th><th className="num">Rows captured</th><th>Last snapshot</th><th>Status</th></tr></thead>
              <tbody>
                {d.source_files.map((f) => (
                  <tr key={f.id}>
                    <td>{f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.title}</a> : f.title}</td>
                    <td><ChannelName kind={f.channel_kind} /></td>
                    <td className="num">{f.tabs}</td>
                    <td className="num">{f.rows_captured}</td>
                    <td>{f.last_captured_at ? <When at={f.last_captured_at} /> : <span className="muted">—</span>}</td>
                    <td>{f.is_included ? <Pill value="configured" label="Included" /> : <span className="muted small">Excluded: {f.exclusion_reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {d.import_batches.length ? (
        <section>
          <h2>Import runs</h2>
          <ul className="list compact">
            {d.import_batches.map((b) => (
              <li key={b.id}>
                <div className="list-main"><strong>{b.kind.replaceAll("_", " ")}</strong><span className="muted small">{Object.entries(b.stats ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span></div>
                <span className="list-side"><Pill value={b.status === "completed" || b.status === "approved" ? "healthy" : b.status === "failed" ? "error" : "unknown"} label={b.status} /> <span className="muted small"><When at={b.started_at} /></span></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
