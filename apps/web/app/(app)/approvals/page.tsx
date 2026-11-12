import Link from "next/link";
import { ChannelName, Empty, Flash, PageHeader, Pill, When } from "@/components/ui";
import { QuickApprovals } from "@/components/quick-approvals";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { ApprovalListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  send_message: "Send message",
  commercial_terms: "Commercial terms",
  spend: "Spend",
  commitment: "Commitment",
  campaign_change: "Campaign change",
  other: "Other",
};

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const view = sp.view === "recent" ? "recent" : "pending";
  const { db, workspace } = await requireWorkspace();
  const items = await db.call<ApprovalListItem[]>("ui_approvals", {
    p_workspace_id: workspace.id,
    p_status: view === "pending" ? "pending" : null,
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Every outgoing message, commercial term, spend or commitment waits here. You approve the exact content; any change needs a new approval."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="tabs">
        <Link href="/approvals" className={view === "pending" ? "tab active" : "tab"}>Waiting for you</Link>
        <Link href="/approvals?view=recent" className={view === "recent" ? "tab active" : "tab"}>Last 30 days</Link>
      </div>
      {items.length === 0 ? (
        <Empty>{view === "pending" ? "Nothing is waiting for your approval." : "No approvals in the last 30 days."}</Empty>
      ) : view === "pending" ? (
        <QuickApprovals items={items} back="/approvals" canDecide={canAdmin(workspace.role)} />
      ) : (
        <ul className="list">
          {items.map((a) => (
            <li key={a.id}>
              <Link href={`/approvals/${a.id}`} className="list-main">
                <strong>{a.summary}</strong>
                <span className="muted">
                  {ACTION_LABELS[a.action_type] ?? a.action_type}
                  {a.organization_name ? ` · ${a.organization_name}` : ""} · <ChannelName kind={a.channel_kind} /> · by {a.proposed_by}
                </span>
              </Link>
              <span className="list-side">
                <Pill value={a.status} />{" "}
                {a.status === "pending" ? <span className="muted small">expires <When at={a.expires_at} relative /></span> : <span className="muted small"><When at={a.decided_at ?? a.created_at} /></span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
