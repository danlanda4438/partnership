"use server";
import { canAdmin, getContext } from "@/lib/context";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

const KINDS = new Set(["source_rows", "orgs", "contacts", "opps", "events", "finalize", "offers", "tasks"]);

export interface ActionResult<T> { ok: boolean; data?: T; error?: string }

// Every call re-checks, against live membership, that the caller is an owner/admin of the
// workspace. Writes then go through the backend-only import functions.
async function guard() {
  const { db, workspace } = await getContext();
  if (!workspace || !canAdmin(workspace.role)) throw new Error("Only owners and admins can import data.");
  if (!serviceConfigured()) throw new Error("The server isn't configured for imports yet (SUPABASE_URL / SUPABASE_SECRET_KEY).");
  return { userId: db.userId, workspaceId: workspace.id, service: await getServiceDb() };
}

const fail = (err: unknown): ActionResult<never> => ({ ok: false, error: err instanceof Error ? err.message : "Something went wrong" });

export async function startImport(meta: Record<string, unknown>): Promise<ActionResult<string>> {
  try {
    const g = await guard();
    const batch = await g.service.call<string>("import_begin", { p_workspace_id: g.workspaceId, p_user_id: g.userId, p_meta: meta });
    return { ok: true, data: batch };
  } catch (err) { return fail(err); }
}

export async function importChunk(batchId: string, kind: string, items: unknown[]): Promise<ActionResult<{ created: number; existing: number; skipped: number }>> {
  try {
    if (!KINDS.has(kind) || !Array.isArray(items) || !/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Invalid import request.");
    const g = await guard();
    const r = await g.service.call<{ created: number; existing: number; skipped: number }>("import_apply", {
      p_workspace_id: g.workspaceId, p_batch_id: batchId, p_kind: kind, p_items: items,
    });
    return { ok: true, data: r };
  } catch (err) { return fail(err); }
}

export async function finishImport(batchId: string, status: "completed" | "failed", report: Record<string, unknown>): Promise<ActionResult<null>> {
  try {
    const g = await guard();
    void g;
    await g.service.call("import_finish", { p_batch_id: batchId, p_status: status, p_report: report });
    return { ok: true, data: null };
  } catch (err) { return fail(err); }
}
