// Turns a plan (+ snapshots) into ordered, size-limited chunks for the database loader
// (public.import_apply). Order matters: rows referenced by later chunks are written first.
import type { Plan } from "./normalize";
import type { Snapshot } from "./workbook";

export type ImportKind = "source_rows" | "orgs" | "contacts" | "opps" | "events" | "finalize" | "offers" | "tasks";
export interface ImportChunk { kind: ImportKind; items: unknown[]; label: string }

const MAX_BYTES = 600_000;   // keep each request well under hosting body limits

// Half an emoji (a lone UTF-16 surrogate, e.g. from cutting text short) is invalid JSON for Postgres.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const clean = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.replace(LONE_SURROGATE, "\uFFFD").replace(/\u0000/g, "") : v)));

function chunkBySize(kind: ImportKind, rawItems: unknown[], label: string): ImportChunk[] {
  const out: ImportChunk[] = [];
  let cur: unknown[] = []; let size = 2;
  for (const it of rawItems.map(clean)) {
    const n = JSON.stringify(it).length + 1;
    if (cur.length && size + n > MAX_BYTES) { out.push({ kind, items: cur, label }); cur = []; size = 2; }
    cur.push(it); size += n;
  }
  if (cur.length) out.push({ kind, items: cur, label });
  return out;
}

export function buildChunks(plan: Plan, snapshots: Snapshot[]): ImportChunk[] {
  const chunks: ImportChunk[] = [];
  for (const s of snapshots) {
    for (const t of s.tabs) {
      const rows = t.rows.map((r) => ({ file: s.fileName, tab: t.name, row: r.rowNumber, header: r.rowNumber === 2 ? t.header : undefined,
        values: r.values, formulas: r.formulas, notes: r.notes, links: r.links, checksum: r.checksum }));
      chunks.push(...chunkBySize("source_rows", rows, `Archive: ${s.fileName} › ${t.name}`));
    }
  }
  chunks.push(...chunkBySize("orgs", [...plan.orgs.values()], "Organizations"));
  chunks.push(...chunkBySize("contacts", [...plan.contacts.values()], "People"));
  // Everyone known at the organization is linked to its opportunities (distinct people stay distinct).
  const contactsByOrg = new Map<string, string[]>();
  for (const c of plan.contacts.values()) contactsByOrg.set(c.orgKey, [...(contactsByOrg.get(c.orgKey) ?? []), c.key]);
  chunks.push(...chunkBySize("opps", [...plan.opps.values()].map((o) => ({
    key: o.key, channel: o.channel, orgKey: o.orgKey, primaryContactKey: o.primaryContactKey, sources: o.sources,
    contactKeys: (contactsByOrg.get(o.orgKey) ?? []).filter((k) => k !== o.primaryContactKey).slice(0, 25),
    details: { imported: o.attributes, notes: o.notes, matched_by: [...new Set(o.matchedBy)] },
  })), "Opportunities"));
  chunks.push(...chunkBySize("events", plan.events.map((e) => ({
    key: e.key, oppKey: e.oppKey, eventType: e.eventType, at: e.time.at, precision: e.time.precision, timezone: e.time.timezone, rawTime: e.time.raw,
    summary: e.summary, source: e.source, message: e.message, assessments: e.assessments,
  })), "Evidence timeline"));
  chunks.push(...chunkBySize("finalize", [...plan.opps.values()].filter((o) => o.stage || o.disposition || o.milestone || o.nextAction || o.lastVerifiedKey).map((o) => ({
    oppKey: o.key, stage: o.stage, stageEvidenceKey: o.stageEvidenceKey, disposition: o.disposition, milestone: o.milestone,
    nextAction: o.nextAction, nextActionDue: o.nextActionDue, lastVerifiedKey: o.lastVerifiedKey ?? null, lastVerifiedAt: o.lastVerifiedAt ?? null,
  })), "Stages and statuses"));
  chunks.push(...chunkBySize("offers", plan.offers, "Offers"));
  const tasks = plan.exceptions.filter((e) => e.kind === "verification_task" || e.kind === "contact_mismatch").map((e, i) => {
    const name = e.title.replace(/: LinkedIn contact mismatch$/, "").replace(/ \((Affiliates|Co-Marketing|Media & PR|Listings)\)$/, "").toLowerCase();
    const opp = [...plan.opps.values()].find((o) => o.sources.some((s) => e.source && s.file === e.source.file && s.tab === e.source.tab && s.row === e.source.row))
      ?? [...plan.opps.values()].find((o) => plan.orgs.get(o.orgKey)?.name.toLowerCase() === name);
    return { key: `import-task:${e.kind}:${e.title}`, kind: e.kind === "contact_mismatch" ? "research.find_contact" : "verification.check",
      title: e.kind === "contact_mismatch" ? `Find the right contact: ${e.title.replace(/: LinkedIn contact mismatch$/, "")}` : `Verify: ${e.title}`,
      channel: opp?.channel ?? "co_marketing", oppKey: opp?.key ?? null, details: { reason: e.detail, from_import: true, index: i } };
  });
  chunks.push(...chunkBySize("tasks", tasks, "Follow-up tasks"));
  return chunks;
}
