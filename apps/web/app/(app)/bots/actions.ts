"use server";
import { revalidatePath } from "next/cache";
import { act, optional, str } from "@/lib/act";
import { getContext } from "@/lib/context";

export interface IssueState {
  token?: string;
  error?: string;
}

export async function issueToken(_prev: IssueState, form: FormData): Promise<IssueState> {
  const { db } = await getContext();
  try {
    const token = await db.call<string>("issue_worker_token", {
      p_worker_id: str(form, "worker_id"),
      p_label: optional(form, "label") ?? "Bot token",
      p_expires_in_days: Number(str(form, "expires_in_days") || 90),
    });
    revalidatePath("/bots");
    return { token };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create a token" };
  }
}

export async function createBot(form: FormData) {
  await act("/bots", "Bot added", ({ db, workspace }) =>
    db.call("create_worker", {
      p_workspace_id: workspace!.id,
      p_name: str(form, "name"),
      p_role: str(form, "role"),
      p_description: optional(form, "description"),
      p_capabilities: form.getAll("capabilities").map(String),
      p_channels: form.getAll("channels").map(String),
    }),
  );
}

export async function saveBot(form: FormData) {
  const budget = str(form, "daily_action_budget");
  await act("/bots", "Bot settings saved", async ({ db }) => {
    await db.call("set_worker_settings", {
      p_worker_id: str(form, "worker_id"),
      p_status: str(form, "status"),
      p_max_concurrent_tasks: Number(str(form, "max_concurrent_tasks") || 1),
      p_daily_action_budget: budget === "" ? null : Number(budget),
    });
    await db.call("set_worker_channels", { p_worker_id: str(form, "worker_id"), p_channels: form.getAll("channels").map(String) });
    await db.call("set_worker_routine", { p_worker_id: str(form, "worker_id"), p_routine_secret_ref: str(form, "routine_secret_ref") });
  });
}

export async function revokeToken(form: FormData) {
  await act("/bots", "Token revoked", ({ db }) => db.call("revoke_worker_token", { p_credential_id: str(form, "credential_id") }));
}

export async function revokeConnection(form: FormData) {
  await act("/bots", "Connection removed", ({ db }) => db.call("revoke_connector_grant", { p_grant_id: str(form, "grant_id") }));
}
