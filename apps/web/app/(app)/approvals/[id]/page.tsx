import Link from "next/link";
import { notFound } from "next/navigation";
import { ChannelName, Flash, PageHeader, Pill, When } from "@/components/ui";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { ApprovalDetail } from "@/lib/types";
import { decide } from "./actions";

export const dynamic = "force-dynamic";

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

function MessagePayload({ p }: { p: Record<string, unknown> }) {
  const attachments = Array.isArray(p.attachments) ? (p.attachments as Record<string, unknown>[]) : [];
  return (
    <dl className="payload">
      <dt>To</dt><dd>{asList(p.to).join(", ") || <span className="bad-text">No recipient</span>}</dd>
      {asList(p.cc).length ? <><dt>Cc</dt><dd>{asList(p.cc).join(", ")}</dd></> : null}
      {asList(p.bcc).length ? <><dt>Bcc</dt><dd>{asList(p.bcc).join(", ")}</dd></> : null}
      {p.from ? <><dt>From</dt><dd>{String(p.from)}</dd></> : null}
      <dt>Subject</dt><dd>{p.subject ? String(p.subject) : <span className="muted">(none)</span>}</dd>
      <dt>Message</dt><dd><pre className="body">{String(p.body ?? p.body_text ?? "")}</pre></dd>
      <dt>Attachments</dt>
      <dd>{attachments.length ? attachments.map((a, i) => <div key={i}>{String(a.file_name ?? a.name ?? JSON.stringify(a))}</div>) : <span className="muted">None</span>}</dd>
    </dl>
  );
}

function GenericPayload({ p }: { p: Record<string, unknown> }) {
  return (
    <dl className="payload">
      {Object.entries(p).map(([k, v]) => (
        <div key={k} className="contents">
          <dt>{k.replaceAll("_", " ")}</dt>
          <dd>{typeof v === "object" ? <pre className="body">{JSON.stringify(v, null, 2)}</pre> : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { db, workspace } = await requireWorkspace();
  const a = await db.call<ApprovalDetail | null>("ui_approval", { p_approval_id: id });
  if (!a) notFound();
  const decidable = a.status === "pending" && !a.is_expired;
  const mayDecide = canAdmin(workspace.role);

  return (
    <>
      <p className="crumbs small"><Link href="/approvals">← Approvals</Link></p>
      <PageHeader
        title={a.summary}
        subtitle={<>Proposed by {a.proposed_by} · <When at={a.created_at} />{a.organization_name ? <> · {a.organization_name} (<ChannelName kind={a.channel_kind} />)</> : null}</>}
        actions={<Pill value={a.is_expired && a.status === "pending" ? "expired" : a.status} />}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="two-col">
        <div>
          <section className="card">
            <h3>Exactly what will happen</h3>
            {a.action_type === "send_message" ? <MessagePayload p={a.payload} /> : <GenericPayload p={a.payload} />}
            <p className="muted small">Fingerprint {a.payload_hash.slice(0, 12)}… · Your decision applies only to this exact content. If anything changes, it needs a new approval.</p>
          </section>

          {a.execution_evidence ? (
            <section className="card">
              <h3>Execution evidence</h3>
              <pre className="body">{JSON.stringify(a.execution_evidence, null, 2)}</pre>
            </section>
          ) : null}
        </div>

        <aside>
          <section className="card">
            <h3>Decision</h3>
            {decidable && mayDecide ? (
              <form action={decide} className="stack">
                <input type="hidden" name="approval_id" value={a.id} />
                <input type="hidden" name="payload_hash" value={a.payload_hash} />
                <label>Note (optional)<textarea name="note" rows={3} /></label>
                <div className="row">
                  <button type="submit" name="decision" value="approve">Approve</button>
                  <button type="submit" name="decision" value="reject" className="danger">Reject</button>
                </div>
                <p className="muted small">Expires <When at={a.expires_at} relative />. Approving doesn't send anything by itself: the bot carries it out and reports back with proof.</p>
              </form>
            ) : decidable ? (
              <p className="muted">Only owners and admins can decide.</p>
            ) : (
              <p className="muted">
                {a.is_expired && a.status === "pending" ? "This approval expired without a decision." : <>Decided <When at={a.decided_at} />{a.decision_note ? ` — “${a.decision_note}”` : ""}.</>}
              </p>
            )}
          </section>

          <section className="card">
            <h3>History</h3>
            <ol className="plain">
              {a.history.map((h, i) => (
                <li key={i} className="small">
                  <When at={h.created_at} /> — {h.event_type.replaceAll("_", " ")} ({h.actor_kind}){h.note ? `: ${h.note}` : ""}
                </li>
              ))}
            </ol>
            {a.opportunity_id ? <p className="small"><Link href={`/opportunities/${a.opportunity_id}`}>Open partner record</Link></p> : null}
            {a.task_title ? <p className="small">Task: <Link href={`/tasks#${a.task_id}`}>{a.task_title}</Link></p> : null}
          </section>
        </aside>
      </div>
    </>
  );
}
