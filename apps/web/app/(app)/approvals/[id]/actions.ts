"use server";
import { after } from "next/server";
import { act, optional, str } from "@/lib/act";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

export async function decide(form: FormData) {
  const id = str(form, "approval_id");
  const decision = str(form, "decision") === "approve" ? "approve" : "reject";
  // Wake the proposing bot as soon as the response is sent (best effort; the scheduler retries).
  after(async () => {
    if (serviceConfigured()) await dispatchPending(await getServiceDb()).catch(() => {});
  });
  await act(`/approvals/${id}`, decision === "approve" ? "Approved" : "Rejected", ({ db }) =>
    db.call("decide_approval", {
      p_approval_id: id,
      p_decision: decision,
      // The fingerprint of the exact payload shown on the page. The database refuses the
      // decision if it doesn't match the stored proposal.
      p_payload_hash: str(form, "payload_hash"),
      p_note: optional(form, "note"),
    }),
  );
}
