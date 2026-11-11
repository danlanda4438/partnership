import Link from "next/link";
import { Empty, Pill, When } from "@/components/ui";
import type { Db } from "@/lib/data";
import type { BotItem } from "@/lib/types";
import { sendMessage } from "./actions";
import { AutoRefresh } from "./auto-refresh";

interface ThreadItem {
  thread_id: string; first_text: string; to: string | null; partner: string | null;
  last_at: string; last_text: string; last_from: string; messages: number; waiting_for_bot: boolean;
}
interface Thread {
  thread_id: string;
  partner: { id: string; name: string } | null;
  last_bot: string | null;
  messages: { id: string; at: string; text: string; from_bot: string | null; to_bot: string | null; task_status: string | null; task_reason: string | null }[];
  tasks: { id: string; title: string; status: string; bot: string | null; blocked_reason: string | null }[];
  approvals: { id: string; summary: string; status: string }[];
}

const STATUS: Record<string, string> = {
  queued: "delivered, waiting for the bot", claimed: "bot is working on it", awaiting_approval: "waiting for your approval",
  succeeded: "done", blocked: "bot is stuck", failed: "failed", dead_lettered: "bot gave up", cancelled: "cancelled",
};

export async function Messages({ db, workspaceId, bots, threadId, opportunity, partner, canSend }: {
  db: Db; workspaceId: string; bots: BotItem[]; threadId?: string; opportunity?: string; partner?: string; canSend: boolean;
}) {
  const active = bots.filter((b) => b.status === "active");
  const soled = active.find((b) => b.role === "coordinator");
  const [threads, thread] = await Promise.all([
    db.call<ThreadItem[]>("ui_conversations", { p_workspace_id: workspaceId }),
    threadId ? db.call<Thread>("ui_conversation", { p_workspace_id: workspaceId, p_thread_id: threadId }) : Promise.resolve(null),
  ]);
  const defaultBot = thread?.last_bot ?? soled?.id ?? "";

  const composer = canSend ? (
    <form action={sendMessage} className="stack composer">
      {thread ? <input type="hidden" name="thread_id" value={thread.thread_id} /> : null}
      {!thread && opportunity ? <input type="hidden" name="opportunity_id" value={opportunity} /> : null}
      <textarea name="body" required rows={3} maxLength={8000}
        placeholder={thread ? "Reply… (tag another bot with @, e.g. @listing)" : "Write to a bot… e.g. “@affiliates follow up with everyone who replied last week”. No tag = Soled."} />
      <div className="row composer-row">
        <label className="inline">To
          <select name="to" defaultValue={defaultBot}>
            {active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <span className="muted small">An @tag in the text wins over this choice.</span>
        <button type="submit">Send</button>
      </div>
    </form>
  ) : null;

  return (
    <div className="messages">
      <aside className="threads">
        <Link href="/tasks" className={`thread-link new ${!thread ? "active" : ""}`}>+ New conversation</Link>
        {threads.length === 0 ? <p className="muted small">No conversations yet.</p> : threads.map((t) => (
          <Link key={t.thread_id} href={`/tasks?thread=${t.thread_id}`} className={`thread-link ${t.thread_id === thread?.thread_id ? "active" : ""}`}>
            <strong>{t.to ?? "Bot"}{t.partner ? ` · ${t.partner}` : ""}</strong>
            <span className="small clamp">{t.last_from}: {t.last_text}</span>
            <span className="muted small"><When at={t.last_at} relative />{t.waiting_for_bot ? " · waiting for bot" : ""}</span>
          </Link>
        ))}
      </aside>

      <section className="thread">
        {!thread ? (
          <>
            <h3>New conversation{partner ? <> about {partner}</> : null}</h3>
            <p className="muted small">The app delivers your message to the bot and wakes it. Its answer appears here. Anything it wants to send to a partner still comes to Approvals first.</p>
            {composer}
          </>
        ) : (
          <>
            <AutoRefresh seconds={10} />
            {thread.partner ? <p className="small">About <Link href={`/opportunities/${thread.partner.id}`}>{thread.partner.name}</Link></p> : null}
            <ol className="bubbles">
              {thread.messages.map((m) => (
                <li key={m.id} className={m.from_bot ? "bubble bot" : "bubble me"}>
                  <div className="bubble-head small">
                    <strong>{m.from_bot ?? "You"}</strong>{m.to_bot ? <> → {m.to_bot}</> : null} · <When at={m.at} relative />
                  </div>
                  <div className="bubble-text">{m.text}</div>
                  {m.task_status ? (
                    <div className="muted small">{STATUS[m.task_status] ?? m.task_status}{m.task_reason ? `: ${m.task_reason}` : ""}</div>
                  ) : null}
                </li>
              ))}
            </ol>
            {thread.tasks.length || thread.approvals.length ? (
              <div className="card small">
                {thread.tasks.map((t) => (
                  <div key={t.id}>Task: {t.title} · {t.bot ?? "any bot"} · <Pill value={t.status} label={STATUS[t.status] ?? t.status} />{t.blocked_reason ? ` · ${t.blocked_reason}` : ""}</div>
                ))}
                {thread.approvals.map((a) => (
                  <div key={a.id}>Approval: <Link href={`/approvals/${a.id}`}>{a.summary}</Link> · <Pill value={a.status} /></div>
                ))}
              </div>
            ) : null}
            {composer}
          </>
        )}
      </section>
      {threads.length === 0 && !thread && !canSend ? <Empty>No conversations yet.</Empty> : null}
    </div>
  );
}
