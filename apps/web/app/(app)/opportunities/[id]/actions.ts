"use server";
import { zonedLocalToUtc } from "@gleeday/domain";
import { act, optional, str } from "@/lib/act";

const path = (form: FormData) => `/opportunities/${str(form, "opportunity_id")}`;

export async function recordActivity(form: FormData) {
  const date = str(form, "date");
  const time = str(form, "time");
  const occurredAt = date ? zonedLocalToUtc(date, time) : null;
  await act(path(form), "Activity recorded", ({ db }) =>
    db.call("record_activity", {
      p_opportunity_id: str(form, "opportunity_id"),
      p_event_type: str(form, "event_type"),
      p_summary: str(form, "summary"),
      p_occurred_at: occurredAt,
      p_precision: occurredAt ? (time ? "minute" : "day") : null,
      p_details: {},
    }),
  );
}

export async function setStage(form: FormData) {
  await act(path(form), "Stage updated", ({ db }) =>
    db.call("set_opportunity_stage", {
      p_opportunity_id: str(form, "opportunity_id"),
      p_stage: optional(form, "stage"),
      p_evidence_event_id: optional(form, "evidence_event_id"),
    }),
  );
}

export async function setStatus(form: FormData) {
  await act(path(form), "Status updated", ({ db }) =>
    db.call("set_opportunity_status", {
      p_opportunity_id: str(form, "opportunity_id"),
      p_disposition: optional(form, "disposition"),
      p_milestone_key: optional(form, "milestone_key"),
    }),
  );
}

export async function setPlan(form: FormData) {
  const owner = str(form, "owner");
  const due = str(form, "due_date");
  await act(path(form), "Plan saved", ({ db }) =>
    db.call("set_opportunity_plan", {
      p_opportunity_id: str(form, "opportunity_id"),
      p_next_action: str(form, "next_action"),
      p_next_action_due_at: due ? zonedLocalToUtc(due, str(form, "due_time") || "09:00") : null,
      p_owner_user_id: owner.startsWith("user:") ? owner.slice(5) : null,
      p_owner_worker_id: owner.startsWith("worker:") ? owner.slice(7) : null,
    }),
  );
}
