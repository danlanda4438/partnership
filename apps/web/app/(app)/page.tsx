import Link from "next/link";
import { ChannelName, Empty, Flash, PageHeader, Pill, Stat, StageBadge, When } from "@/components/ui";
import { requireWorkspace } from "@/lib/context";
import type { ChangeItem, Daily } from "@/lib/types";

export const dynamic = "force-dynamic";

const WINDOWS: Record<string, { label: string; hours: number }> = {
  "24h": { label: "Last 24 hours", hours: 24 },
  "3d": { label: "Last 3 days", hours: 72 },
  "7d": { label: "Last 7 days", hours: 168 },
};

export default async function TodayPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const windowKey = sp.window && WINDOWS[sp.window] ? sp.window : "24h";
  const { db, workspace } = await requireWorkspace();
  const since = new Date(Date.now() - WINDOWS[windowKey].hours * 3_600_000).toISOString();
  const d = await db.call<Daily>("ui_daily", { p_workspace_id: workspace.id, p_since: since });
  const overdue = d.due.filter((x) => x.overdue).length;

  // One line per partner (newest first) instead of one line per event.
  const groupMap = new Map<string, { key: string; name: string; opportunityId: string | null; channel: string | null; items: ChangeItem[] }>();
  for (const c of d.changes) {
    const key = c.opportunity_id ?? `other-${c.id}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { key, name: c.organization_name ?? "Workspace", opportunityId: c.opportunity_id, channel: c.channel_kind, items: [] });
    }
    groupMap.get(key)!.items.push(c);
  }
  const groups = [...groupMap.values()];

  return (
    <>
      <PageHeader
        title="Today"
        subtitle="Decisions waiting for you, blocked work, and what changed. Everything else is handled by the bots."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid stats">
        <Stat label="Waiting for your approval" value={d.pending_approvals.length} href="/approvals" tone={d.pending_approvals.length ? "warn" : undefined} />
        <Stat label="Exceptions" value={d.exceptions.length} href="/exceptions" tone={d.exceptions.length ? "bad" : undefined} />
        <Stat label="Next actions due (2 days)" value={d.due.length} tone={overdue ? "warn" : undefined} />
        <Stat label="Partners with changes" value={groups.length} />
      </div>

      <section>
        <h2>Waiting for your decision</h2>
        {d.pending_approvals.length === 0 ? (
          <Empty>Nothing waiting for approval.</Empty>
        ) : (
          <ul className="list">
            {d.pending_approvals.map((a) => (
              <li key={a.id}>
                <Link href={`/approvals/${a.id}`} className="list-main">
                  <strong>{a.summary}</strong>
                  <span className="muted">
                    {a.organization_name ? `${a.organization_name} · ` : ""}
                    <ChannelName kind={a.channel_kind} /> · proposed by {a.proposed_by}
                  </span>
                </Link>
                <span className="list-side muted">
                  expires <When at={a.expires_at} relative />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Exceptions</h2>
        {d.exceptions.length === 0 ? (
          <Empty>No blocked work, failed sends or unhealthy connections.</Empty>
        ) : (
          <ul className="list">
            {d.exceptions.slice(0, 8).map((x) => (
              <li key={`${x.kind}-${x.id}`}>
                <div className="list-main">
                  {x.link ? <Link href={x.link}><strong>{x.title}</strong></Link> : <strong>{x.title}</strong>}
                  <span className="muted">{x.detail}</span>
                </div>
                <span className="list-side"><When at={x.since} relative /></span>
              </li>
            ))}
            {d.exceptions.length > 8 ? <li><Link href="/exceptions">See all {d.exceptions.length}</Link></li> : null}
          </ul>
        )}
      </section>

      <section>
        <h2>Next actions due</h2>
        {d.due.length === 0 ? (
          <Empty>No next actions due in the next two days.</Empty>
        ) : (
          <ul className="list">
            {d.due.map((x) => (
              <li key={x.id}>
                <Link href={`/opportunities/${x.id}`} className="list-main">
                  <strong>{x.organization_name}</strong>
                  <span className="muted">
                    <ChannelName kind={x.channel_kind} /> · {x.next_action ?? "No action written"}
                    {x.owner_worker_name ? ` · ${x.owner_worker_name}` : ""}
                  </span>
                </Link>
                <span className="list-side">
                  <StageBadge stage={x.stage} /> {x.overdue ? <Pill value="blocked" label="Overdue" /> : null}{" "}
                  <When at={x.next_action_due_at} relative />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>What changed</h2>
          <div className="tabs" role="tablist">
            {Object.entries(WINDOWS).map(([k, w]) => (
              <Link key={k} href={`/?window=${k}`} className={k === windowKey ? "tab active" : "tab"}>{w.label}</Link>
            ))}
          </div>
        </div>
        {groups.length === 0 ? (
          <Empty>No changes recorded in this window.</Empty>
        ) : (
          <ul className="list compact">
            {groups.map((g) => (
              <li key={g.key}>
                <div className="list-main">
                  <span>
                    {g.opportunityId ? <Link href={`/opportunities/${g.opportunityId}`}><strong>{g.name}</strong></Link> : <strong>{g.name}</strong>}
                    {g.channel ? <span className="muted"> · <ChannelName kind={g.channel} /></span> : null}
                  </span>
                  <span className="muted small">
                    {g.items.slice(0, 3).map((c) => c.summary ?? c.event_type).join(" · ")}
                    {g.items.length > 3 ? ` · +${g.items.length - 3} more` : ""}
                  </span>
                </div>
                <span className="list-side muted small"><When at={g.items[0].recorded_at} relative /></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
