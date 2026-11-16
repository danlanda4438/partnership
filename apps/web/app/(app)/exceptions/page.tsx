import Link from "next/link";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { CHANNEL_KINDS, CHANNEL_LABELS } from "@gleeday/domain";
import { Empty, Flash, PageHeader, When } from "@/components/ui";
import { act, optional, str } from "@/lib/act";
import { canWrite, requireWorkspace } from "@/lib/context";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";
import type { BotItem, ExceptionItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const GROUPS: { title: string; prefix: string; help: string }[] = [
  { title: "Uncertain or failed sends", prefix: "approval_", help: "The outcome must be checked with the provider before anything is retried." },
  { title: "Blocked or failed tasks", prefix: "task_", help: "A bot stopped and needs a decision or information." },
  { title: "Records needing verification", prefix: "opportunity_", help: "Marked blocked or needs-verification." },
  { title: "Ambiguous identities", prefix: "identity_", help: "The same unverified email or profile is attached to more than one person. Nothing is merged automatically." },
  { title: "Unhealthy campaigns", prefix: "campaign_", help: "Paused or in error. This is campaign health, separate from partner progress." },
  { title: "Connection problems", prefix: "connection_", help: "Integrations that are degraded, blocked or revoked." },
];

async function closeException(form: FormData) {
  "use server";
  await act("/exceptions", "Closed. It will come back only if the same thing goes wrong again.", ({ db, workspace }) => {
    if (!workspace) throw new Error("No workspace");
    return db.call("close_exception", {
      p_workspace_id: workspace.id, p_kind: str(form, "kind"), p_item_id: str(form, "id"), p_note: optional(form, "note"),
    });
  });
  revalidatePath("/");
}

async function giveToBot(form: FormData) {
  "use server";
  // Wake the bot right after the response (best effort; page views and the daily run retry).
  after(async () => {
    if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
  });
  await act("/exceptions", "Task created. The bot is notified and will pick it up.", ({ db, workspace }) => {
    if (!workspace) throw new Error("No workspace");
    const [channel, bot] = str(form, "assignment").split(":");
    return db.call("exception_to_task", {
      p_workspace_id: workspace.id, p_kind: str(form, "kind"), p_item_id: str(form, "id"),
      p_channel: channel, p_assign_to: bot || null, p_note: optional(form, "note"),
    });
  });
  revalidatePath("/");
}

function FollowUp({ x, bots }: { x: ExceptionItem; bots: BotItem[] }) {
  // Suggest the exception's own program first; any program can still be chosen.
  const channels = [...CHANNEL_KINDS].sort((a, b) => Number(b === x.channel_kind) - Number(a === x.channel_kind));
  const first = channels[0];
  const suggested = bots.find((b) => b.channels.includes(first));
  return (
    <details className="top-gap">
      <summary className="small"><strong>Follow up</strong></summary>
      <div className="row top-gap">
        <form action={giveToBot} className="stack card" style={{ flex: 2, minWidth: 260 }}>
          <input type="hidden" name="kind" value={x.kind} />
          <input type="hidden" name="id" value={x.id} />
          <strong className="small">Give a bot a task about it</strong>
          <label>Who should do it
            <select name="assignment" required defaultValue={x.channel_kind ? `${first}:${suggested?.id ?? ""}` : ""}>
              <option value="" disabled>Choose a program and bot…</option>
              {channels.map((k) => (
                <optgroup key={k} label={CHANNEL_LABELS[k]}>
                  {bots.filter((b) => b.channels.includes(k)).map((b) => (
                    <option key={`${k}:${b.id}`} value={`${k}:${b.id}`}>{b.name} — {CHANNEL_LABELS[k]}</option>
                  ))}
                  <option value={`${k}:`}>Any {CHANNEL_LABELS[k]} bot</option>
                </optgroup>
              ))}
            </select>
          </label>
          <label>What should the bot do? (optional)
            <textarea name="note" rows={3} maxLength={2000} placeholder="e.g. Check with the partner whether the email arrived, then tell me." />
          </label>
          <span className="muted small">The bot gets the problem and your note. Emails and impact.com actions still come to you for approval.</span>
          <button type="submit">Create task</button>
        </form>
        <form action={closeException} className="stack card" style={{ flex: 1, minWidth: 200, alignSelf: "flex-start" }}>
          <input type="hidden" name="kind" value={x.kind} />
          <input type="hidden" name="id" value={x.id} />
          <strong className="small">Close it</strong>
          <label>Why (optional)
            <input name="note" maxLength={2000} placeholder="e.g. Sorted it myself" />
          </label>
          <span className="muted small">Removes it from this list. Nothing else is changed.</span>
          <button type="submit" className="secondary">Close</button>
        </form>
      </div>
    </details>
  );
}

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const [items, bots] = await Promise.all([
    db.call<ExceptionItem[]>("ui_exceptions", { p_workspace_id: workspace.id }),
    db.call<BotItem[]>("ui_bots", { p_workspace_id: workspace.id }),
  ]);
  const writer = canWrite(workspace.role);
  const activeBots = bots.filter((b) => b.status === "active");

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Everything that stopped or looks wrong. Work here is never retried automatically. Close an item, or give a bot a task about it." />
      <Flash ok={sp.ok} error={sp.error} />
      {items.length === 0 ? <Empty>No exceptions. Everything is running normally.</Empty> : null}
      {GROUPS.map((g) => {
        const group = items.filter((i) => i.kind.startsWith(g.prefix));
        if (group.length === 0) return null;
        return (
          <section key={g.prefix}>
            <h2>{g.title} <span className="muted">({group.length})</span></h2>
            <p className="muted small">{g.help}</p>
            <ul className="list">
              {group.map((x) => (
                <li key={`${x.kind}-${x.id}`} style={{ flexWrap: "wrap" }}>
                  <div className="list-main">
                    {x.link ? <Link href={x.link}><strong>{x.title}</strong></Link> : <strong>{x.title}</strong>}
                    <span className="muted">{x.detail}</span>
                    {x.followup ? (
                      <span className="small">
                        <span className="pill info">With {x.followup.worker_name ?? "a bot"}</span>
                        <Link href={`/tasks?view=board#${x.followup.task_id}`}>See the task</Link>
                        <span className="muted"> · {x.followup.task_status.replace(/_/g, " ")}</span>
                      </span>
                    ) : null}
                  </div>
                  <span className="list-side small"><When at={x.since} relative /></span>
                  {writer ? <div style={{ flexBasis: "100%" }}><FollowUp x={x} bots={activeBots} /></div> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
