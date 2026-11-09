import { cache } from "react";
import { redirect } from "next/navigation";
import type { MemberRole } from "@gleeday/domain";
import { getDb, isConfigured, type Db } from "./data";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  display_timezone: string;
  role: MemberRole;
}

export interface AppContext {
  db: Db;
  email: string;
  workspace: Workspace | null;
}

/** Signed-in context for app pages. Redirects to /login when there is no session. */
export const getContext = cache(async (): Promise<AppContext> => {
  if (!isConfigured()) redirect("/login");
  const db = await getDb();
  if (!db) redirect("/login");
  const ctx = await db.call<{ email: string | null; workspaces: Workspace[] }>("ui_context");
  return { db, email: ctx.email ?? db.email, workspace: ctx.workspaces[0] ?? null };
});

/** Guarantees a workspace for pages inside the app shell. */
export async function requireWorkspace(): Promise<AppContext & { workspace: Workspace }> {
  const ctx = await getContext();
  if (!ctx.workspace) redirect("/no-workspace");
  return ctx as AppContext & { workspace: Workspace };
}

export const canAdmin = (role: MemberRole) => role === "owner" || role === "admin";
export const canWrite = (role: MemberRole) => role !== "viewer";
