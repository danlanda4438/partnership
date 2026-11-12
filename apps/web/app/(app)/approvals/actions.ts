"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getContext } from "@/lib/context";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

/**
 * Approve or reject one or many proposals from a list. Each decision carries the
 * fingerprint of the content that was shown; the database refuses it if the content changed.
 */
export async function decideMany(form: FormData) {
  const { db } = await getContext();
  const back = String(form.get("back") ?? "/approvals");
  const one = String(form.get("one") ?? "");
  let decision: "approve" | "reject";
  let picks: string[];
  if (one) {
    const [d, ...rest] = one.split("|");
    decision = d === "approve" ? "approve" : "reject";
    picks = [rest.join("|")];
  } else {
    decision = String(form.get("bulk") ?? "") === "approve" ? "approve" : "reject";
    picks = form.getAll("pick").map(String);
  }
  let done = 0;
  const errors: string[] = [];
  for (const p of picks) {
    const [id, hash] = p.split("|");
    if (!id || !hash) continue;
    try {
      await db.call("decide_approval", { p_approval_id: id, p_decision: decision, p_payload_hash: hash, p_note: one ? null : "Bulk decision" });
      done++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "failed");
    }
  }
  if (done) {
    // Wake the proposing bots (best effort; the scheduler retries).
    after(async () => {
      if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
    });
  }
  revalidatePath("/");
  revalidatePath("/approvals");
  const sep = back.includes("?") ? "&" : "?";
  const verb = decision === "approve" ? "Approved" : "Rejected";
  const msg = picks.length === 0 ? "error=" + encodeURIComponent("Select at least one item first")
    : errors.length ? "error=" + encodeURIComponent(`${verb} ${done}; ${errors.length} not done: ${[...new Set(errors)].join("; ")}`)
    : "ok=" + encodeURIComponent(`${verb} ${done}`);
  redirect(`${back}${sep}${msg}`);
}
