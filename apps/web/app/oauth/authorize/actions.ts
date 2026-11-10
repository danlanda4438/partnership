"use server";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/data";
import { botSlug } from "@/lib/mcp/server";

export async function decideAuthorization(form: FormData) {
  const get = (k: string) => String(form.get(k) ?? "");
  const db = await getDb();
  if (!db) redirect("/login");

  // Only redirect to an address registered for this client.
  const client = await db.call<{ client_id: string } | null>("oauth_client_info", {
    p_client_id: get("client_id"), p_redirect_uri: get("redirect_uri"),
  });
  if (!client) redirect("/");

  const target = new URL(get("redirect_uri"));
  if (get("state")) target.searchParams.set("state", get("state"));

  if (get("decision") !== "approve") {
    target.searchParams.set("error", "access_denied");
    redirect(target.toString());
  }
  // A bot's personal address may only be bound to that bot.
  const forBot = /\/api\/mcp\/([a-z0-9-]{1,64})\/?$/.exec(get("resource"))?.[1];
  if (forBot) {
    const workers = await db.call<{ id: string; name: string }[]>("ui_connectable_workers");
    const chosen = workers.find((w) => w.id === get("worker_id"));
    if (!chosen || botSlug(chosen.name) !== forBot) {
      target.searchParams.set("error", "access_denied");
      redirect(target.toString());
    }
  }
  let code: string | null = null;
  try {
    code = await db.call<string>("oauth_authorize", {
      p_client_id: get("client_id"),
      p_redirect_uri: get("redirect_uri"),
      p_worker_id: get("worker_id"),
      p_code_challenge: get("code_challenge"),
    });
  } catch {
    target.searchParams.set("error", "access_denied");
  }
  if (code) target.searchParams.set("code", code);
  redirect(target.toString());
}
