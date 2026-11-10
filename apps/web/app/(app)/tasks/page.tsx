import Link from "next/link";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";
import { ChannelName, Empty, Flash, PageHeader, When } from "@/components/ui";
import { CHANNEL_KINDS, CHANNEL_LABELS, zonedLocalToUtc } from "@gleeday/domain";
import { act, optional, str } from "@/lib/act";
import { canAdmin, canWrite, requireWorkspace } from "@/lib/context";
import type { BotItem, TaskItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const COLUMNS: { label: string; statuses: string[] }[] = [
  { label: "Queued", statuses: ["queued"] },
  { label: "In progress", statuses: ["claimed"] },
  { label: "Awaiting approval", statuses: ["awaiting_approval"] },
  { label: "Blocked", statuses: ["blocked"] },
  { label: "Failed / gave up", statuses: ["failed", "dead_lettered"] },
  { label: "Done (14 days)", statuses: ["succeeded"] },
  { label: "Cancelled (14 days)", statuses: ["cancelled"] },
];

async function cancelTask(form: FormData) {
  "use server";
  await act("/tasks", "Task cancelled", ({ db }) =>
    db.call("cancel_task", { p_task_id: str(form, "task_id"), p_reason: optional(form, "reason") ?? "Cancelled by owner" }),
  );
  revalidatePath("/");
}

async function newTask(form: FormData) {
  "use server";
  // Wake the bot right after the response (best effort; page views and the daily run retry).
  after(async () => {
    if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
  });
  await act("/tasks", "Task created. The bot is notified and will pick it up.", ({ db, workspace }) => {
    if (!workspace) throw new Error("No workspace");
    const [channel, bot] = str(form, "assignment").split(":");
    const due = optional(form, "due_date");
    return db.call("create_task", {
      p_workspace_id: workspace.id,
      p_channel: channel,
      p_title: str(form, "title"),
      p_instructions: str(form, "instructions"),
      p_assign_to: bot || null,
      p_opportunity_id: optional(form, "opportunity_id"),
      p_due_at: due ? zonedLocalToUtc(due, "18:00") : null,
      p_priority: str(form, "urgent") === "on" ? 10 : 50,
    });
  });
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const [tasks, bots] = await Promise.all([
    db.call<TaskItem[]>("ui_tasks", { p_workspace_id: workspace.id }),
    db.call<BotItem[]>("ui_bots", { p_workspace_id: workspace.id }),
  ]);
  const admin = canAdmin(workspace.role);
  const activeBots = bots.filter((b) => b.status === "active");
  // Opened from a partner's page: the task is about that partner, in its program.
  const forChannel = CHANNEL_KINDS.find((k) => k === sp.channel);
  const channels = forChannel ? [forChannel] : CHANNEL_KINDS;

  return (
    <>
      <PageHeader title="Tasks" subtitle="Work for the bots, from Soled or from you. A bot claims a task, does it, and reports back with evidence." />
      <Flash ok={sp.ok} error={sp.error} />
      {canWrite(workspace.role) ? (
        <details className="card narrow" open={Boolean(sp.new || sp.opportunity)}>
          <summary><strong>+ New task</strong>{sp.partner ? <> about {sp.partner}</> : null}</summary>
          <form action={newTask} className="stack top-gap">
            {sp.opportunity ? <input type="hidden" name="opportunity_id" value={sp.opportunity} /> : null}
            <label>Who should do it
              <select name="assignment" required defaultValue="">
                <option value="" disabled>Choose a program and bot…</option>
                {channels.map((k) => (
                  <optgroup key={k} label={CHANNEL_LABELS[k]}>
                    {activeBots.filter((b) => b.channels.includes(k)).map((b) => (
                      <option key={`${k}:${b.id}`} value={`${k}:${b.id}`}>{b.name} — {CHANNEL_LABELS[k]}</option>
                    ))}
                    <option value={`${k}:`}>Any {CHANNEL_LABELS[k]} bot</option>
                  </optgroup>
                ))}
              </select>
            </label>
            <label>What needs doing (short title)
              <input name="title" required minLength={3} maxLength={300} placeholder="e.g. Contact these 5 podcasts about a sponsored episode" />
            </label>
            <label>Details for the bot
              <textarea name="instructions" rows={5} maxLength={4000} placeholder="Names, links, what a good result looks like. Emails and impact.com actions still come back to you for approval." />
            </label>
            <div className="row">
              <label>Due by (optional)<input type="date" name="due_date" /></label>
              <label className="check"><input type="checkbox" name="urgent" /> Urgent (do this first)</label>
            </div>
            <button type="submit">Create task</button>
          </form>
        </details>
      ) : null}
      {tasks.length === 0 ? (
        <Empty>No tasks yet. Create one above, or let Soled assign work.</Empty>
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const col = tasks.filter((t) => c.statuses.includes(t.status));
            return (
              <div className="column" key={c.label}>
                <div className="column-head"><span>{c.label}</span><span className="muted">{col.length}</span></div>
                {col.map((t) => (
                  <div className="opp-card" key={t.id} id={t.id}>
                    <strong>{t.title}</strong>
                    <span className="muted small">
                      <ChannelName kind={t.channel_kind} />
                      {t.organization_name ? <> · <Link href={`/opportunities/${t.opportunity_id}`}>{t.organization_name}</Link></> : null}
                    </span>
                    <span className="small">{t.worker ?? "Any eligible bot"} · attempt {t.attempt_count}/{t.max_attempts}{t.kind === "owner.request" ? " · from you" : ""}</span>
                    {t.blocked_reason ? <span className="small bad-text">{t.blocked_reason}</span> : null}
                    {t.status === "claimed" && t.lease_expires_at ? <span className="muted small">Lease ends <When at={t.lease_expires_at} relative /></span> : null}
                    {t.due_at ? <span className="muted small">Due <When at={t.due_at} /></span> : null}
                    {admin && !["succeeded", "cancelled", "dead_lettered"].includes(t.status) ? (
                      <form action={cancelTask}>
                        <input type="hidden" name="task_id" value={t.id} />
                        <button type="submit" className="link danger-text small">Cancel task</button>
                      </form>
                    ) : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
