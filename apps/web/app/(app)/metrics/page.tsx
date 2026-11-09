import Link from "next/link";
import { CHANNEL_KINDS, CHANNEL_LABELS, DISPOSITIONS, STAGES, STAGE_LABELS, zonedLocalToUtc } from "@gleeday/domain";
import { DISPOSITION_LABELS, PageHeader, When } from "@/components/ui";
import { requireWorkspace } from "@/lib/context";
import type { MetricsRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const SCOPES = [...CHANNEL_KINDS, "unassigned", "all"] as const;
const SCOPE_LABELS: Record<string, string> = { ...CHANNEL_LABELS, unassigned: "Unassigned", all: "All channels (de-duplicated)" };

const PERIODS: Record<string, string> = { all: "All time", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", month: "This month" };

type NumKey = { [K in keyof MetricsRow]: MetricsRow[K] extends number ? K : never }[keyof MetricsRow];

const ACTIVITY_ROWS: { key: NumKey; label: string; help: string }[] = [
  { key: "contacts_reached", label: "Unique contacts reached", help: "Distinct people with at least one accepted outbound message. Drafts and bounces do not count." },
  { key: "message_events", label: "Message events", help: "Individual messages (sent or received). One contact can have many." },
  { key: "outbound_attempts", label: "Send attempts", help: "Outbound messages that were attempted (sent, delivered, bounced, failed or uncertain)." },
  { key: "outbound_accepted", label: "Accepted by provider", help: "Sent or confirmed delivered." },
  { key: "bounced", label: "Bounced", help: "Rejected by the recipient's mail server." },
  { key: "failed", label: "Failed", help: "Known failures." },
  { key: "uncertain", label: "Uncertain outcome", help: "Unknown whether it was sent; must be reconciled before any retry." },
  { key: "drafts", label: "Drafts (not contact)", help: "Drafts never establish contact." },
  { key: "inbound_messages", label: "Inbound messages", help: "Everything received." },
  { key: "human_replies", label: "Human replies", help: "Assessed as written by a person." },
  { key: "automatic_replies", label: "Automatic responses", help: "Out-of-office and other auto-replies." },
  { key: "unassessed_replies", label: "Not yet assessed", help: "Inbound messages not yet classified as human or automatic." },
  { key: "platform_positive_labels", label: "Platform positive labels", help: "e.g. Instantly “Interested”. A label, not an agreed deal." },
  { key: "paid_only_replies", label: "Paid-only replies", help: "Positive, but only for paid placement." },
  { key: "undated_messages", label: "Undated (excluded from periods)", help: "Historical messages without a reliable date. Shown in all-time totals only." },
];

function periodRange(period: string, from?: string, to?: string): { from: string | null; to: string | null } {
  const now = Date.now();
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
  switch (period) {
    case "7d": return { from: days(7), to: null };
    case "30d": return { from: days(30), to: null };
    case "90d": return { from: days(90), to: null };
    case "month": {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
      return { from: zonedLocalToUtc(`${today.slice(0, 8)}01`), to: null };
    }
    case "custom": {
      const end = to ? zonedLocalToUtc(to) : null;
      return { from: from ? zonedLocalToUtc(from) : null, to: end ? new Date(new Date(end).getTime() + 86_400_000).toISOString() : null };
    }
    default: return { from: null, to: null };
  }
}

export default async function MetricsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const period = sp.period && (PERIODS[sp.period] || sp.period === "custom") ? sp.period : "all";
  const range = periodRange(period, sp.from, sp.to);
  const { db, workspace } = await requireWorkspace();
  const raw = await db.rows<MetricsRow>("workspace_metrics", { p_workspace_id: workspace.id, p_from: range.from, p_to: range.to });
  const rows = Object.fromEntries(raw.map((r) => [r.scope, r])) as Record<string, MetricsRow>;
  const n = (scope: string, key: NumKey) => Number(rows[scope]?.[key] ?? 0);

  return (
    <>
      <PageHeader
        title="Metrics"
        subtitle="Contacts, organizations, opportunities and messages are counted separately and never added together."
      />

      <div className="filters">
        <div className="tabs">
          {Object.entries(PERIODS).map(([k, label]) => (
            <Link key={k} href={`/metrics?period=${k}`} className={k === period ? "tab active" : "tab"}>{label}</Link>
          ))}
        </div>
        <form className="inline-form" action="/metrics">
          <input type="hidden" name="period" value="custom" />
          <label>From <input type="date" name="from" defaultValue={sp.from} /></label>
          <label>To <input type="date" name="to" defaultValue={sp.to} /></label>
          <button type="submit" className="secondary">Apply</button>
        </form>
      </div>

      <section>
        <h2>Pipeline (current state)</h2>
        <p className="muted small">Stages are where each opportunity stands now, so they don't change with the period. One organization can have opportunities in several channels.</p>
        <div className="table-wrap">
          <table className="metrics">
            <thead>
              <tr><th>Measure</th>{SCOPES.filter((s) => s !== "unassigned").map((s) => <th key={s} className="num">{SCOPE_LABELS[s]}</th>)}</tr>
            </thead>
            <tbody>
              <tr className="em"><td>Opportunities in funnel</td>{SCOPES.filter((s) => s !== "unassigned").map((s) => <td key={s} className="num">{n(s, "opportunities")}</td>)}</tr>
              <tr className="em"><td>Organizations engaged</td>{SCOPES.filter((s) => s !== "unassigned").map((s) => <td key={s} className="num">{n(s, "organizations_engaged")}</td>)}</tr>
              {STAGES.map((st) => (
                <tr key={st}><td className="indent">{STAGE_LABELS[st]}</td>{SCOPES.filter((s) => s !== "unassigned").map((s) => <td key={s} className="num">{Number(rows[s]?.by_stage?.[st] ?? 0)}</td>)}</tr>
              ))}
              <tr><td>Not contacted (inventory, outside funnel)</td>{SCOPES.filter((s) => s !== "unassigned").map((s) => <td key={s} className="num">{n(s, "inventory")}</td>)}</tr>
              {DISPOSITIONS.map((dp) => (
                <tr key={dp}><td className="indent muted">{DISPOSITION_LABELS[dp]}</td>{SCOPES.filter((s) => s !== "unassigned").map((s) => <td key={s} className="num">{Number(rows[s]?.by_disposition?.[dp] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Outreach activity — {period === "custom" ? `${sp.from ?? "…"} to ${sp.to ?? "…"}` : PERIODS[period]}</h2>
        <div className="table-wrap">
          <table className="metrics">
            <thead>
              <tr><th>Measure</th>{SCOPES.map((s) => <th key={s} className="num">{SCOPE_LABELS[s]}</th>)}</tr>
            </thead>
            <tbody>
              {ACTIVITY_ROWS.map((r) => (
                <tr key={r.key}>
                  <td><span title={r.help}>{r.label}</span><div className="muted small">{r.help}</div></td>
                  {SCOPES.map((s) => <td key={s} className="num">{n(s, r.key)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Evidence freshness</h2>
        <div className="table-wrap">
          <table className="metrics">
            <thead>
              <tr><th>Measure</th>{SCOPES.filter((s) => s !== "unassigned").map((s) => <th key={s} className="num">{SCOPE_LABELS[s]}</th>)}</tr>
            </thead>
            <tbody>
              <tr>
                <td>Active opportunities verified in last 30 days<div className="muted small">Verified ÷ active (in funnel, not live, not declined or bounced)</div></td>
                {SCOPES.filter((s) => s !== "unassigned").map((s) => (
                  <td key={s} className="num">{n(s, "verified_last_30_days")} of {n(s, "active_opportunities")}</td>
                ))}
              </tr>
              <tr>
                <td>Most recent evidence recorded</td>
                {SCOPES.filter((s) => s !== "unassigned").map((s) => (
                  <td key={s} className="num">{rows[s]?.last_evidence_at ? <When at={rows[s].last_evidence_at} /> : <span className="muted">None</span>}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
