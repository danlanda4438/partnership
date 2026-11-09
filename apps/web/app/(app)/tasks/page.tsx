import Link from "next/link";
import { revalidatePath } from "next/cache";
import { ChannelName, Empty, Flash, PageHeader, When } from "@/components/ui";
import { act, optional, str } from "@/lib/act";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { TaskItem } from "@/lib/types";

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

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const tasks = await db.call<TaskItem[]>("ui_tasks", { p_workspace_id: workspace.id });
  const admin = canAdmin(workspace.role);

  return (
    <>
      <PageHeader title="Tasks" subtitle="Work Soled has assigned to the bots. A bot claims a task, does it, and reports back with evidence." />
      <Flash ok={sp.ok} error={sp.error} />
      {tasks.length === 0 ? (
        <Empty>No tasks yet. Bots connect in Phase 4; Soled will create and assign tasks here.</Empty>
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
                    <span className="small">{t.worker ?? "Any eligible bot"} · attempt {t.attempt_count}/{t.max_attempts}</span>
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
