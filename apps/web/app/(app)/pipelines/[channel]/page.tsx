import Link from "next/link";
import { notFound } from "next/navigation";
import { CHANNEL_KINDS, CHANNEL_LABELS, MILESTONES, STAGES, STAGE_LABELS, type ChannelKind } from "@gleeday/domain";
import { DispositionBadge, Empty, PageHeader, When } from "@/components/ui";
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
      <div className="filters">
        <form className="inline-form" action={`/pipelines/${kind}`}>
          <input type="search" name="q" placeholder="Search organization or contact" defaultValue={sp.q} />
          {showClosed ? <input type="hidden" name="show" value="all" /> : null}
          <button type="submit" className="secondary">Search</button>
        </form>
        <Link className="tab" href={`/pipelines/${kind}?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(showClosed ? {} : { show: "all" }) })}`}>
          {showClosed ? "Hide declined & bounced" : `Show declined & bounced (${closedCount})`}
        </Link>
      </div>

      {all.length === 0 ? (
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

      {inventory.length > 0 ? (
        <section>
          <details>
            <summary>
              <h2 className="inline">Not contacted yet ({inventory.length})</h2>
            </summary>
            <p className="muted small">Prospects outside the funnel. A draft or a connection request doesn't count as contact.</p>
            <ul className="list compact">
              {inventory.map((o) => (
                <li key={o.id}>
                  <Link href={`/opportunities/${o.id}`} className="list-main">
                    <strong>{o.organization_name}</strong>
                    <span className="muted">{o.primary_contact_name ?? "No contact yet"}{o.primary_contact_email ? ` · ${o.primary_contact_email}` : ""}</span>
                  </Link>
                  <span className="list-side"><DispositionBadge disposition={o.disposition} /></span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </>
  );
}
