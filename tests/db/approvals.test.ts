import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMember, admin, asService, asUser, createOpportunity, createWorkspace, createWorker, expectPgError } from "./helpers";

const payload = { to: ["partner@venue.test"], subject: "Partnership", body: "Hello", attachments: [] };

async function propose(workspaceId: string, opts: { expiresIn?: string } = {}) {
  const worker = await createWorker(workspaceId);
  const { rows } = await asService((q) =>
    q(
      `insert into public.approvals (workspace_id, action_type, summary, payload, proposed_by_worker_id, expires_at, status)
       values ($1, 'send_message', 'Intro email', $2, $3, now() + $4::interval, 'approved')
       returning id, payload_hash, status`,
      [workspaceId, JSON.stringify(payload), worker, opts.expiresIn ?? "1 day"],
    ),
  );
  return rows[0] as { id: string; payload_hash: string; status: string };
}

const decide = (userId: string, id: string, decision: string, hash: string) =>
  asUser(userId, (q) => q("select * from public.decide_approval($1, $2, $3)", [id, decision, hash]));
const begin = (id: string, hash: string) =>
  asService((q) => q("select * from private.begin_approval_execution($1, $2, 'test-executor')", [id, hash]));

describe("approvals", () => {
  it("always start pending with a database-computed hash, even if the proposer claims approved", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    expect(p.status).toBe("pending");
    const { rows } = await admin("select payload::text as t from public.approvals where id = $1", [p.id]);
    expect(p.payload_hash).toBe(createHash("sha256").update(rows[0].t).digest("hex"));
  });

  it("the payload cannot be edited after proposal", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await expectPgError(
      asService((q) => q(`update public.approvals set payload = jsonb_set(payload, '{to}', '["attacker@x.test"]') where id = $1`, [p.id])),
      "immutable",
    );
  });

  it("signed-in users cannot change approvals except through decide_approval", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await expectPgError(asUser(a.ownerId, (q) => q("update public.approvals set status = 'approved' where id = $1", [p.id])), "permission denied");
  });

  it("refuses a decision made against a different payload hash", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await expectPgError(decide(a.ownerId, p.id, "approve", "0".repeat(64)), "payload changed");
  });

  it("members, viewers and other workspaces cannot approve", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const member = await addMember(a.workspaceId, "member");
    const viewer = await addMember(a.workspaceId, "viewer");
    const p = await propose(a.workspaceId);
    for (const u of [member, viewer, b.ownerId]) await expectPgError(decide(u, p.id, "approve", p.payload_hash), "not authorized");
  });

  it("executes an approved payload exactly once", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await decide(a.ownerId, p.id, "approve", p.payload_hash);
    const first = await begin(p.id, p.payload_hash);
    expect(first.rows[0].status).toBe("executing");
    await expectPgError(begin(p.id, p.payload_hash), "cannot execute");
    await asService((q) => q("select private.finish_approval_execution($1, 'executed', $2)", [p.id, JSON.stringify({ provider_message_id: "gmail-1" })]));
    await expectPgError(begin(p.id, p.payload_hash), "cannot execute");
    const events = await admin("select event_type from public.approval_events where approval_id = $1 order by created_at, id", [p.id]);
    expect(events.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(["requested", "approved", "execution_started", "execution_executed"]));
  });

  it("concurrent execution attempts produce a single execution", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await decide(a.ownerId, p.id, "approve", p.payload_hash);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => begin(p.id, p.payload_hash)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("rejected approvals cannot execute", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await decide(a.ownerId, p.id, "reject", p.payload_hash);
    await expectPgError(begin(p.id, p.payload_hash), "rejected");
  });

  it("execution refuses a payload that differs from the approved one", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await decide(a.ownerId, p.id, "approve", p.payload_hash);
    await expectPgError(begin(p.id, "f".repeat(64)), "hash mismatch");
  });

  it("expired approvals can be neither approved nor executed", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId, { expiresIn: "1 second" });
    await new Promise((r) => setTimeout(r, 1200));
    await expectPgError(decide(a.ownerId, p.id, "approve", p.payload_hash), "expired");

    const p2 = await propose(a.workspaceId, { expiresIn: "2 seconds" });
    await decide(a.ownerId, p2.id, "approve", p2.payload_hash);
    await new Promise((r) => setTimeout(r, 2200));
    const res = await begin(p2.id, p2.payload_hash);
    expect(res.rows[0].id).toBeNull();
    const { rows } = await admin("select status from public.approvals where id = $1", [p2.id]);
    expect(rows[0].status).toBe("expired");
  });

  it("revoking the approver's access cancels a not-yet-executed approval", async () => {
    const a = await createWorkspace();
    const approver = await addMember(a.workspaceId, "admin");
    const p = await propose(a.workspaceId);
    await decide(approver, p.id, "approve", p.payload_hash);
    const m = await admin("select id from public.workspace_members where user_id = $1", [approver]);
    await asUser(a.ownerId, (q) => q("select public.set_member_role($1, 'admin', 'revoked')", [m.rows[0].id]));
    const res = await begin(p.id, p.payload_hash);
    expect(res.rows[0].id).toBeNull();
    const { rows } = await admin("select status from public.approvals where id = $1", [p.id]);
    expect(rows[0].status).toBe("cancelled");
  });

  it("uncertain outcomes are recorded for reconciliation, not silently retried", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await decide(a.ownerId, p.id, "approve", p.payload_hash);
    await begin(p.id, p.payload_hash);
    await asService((q) => q("select private.finish_approval_execution($1, 'uncertain', '{\"error\":\"timeout\"}')", [p.id]));
    await expectPgError(begin(p.id, p.payload_hash), "execution_uncertain");
  });

  it("approval history is append-only", async () => {
    const a = await createWorkspace();
    const p = await propose(a.workspaceId);
    await expectPgError(admin("delete from public.approval_events where approval_id = $1", [p.id]), "append-only");
  });

  it("an unsigned IO cannot be marked signed without evidence", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.media_pr);
    await expectPgError(
      admin(`insert into public.offers (workspace_id, opportunity_id, kind, terms, amount, currency, is_paid, io_signed)
             values ($1, $2, 'paid_placement', 'Banner', 500, 'USD', true, true)`, [a.workspaceId, opp]),
      "check constraint",
    );
  });
});
