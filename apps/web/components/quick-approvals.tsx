import Link from "next/link";
import { decideMany } from "@/app/(app)/approvals/actions";
import type { ApprovalListItem } from "@/lib/types";
import { ChannelName, When } from "./ui";
import { SelectAll } from "./select-all";

const ACTION_LABELS: Record<string, string> = {
  send_message: "Email", commercial_terms: "Terms", spend: "Spend", commitment: "Commitment", campaign_change: "Campaign change", other: "Other",
};

/** Pending approvals with a short preview, quick Approve/Reject per row, and bulk decisions. */
export function QuickApprovals({ items, back, canDecide }: { items: ApprovalListItem[]; back: string; canDecide: boolean }) {
  return (
    <form action={decideMany} className="quick-approvals">
      <input type="hidden" name="back" value={back} />
      {canDecide ? (
        <div className="bulk-bar">
          <SelectAll />
          <button type="submit" name="bulk" value="approve" className="small-btn">Approve selected</button>
          <button type="submit" name="bulk" value="reject" className="danger small-btn">Reject selected</button>
        </div>
      ) : null}
      <ul className="list">
        {items.map((a) => {
          const p = a.preview ?? {};
          const key = `${a.id}|${a.payload_hash}`;
          return (
            <li key={a.id} className="qa-row">
              {canDecide && a.payload_hash ? <input type="checkbox" name="pick" value={key} aria-label="Select" /> : null}
              <div className="list-main qa-main">
                <Link href={`/approvals/${a.id}`}><strong>{a.summary}</strong></Link>
                <span className="muted small">
                  {ACTION_LABELS[a.action_type] ?? a.action_type}
                  {a.organization_name ? ` · ${a.organization_name}` : ""}
                  {a.channel_kind ? <> · <ChannelName kind={a.channel_kind} /></> : null} · by {a.proposed_by} · expires <When at={a.expires_at} relative />
                </span>
                {p.to || p.subject ? (
                  <span className="small"><strong>To:</strong> {p.to ?? "—"}{p.subject ? <> · <strong>Subject:</strong> {p.subject}</> : null}{p.attachments ? ` · ${p.attachments} attachment(s)` : ""}</span>
                ) : null}
                {p.platform ? <span className="small"><strong>{p.platform}:</strong> {p.action} {p.partner ? `· ${p.partner}` : ""}</span> : null}
                {p.body ? <span className="muted small clamp">{p.body}</span> : null}
              </div>
              {canDecide && a.payload_hash ? (
                <span className="list-side qa-buttons">
                  <button type="submit" name="one" value={`approve|${key}`} className="small-btn">Approve</button>
                  <button type="submit" name="one" value={`reject|${key}`} className="danger small-btn">Reject</button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </form>
  );
}
