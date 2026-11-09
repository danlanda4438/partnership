"use server";
import { act, optional, str } from "@/lib/act";

export async function decide(form: FormData) {
  const id = str(form, "approval_id");
  const decision = str(form, "decision") === "approve" ? "approve" : "reject";
  await act(`/approvals/${id}`, decision === "approve" ? "Approved" : "Rejected", ({ db }) =>
    db.call("decide_approval", {
      p_approval_id: id,
      p_decision: decision,
      // The hash of the exact payload shown on the page. The database refuses the decision
      // if it doesn't match the stored proposal.
      p_payload_hash: str(form, "payload_hash"),
      p_note: optional(form, "note"),
    }),
  );
}
