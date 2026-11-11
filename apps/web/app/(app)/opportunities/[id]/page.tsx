import Link from "next/link";
import { notFound } from "next/navigation";
import { CHANNEL_LABELS, DISPOSITIONS, STAGES, STAGE_LABELS, type ChannelKind } from "@gleeday/domain";
import {
  ChannelName, DISPOSITION_LABELS, DispositionBadge, Empty, Flash, PageHeader, Pill, StageBadge, When,
} from "@/components/ui";
import { canWrite, requireWorkspace } from "@/lib/context";
import type { MemberItem, OpportunityDetail, TimelineItem } from "@/lib/types";
import { recordActivity, setPlan, setStage, setStatus } from "./actions";

export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  "note.added": "Note",
  "manual.email_sent": "Email sent (recorded manually)",
  "manual.linkedin_message_sent": "LinkedIn message sent",
  "manual.facebook_message_sent": "Facebook message sent",
  "manual.call": "Call",
  "manual.meeting": "Meeting",
  "manual.reply_received": "Reply received",
  "manual.submission": "Submission",
  "manual.verification": "Verification check",
  "manual.agreement": "Agreement",
  "manual.live_confirmed": "Confirmed live",
  "opportunity.stage_changed": "Stage changed",
  "opportunity.disposition_changed": "Disposition changed",
  "opportunity.milestone_changed": "Milestone changed",
  "message.outbound": "Message sent",
  "message.inbound": "Message received",
  "message.sent": "Email sent",
  "contact_form.submitted": "Contact form submitted",
  "linkedin.message_sent": "LinkedIn message sent",
  "facebook.message_sent": "Facebook message sent",
  "verification.checked": "Verification",
  "placement.live": "Confirmed live",
  "prospect.added": "Prospect added",
  "message.received": "Reply received",
  "import.historical_send": "Historical outreach (from spreadsheet)",
  "listing.submitted": "Listing submitted",
  "impact.partner_applied": "impact.com: partner applied",
  "impact.proposal_sent": "impact.com: proposal sent",
  "impact.partner_joined": "impact.com: partner joined",
  "impact.partner_declined": "impact.com: declined",
  "impact.terms_changed": "impact.com: terms changed",
  "impact.performance": "impact.com: performance",
};

const eventLabel = (t: string) =>
  EVENT_LABELS[t] ?? t.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const MANUAL_TYPES = [
  "manual.email_sent", "manual.linkedin_message_sent", "manual.facebook_message_sent", "manual.reply_received",
  "manual.call", "manual.meeting", "manual.submission", "manual.agreement", "manual.live_confirmed",
  "manual.verification", "note.added",
];

function jerusalemDate(iso: string | null): string {
  return iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(iso)) : "";
}

function TimelineEntry({ t }: { t: TimelineItem }) {
  const m = t.message;
  return (
    <li className="tl-item">
      <div className="tl-head">
        <strong>{eventLabel(t.event_type)}</strong>
        <span className="muted small">
          <When at={t.occurred_at} precision={t.precision} /> · {t.actor_worker ?? t.actor_kind ?? t.source}
          {t.occurred_at === null ? <> · recorded <When at={t.recorded_at} /></> : null}
        </span>
      </div>
      {t.summary && t.summary !== m?.subject ? <p className="tl-summary">{t.summary}</p> : null}
      {m ? (
        <div className="message">
          <div className="small">
            <Pill
              value={m.status === "received" ? "configured" : m.status === "sent" || m.status === "delivered" ? "healthy" : m.status}
              label={m.direction === "inbound" ? "← Received" : m.status === "sent" ? "→ Sent" : `→ ${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`}
            />{" "}
            {m.is_automatic === true ? <span className="pill muted">Automatic reply</span> : null}
            {m.is_automatic === false ? <span className="pill info">Human reply</span> : null}
            {(m.assessments ?? []).map((a, i) => (
              <span key={i} className="pill muted" title={`${a.source} assessment`}>
                {a.platform_label ? `Platform label: ${a.platform_label}` : a.classification}
                {a.conditions ? ` (${a.conditions})` : ""}
              </span>
            ))}
          </div>
          <div className="small muted">
            {m.from ? <>From {m.from}</> : null}
            {m.to?.length ? <> · To {m.to.join(", ")}</> : null}
            {m.provider_message_id ? <> · {m.provider} id {m.provider_message_id}</> : null}
          </div>
          {m.subject ? <div><strong>{m.subject}</strong></div> : null}
          {m.body_text ? (
            <details>
              <summary className="small">Show message</summary>
              <pre className="body">{m.body_text}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {t.provenance ? (
        <div className="small muted">
          Source: {t.provenance.url ? <a href={t.provenance.url} target="_blank" rel="noreferrer">{t.provenance.file}</a> : t.provenance.file}
          {" › "}{t.provenance.tab}, row {t.provenance.row}
        </div>
      ) : null}
    </li>
  );
}

export default async function OpportunityPage({
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
  const [d, members] = await Promise.all([
    db.call<OpportunityDetail | null>("ui_opportunity", { p_opportunity_id: id }),
    db.call<MemberItem[]>("ui_members", { p_workspace_id: workspace.id }),
  ]);
  if (!d) notFound();
  const o = d.opportunity;
  const kind = o.channel_kind as ChannelKind;
  const writable = canWrite(workspace.role);
  const evidenceCandidates = d.timeline.filter((t) => t.kind === "event" && !t.event_type.startsWith("opportunity."));
  const ownerValue = o.owner_user_id ? `user:${o.owner_user_id}` : o.owner_worker_id ? `worker:${o.owner_worker_id}` : "";
  const milestoneLabel = d.milestones.find((m) => m.key === o.milestone_key)?.label;

  return (
    <>
      <p className="crumbs small"><Link href={`/pipelines/${kind}`}>← {CHANNEL_LABELS[kind]}</Link></p>
      <PageHeader
        title={d.organization.name}
        subtitle={
          <>
            {CHANNEL_LABELS[kind]}
            {d.organization.location_label ? ` · ${d.organization.location_label}` : ""}
            {d.organization.parent ? ` · part of ${d.organization.parent.name}` : ""}
          </>
        }
        actions={<span className="badges"><StageBadge stage={o.stage} /><DispositionBadge disposition={o.disposition} />{milestoneLabel ? <span className="pill info">{milestoneLabel}</span> : null}{writable ? <Link className="link-button" href={`/tasks?opportunity=${o.id}&channel=${kind}&partner=${encodeURIComponent(d.organization.name)}`}>Message a bot</Link> : null}</span>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="facts card">
        <div><span className="fact-label">Next action</span>{o.next_action ?? <span className="muted">None</span>}</div>
        <div><span className="fact-label">Due</span>{o.next_action_due_at ? <When at={o.next_action_due_at} relative /> : <span className="muted">—</span>}</div>
        <div><span className="fact-label">Owner</span>{o.owner_worker_name ?? members.find((m) => m.user_id === o.owner_user_id)?.email ?? <span className="muted">Unassigned</span>}</div>
        <div><span className="fact-label">Last verified</span>{o.last_verified_at ? <When at={o.last_verified_at} relative /> : <span className="muted">Never</span>}</div>
        <div><span className="fact-label">Website</span>{d.organization.website ? <a href={d.organization.website} target="_blank" rel="noreferrer">{d.organization.website}</a> : <span className="muted">—</span>}</div>
        <div><span className="fact-label">Other channels</span>
          {d.sibling_opportunities.length ? d.sibling_opportunities.map((s) => (
            <Link key={s.id} href={`/opportunities/${s.id}`} className="sibling"><ChannelName kind={s.channel_kind} /> <StageBadge stage={s.stage} /></Link>
          )) : <span className="muted">None</span>}
        </div>
      </div>

      <div className="two-col">
        <div>
          <section>
            <h2>Evidence timeline</h2>
            {d.timeline.length === 0 ? <Empty>No activity recorded yet.</Empty> : (
              <ol className="timeline">{d.timeline.map((t) => <TimelineEntry key={`${t.kind}-${t.id}`} t={t} />)}</ol>
            )}
          </section>
        </div>

        <aside>
          {writable ? (
            <>
              <section className="card">
                <h3>Plan</h3>
                <form action={setPlan} className="stack">
                  <input type="hidden" name="opportunity_id" value={o.id} />
                  <label>Next action<input name="next_action" defaultValue={o.next_action ?? ""} placeholder="e.g. Send revised terms" /></label>
                  <div className="row">
                    <label>Due date<input type="date" name="due_date" defaultValue={jerusalemDate(o.next_action_due_at)} /></label>
                    <label>Time<input type="time" name="due_time" defaultValue="09:00" /></label>
                  </div>
                  <label>Owner
                    <select name="owner" defaultValue={ownerValue}>
                      <option value="">Unassigned</option>
                      <optgroup label="People">
                        {members.filter((m) => m.status === "active").map((m) => <option key={m.user_id} value={`user:${m.user_id}`}>{m.email}</option>)}
                      </optgroup>
                      {d.workers.length ? (
                        <optgroup label="Bots">
                          {d.workers.map((w) => <option key={w.id} value={`worker:${w.id}`}>{w.name}</option>)}
                        </optgroup>
                      ) : null}
                    </select>
                  </label>
                  <button type="submit">Save plan</button>
                </form>
              </section>

              <section className="card">
                <h3>Record activity</h3>
                <p className="muted small">For things done outside the app, such as a LinkedIn message, a call or a submission. Drafts are not recorded as contact.</p>
                <form action={recordActivity} className="stack">
                  <input type="hidden" name="opportunity_id" value={o.id} />
                  <label>Type
                    <select name="event_type" defaultValue="note.added">
                      {MANUAL_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
                    </select>
                  </label>
                  <label>What happened<textarea name="summary" required rows={3} /></label>
                  <div className="row">
                    <label>Date<input type="date" name="date" /></label>
                    <label>Time (optional)<input type="time" name="time" /></label>
                  </div>
                  <p className="muted small">Leave the date empty if you don't know it. The app won't make one up.</p>
                  <button type="submit">Record</button>
                </form>
              </section>

              <section className="card">
                <h3>Stage</h3>
                <p className="muted small">Each stage needs evidence: choose the timeline entry that shows it.</p>
                <form action={setStage} className="stack">
                  <input type="hidden" name="opportunity_id" value={o.id} />
                  <label>Stage
                    <select name="stage" defaultValue={o.stage ?? ""}>
                      <option value="">Not contacted</option>
                      {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                  </label>
                  <label>Evidence
                    <select name="evidence_event_id" defaultValue={d.stage_evidence_event_id ?? ""}>
                      <option value="">— choose a timeline entry —</option>
                      {evidenceCandidates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {eventLabel(t.event_type)}: {(t.summary ?? "").slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit">Update stage</button>
                </form>
              </section>

              <section className="card">
                <h3>Disposition & milestone</h3>
                <form action={setStatus} className="stack">
                  <input type="hidden" name="opportunity_id" value={o.id} />
                  <label>Disposition
                    <select name="disposition" defaultValue={o.disposition ?? ""}>
                      <option value="">None</option>
                      {DISPOSITIONS.map((x) => <option key={x} value={x}>{DISPOSITION_LABELS[x]}</option>)}
                    </select>
                  </label>
                  <label>Milestone
                    <select name="milestone_key" defaultValue={o.milestone_key ?? ""}>
                      <option value="">None</option>
                      {d.milestones.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </label>
                  <button type="submit">Save</button>
                </form>
              </section>
            </>
          ) : (
            <p className="notice small">You have view-only access.</p>
          )}

          <section className="card">
            <h3>People</h3>
            {d.contacts.length === 0 ? <Empty>No contacts linked.</Empty> : (
              <ul className="plain">
                {d.contacts.map((c) => (
                  <li key={c.id}>
                    <strong>{c.full_name ?? "Unnamed contact"}</strong>{c.is_primary ? <span className="pill info">Primary</span> : null}
                    {c.job_title ? <div className="muted small">{c.job_title}</div> : null}
                    {c.identities.map((i) => (
                      <div key={`${i.kind}-${i.value}`} className="small">
                        {i.kind}: {i.value} {i.is_verified ? <span className="pill ok">verified</span> : <span className="pill warn">unverified</span>}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {d.organization.aliases.length ? (
              <div className="small muted">Also known as: {d.organization.aliases.map((a) => `${a.alias} (${a.justification})`).join("; ")}</div>
            ) : null}
          </section>

          <section className="card">
            <h3>Offers</h3>
            {d.offers.length === 0 ? <Empty>No offers.</Empty> : (
              <ul className="plain">
                {d.offers.map((f) => (
                  <li key={f.id}>
                    <strong>{f.kind.replaceAll("_", " ")}</strong> <Pill value={f.status === "accepted" ? "healthy" : f.status === "proposed" ? "pending" : "unknown"} label={f.status} />
                    {f.is_paid ? <span className="pill warn">Paid</span> : null}
                    {f.io_signed ? <span className="pill ok">IO signed</span> : f.kind === "paid_placement" ? <span className="pill muted">IO not signed</span> : null}
                    <div className="small">{f.terms}</div>
                    {f.amount ? <div className="small">{f.amount} {f.currency}{f.status === "proposed" ? " (proposed, not approved spend)" : ""}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h3>Attachments</h3>
            {d.attachments.length === 0 ? <Empty>No attachments.</Empty> : (
              <ul className="plain">
                {d.attachments.map((a) => (
                  <li key={a.id}><a href={`/attachments?path=${encodeURIComponent(a.storage_path)}`}>{a.file_name}</a> <span className="muted small"><When at={a.created_at} /></span></li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h3>Tasks & approvals</h3>
            {d.tasks.length === 0 && d.approvals.length === 0 ? <Empty>None.</Empty> : null}
            <ul className="plain">
              {d.tasks.map((t) => (
                <li key={t.id}><Link href={`/tasks#${t.id}`}>{t.title}</Link> <Pill value={t.status} />{t.worker ? <span className="muted small"> · {t.worker}</span> : null}</li>
              ))}
              {d.approvals.map((a) => (
                <li key={a.id}><Link href={`/approvals/${a.id}`}>{a.summary}</Link> <Pill value={a.status} /></li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
