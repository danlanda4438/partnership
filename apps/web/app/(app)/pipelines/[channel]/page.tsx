import Link from "next/link";
import { notFound } from "next/navigation";
import { CHANNEL_KINDS, CHANNEL_LABELS, MILESTONES, STAGES, STAGE_LABELS, type ChannelKind } from "@gleeday/domain";
import { DispositionBadge, Empty, PageHeader, StageBadge, When } from "@/components/ui";
import { requireWorkspace } from "@/lib/context";
import type { PipelineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const CLOSED = new Set(["declined", "bounced"]);

function Card({ o, channel }: { o: PipelineItem; channel: ChannelKind }) {
  const milestone = o.milestone_key ? MILESTONES[channel].find((m) => m.key === o.milestone_key)?.label : null;
  const overdue = o.next_action_due_at && new Date(o.next_action_due_at) < new Date();
  return (
    <Link href={`/opportunities/${o.id}`} className="opp-card">
      <strong>{o.organization_name}</strong>
      {o.primary_contact_name ? <span className="muted small">{o.primary_contact_name}</span> : null}
      <span className="badges">
        <DispositionBadge disposition={o.disposition} />
        {milestone ? <span className="pill info">{milestone}</span> : null}
      </span>
      {o.next_action ? (
        <span className={`small ${overdue ? "overdue" : ""}`}>
          → {o.next_action}
          {o.next_action_due_at ? <> · <When at={o.next_action_due_at} /></> : null}
        </span>
      ) : null}
      <span className="muted small">{o.owner_worker_name ?? (o.owner_user_id ? "Person" : "Unassigned")}</span>
    </Link>
  );
}

export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { channel } = await params;
  if (!(CHANNEL_KINDS as readonly string[]).includes(channel)) notFound();
  const kind = channel as ChannelKind;
  const sp = await searchParams;
  const showClosed = sp.show === "all";
  const view = sp.view === "list" ? "list" : "board";
  const stageFilter = sp.stage ?? "";
  const page = Math.max(1, Number(sp.page) || 1);
  const PAGE = 100;
  const q = (sp.q ?? "").trim().toLowerCase();

  const { db, workspace } = await requireWorkspace();
  const all = await db.call<PipelineItem[]>("ui_pipeline", { p_workspace_id: workspace.id, p_channel: kind });
  const matches = (o: PipelineItem) =>
    !q || o.organization_name.toLowerCase().includes(q) || (o.primary_contact_name ?? "").toLowerCase().includes(q);
  const items = all.filter(matches);
  const funnel = items.filter((o) => o.stage && (showClosed || !CLOSED.has(o.disposition ?? "")));
  const inventory = items.filter((o) => !o.stage);
  const closedCount = items.filter((o) => o.stage && CLOSED.has(o.disposition ?? "")).length;

  return (
    <>
      <PageHeader
        title={CHANNEL_LABELS[kind]}
        subtitle={`${items.filter((o) => o.stage).length} in funnel · ${inventory.length} not yet contacted`}
      />
      <div className="tabs">
        <Link href={`/pipelines/${kind}`} className={view === "board" ? "tab active" : "tab"}>Board (contacted)</Link>
        <Link href={`/pipelines/${kind}?view=list`} className={view === "list" ? "tab active" : "tab"}>All prospects ({all.length.toLocaleString()})</Link>
      </div>
      <div className="filters">
        <form className="inline-form" action={`/pipelines/${kind}`}>
          {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
          <input type="search" name="q" placeholder="Search organization or contact" defaultValue={sp.q} />
          {view === "list" ? (
            <select name="stage" defaultValue={stageFilter} aria-label="Stage">
              <option value="">All stages</option>
              <option value="none">Not contacted</option>
              {STAGES.map((st) => <option key={st} value={st}>{STAGE_LABELS[st]}</option>)}
            </select>
          ) : null}
          {showClosed ? <input type="hidden" name="show" value="all" /> : null}
          <button type="submit" className="secondary">{view === "list" ? "Filter" : "Search"}</button>
        </form>
        {view === "board" ? (
          <Link className="tab" href={`/pipelines/${kind}?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(showClosed ? {} : { show: "all" }) })}`}>
            {showClosed ? "Hide declined & bounced" : `Show declined & bounced (${closedCount})`}
          </Link>
        ) : null}
      </div>

      {view === "list" ? (() => {
        const rows = items.filter((o) => !stageFilter || (stageFilter === "none" ? !o.stage : o.stage === stageFilter));
        const pages = Math.max(1, Math.ceil(rows.length / PAGE));
        const shown = rows.slice((page - 1) * PAGE, page * PAGE);
        const link = (n: number) => `/pipelines/${kind}?${new URLSearchParams({ view: "list", ...(sp.q ? { q: sp.q } : {}), ...(stageFilter ? { stage: stageFilter } : {}), page: String(n) })}`;
        return rows.length === 0 ? <Empty>No prospects match.</Empty> : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Prospect</th><th>Contact</th><th>Stage</th><th>Status</th><th>Next action</th><th>Last verified</th></tr></thead>
                <tbody>
                  {shown.map((o) => (
                    <tr key={o.id}>
                      <td><Link href={`/opportunities/${o.id}`}>{o.organization_name}</Link></td>
                      <td className="small">{o.primary_contact_name ?? ""}{o.primary_contact_email ? <div className="muted">{o.primary_contact_email}</div> : null}</td>
                      <td><StageBadge stage={o.stage} /></td>
                      <td><DispositionBadge disposition={o.disposition} /></td>
                      <td className="small">{o.next_action ?? <span className="muted">—</span>}</td>
                      <td className="small">{o.last_verified_at ? <When at={o.last_verified_at} /> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted top-gap">
              Showing {((page - 1) * PAGE + 1).toLocaleString()}–{Math.min(page * PAGE, rows.length).toLocaleString()} of {rows.length.toLocaleString()}
              {page > 1 ? <> · <Link href={link(page - 1)}>← Previous</Link></> : null}
              {page < pages ? <> · <Link href={link(page + 1)}>Next →</Link></> : null}
            </p>
          </>
        );
      })() : null}

      {view === "list" ? null : all.length === 0 ? (
        <Empty>
          No records yet. Spreadsheet records arrive with the migration (Phase 2); bots add new ones as they work.
        </Empty>
      ) : (
        <div className="board">
          {STAGES.map((stage) => {
            const col = funnel.filter((o) => o.stage === stage);
            return (
              <div className="column" key={stage}>
                <div className="column-head">
                  <span>{STAGE_LABELS[stage]}</span>
                  <span className="muted">{col.length}</span>
                </div>
                {col.map((o) => <Card key={o.id} o={o} channel={kind} />)}
              </div>
            );
          })}
        </div>
      )}

      {view === "board" && inventory.length > 0 ? (
        <p className="card small">
          <strong>{inventory.length.toLocaleString()}</strong> prospects in this channel haven&apos;t been contacted yet (a draft or a LinkedIn connection request doesn&apos;t count).{" "}
          <Link href={`/pipelines/${kind}?view=list&stage=none`}>See them all →</Link>
        </p>
      ) : null}
    </>
  );
}
