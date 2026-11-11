"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { botSlug } from "@/lib/mcp/server";
import { getContext } from "@/lib/context";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";
import type { BotItem } from "@/lib/types";

/** "@affiliates", "@soled", "@co-marketing", "@media", "@listing" → that bot. */
function mentioned(body: string, bots: BotItem[]): string | null {
  for (const m of body.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) {
    const tag = m[1].toLowerCase().replace(/-/g, "");
    const hit = bots.find((b) => {
      const slug = botSlug(b.name).replace(/^gleeday-/, "").replace(/-/g, "");
      return slug === tag || slug.startsWith(tag) || botSlug(b.name).replace(/-/g, "") === tag;
    });
    if (hit) return hit.id;
  }
  return null;
}

export async function sendMessage(form: FormData) {
  const { db, workspace } = await getContext();
  if (!workspace) redirect("/no-workspace");
  const body = String(form.get("body") ?? "").trim();
  const thread = String(form.get("thread_id") ?? "") || null;
  const opportunity = String(form.get("opportunity_id") ?? "") || null;
  let target: string | null = null;
  let error: string | null = null;
  try {
    const bots = await db.call<BotItem[]>("ui_bots", { p_workspace_id: workspace.id });
    const active = bots.filter((b) => b.status === "active");
    const to = mentioned(body, active) ?? (String(form.get("to") ?? "") || null);
    target = await db.call<string>("send_bot_message", {
      p_workspace_id: workspace.id, p_to_worker_id: to, p_body: body, p_thread_id: thread, p_opportunity_id: opportunity,
    });
    // Wake the bot right after the response (best effort; page views and the daily run retry).
    after(async () => {
      if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  revalidatePath("/tasks");
  const back = target ?? thread;
  redirect(`/tasks${back ? `?thread=${back}` : "?"}${error ? `${back ? "&" : ""}error=${encodeURIComponent(error)}` : ""}`);
}
