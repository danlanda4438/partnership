import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Flash, PageHeader, Pill, When } from "@/components/ui";
import { act, optional, str } from "@/lib/act";
import { canAdmin, requireWorkspace } from "@/lib/context";
import { dispatchPending } from "@/lib/dispatch";
import { buildHandover, isStale } from "@/lib/knowledge";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";
import type { BotKnowledge } from "@/lib/types";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";

async function saveKnowledge(form: FormData) {
  "use server";
  const id = str(form, "worker_id");
  await act(`/bots/${id}/knowledge`, "Knowledge file saved", ({ db }) =>
    db.call("save_bot_knowledge", { p_worker_id: id, p_body: str(form, "body"), p_change_note: optional(form, "change_note") }),
  );
}

async function askForUpdate(form: FormData) {
  "use server";
  const id = str(form, "worker_id");
  // Wake the bot right after the response (best effort; the daily run retries).
  after(async () => {
    if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
  });
  await act(`/bots/${id}/knowledge`, "The bot has a task to update its knowledge file and is notified.", ({ db }) =>
    db.call("request_knowledge_refresh", { p_worker_id: id }),
  );
}

export default async function KnowledgePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { db, workspace } = await requireWorkspace();
  const k = await db.call<BotKnowledge | null>("ui_bot_knowledge", { p_worker_id: id });
  if (!k) notFound();
  const admin = canAdmin(workspace.role);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const file = buildHandover(k, origin);
  const stale = isStale(k.current?.updated_at);
  const openRefresh = k.refresh_task && ["queued", "claimed", "awaiting_approval", "blocked"].includes(k.refresh_task.status) ? k.refresh_task : null;

  return (
    <>
      <PageHeader
        title={`${k.bot.name}: knowledge file`}
        subtitle="Everything someone needs to connect a new agent that does this bot's job, without you. The bot rewrites its part every week."
        actions={<Link href="/bots" className="link-button">← All bots</Link>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card narrow">
        <div className="section-head">
          <h3>Status</h3>
          {k.current ? <Pill value={stale ? "degraded" : "healthy"} label={stale ? "Out of date" : "Up to date"} /> : <Pill value="error" label="Not written yet" />}
        </div>
        <p className="small">
          {k.current ? <>Last updated <When at={k.current.updated_at} relative /> by {k.current.written_by}{k.current.change_note ? <> · “{k.current.change_note}”</> : null}.</> : "The bot hasn't written its knowledge file yet."}
          {" "}
          {openRefresh
            ? <>An update task is open ({openRefresh.status.replace(/_/g, " ")}, since <When at={openRefresh.created_at} relative />).</>
            : "Next automatic update: when the file is a week old (checked every day)."}
        </p>
        <div className="inline-form top-gap">
          <CopyButton text={file} />
          <a className="link-button" href={`/bots/${id}/knowledge/download`}>Download (.md)</a>
          {admin && !openRefresh && k.bot.status === "active" ? (
            <form action={askForUpdate}>
              <input type="hidden" name="worker_id" value={id} />
              <button type="submit" className="secondary">Ask the bot to update it now</button>
            </form>
          ) : null}
        </div>
        <p className="muted small top-gap">How to use it: copy or download the file, then follow section 2 (“Connect a new agent in its place”). It has no passwords or keys.</p>
      </section>

      <section className="card">
        <h3>The file</h3>
        <pre className="body">{file}</pre>
      </section>

      {admin ? (
        <details className="card">
          <summary><strong>Edit the bot's part (section 4)</strong></summary>
          <form action={saveKnowledge} className="stack top-gap">
            <input type="hidden" name="worker_id" value={id} />
            <label>Knowledge (Markdown)
              <textarea name="body" rows={18} required minLength={20} maxLength={60000} defaultValue={k.current?.body ?? ""} placeholder={k.what_to_write} />
            </label>
            <label>What changed (optional)<input name="change_note" maxLength={500} placeholder="e.g. Added the new co-marketing template" /></label>
            <p className="muted small">Saving keeps the earlier versions. Never paste passwords, tokens or API keys: the app refuses them. Say where they are kept instead.</p>
            <button type="submit">Save new version</button>
          </form>
        </details>
      ) : null}

      {k.history.length > 1 ? (
        <section>
          <h2>Earlier versions</h2>
          <ul className="list compact">
            {k.history.map((v) => (
              <li key={v.id}>
                <div className="list-main"><span>{v.change_note ?? "Updated"}</span><span className="muted small">by {v.written_by}</span></div>
                <span className="list-side small"><When at={v.updated_at} /></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
