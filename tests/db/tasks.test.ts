import { describe, expect, it } from "vitest";
import { admin, asService, asUser, createWorkspace, createWorker, expectPgError } from "./helpers";

async function createTask(workspaceId: string, channelId: string | null, opts: { maxAttempts?: number; assigned?: string; capability?: string } = {}) {
  const { rows } = await admin(
    `insert into public.tasks (workspace_id, channel_id, kind, title, max_attempts, assigned_worker_id, required_capability)
     values ($1, $2, 'outreach.follow_up', 'Follow up', $3, $4, $5) returning id`,
    [workspaceId, channelId, opts.maxAttempts ?? 3, opts.assigned ?? null, opts.capability ?? null],
  );
  return rows[0].id as string;
}

const claim = (worker: string, task: string, lease = 300) =>
  asService(async (q) => (await q("select * from private.claim_task($1, $2, $3)", [worker, task, lease])).rows[0] as {
    attempt_id: string; lease_token: string; lease_expires_at: Date;
  });
const report = (worker: string, task: string, token: string, outcome: string, result: object = {}) =>
  asService(async (q) => (await q("select * from private.report_task($1, $2, $3, $4, $5, '{}')", [worker, task, token, outcome, JSON.stringify(result)])).rows[0]);
const expireLease = (task: string) =>
  admin(`update public.task_attempts set lease_expires_at = now() - interval '1 second' where task_id = $1 and status = 'active';
         `, [task]);

describe("task claims and leases", () => {
  it("only one of many concurrent claims succeeds", async () => {
    const a = await createWorkspace();
    const workers = await Promise.all(Array.from({ length: 4 }, () => createWorker(a.workspaceId, { channelIds: [a.channels.affiliates] })));
    const task = await createTask(a.workspaceId, a.channels.affiliates);
    const results = await Promise.allSettled(workers.map((w) => claim(w, task)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await admin("select count(*)::int n from public.task_attempts where task_id = $1", [task]);
    expect(rows[0].n).toBe(1);
  });

  it("enforces worker scope: channel, assignment, capability, workspace and status", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const listingsBot = await createWorker(a.workspaceId, { channelIds: [a.channels.listings] });
    const affiliatesBot = await createWorker(a.workspaceId, { channelIds: [a.channels.affiliates] });
    const foreignBot = await createWorker(b.workspaceId, { channelIds: [b.channels.affiliates] });

    const t1 = await createTask(a.workspaceId, a.channels.affiliates);
    await expectPgError(claim(listingsBot, t1), "not in worker scope");
    await expectPgError(claim(foreignBot, t1), "not in worker scope");

    const t2 = await createTask(a.workspaceId, a.channels.affiliates, { assigned: listingsBot });
    await expectPgError(claim(affiliatesBot, t2), "assigned to another worker");

    const t3 = await createTask(a.workspaceId, a.channels.affiliates, { capability: "gmail.send" });
    await expectPgError(claim(affiliatesBot, t3), "lacks capability");

    await admin("update public.worker_identities set status = 'paused' where id = $1", [affiliatesBot]);
    await expectPgError(claim(affiliatesBot, t1), "worker not active");
  });

  it("rejects a wrong lease token and another worker's report", async () => {
    const a = await createWorkspace();
    const w1 = await createWorker(a.workspaceId, { channelIds: [a.channels.media_pr] });
    const w2 = await createWorker(a.workspaceId, { channelIds: [a.channels.media_pr] });
    const task = await createTask(a.workspaceId, a.channels.media_pr);
    const lease = await claim(w1, task);
    await expectPgError(report(w1, task, "not-the-token", "succeeded"), "invalid lease");
    await expectPgError(report(w2, task, lease.lease_token, "succeeded"), "invalid lease");
  });

  it("an expired lease cannot report, and the sweeper returns the task to the queue", async () => {
    const a = await createWorkspace();
    const w1 = await createWorker(a.workspaceId, { channelIds: [a.channels.listings] });
    const w2 = await createWorker(a.workspaceId, { channelIds: [a.channels.listings] });
    const task = await createTask(a.workspaceId, a.channels.listings);
    const lease = await claim(w1, task);
    await expireLease(task);
    await expectPgError(report(w1, task, lease.lease_token, "succeeded"), "lease expired");
    await asService((q) => q("select private.expire_leases()"));
    const second = await claim(w2, task);
    expect(second.attempt_id).not.toBe(lease.attempt_id);
    // The stale worker still cannot report after someone else claimed it.
    await expectPgError(report(w1, task, lease.lease_token, "succeeded"), "lease expired");
  });

  it("result reports are idempotent", async () => {
    const a = await createWorkspace();
    const w = await createWorker(a.workspaceId, { channelIds: [a.channels.co_marketing] });
    const task = await createTask(a.workspaceId, a.channels.co_marketing);
    const lease = await claim(w, task);
    const r1 = await report(w, task, lease.lease_token, "succeeded", { note: "done" });
    const r2 = await report(w, task, lease.lease_token, "succeeded", { note: "done" });
    expect(r1.status).toBe("succeeded");
    expect(r2.status).toBe("succeeded");
    const { rows } = await admin("select count(*)::int n from public.task_attempts where task_id = $1", [task]);
    expect(rows[0].n).toBe(1);
  });

  it("failures retry up to max_attempts and then dead-letter", async () => {
    const a = await createWorkspace();
    const w = await createWorker(a.workspaceId, { channelIds: [a.channels.affiliates] });
    const task = await createTask(a.workspaceId, a.channels.affiliates, { maxAttempts: 2 });
    const l1 = await claim(w, task);
    expect((await report(w, task, l1.lease_token, "failed", { error: "x" })).status).toBe("queued");
    const l2 = await claim(w, task);
    expect((await report(w, task, l2.lease_token, "failed", { error: "x" })).status).toBe("dead_lettered");
    await expectPgError(claim(w, task), "not claimable");
  });

  it("blocked reports surface a reason for the exception queue", async () => {
    const a = await createWorkspace();
    const w = await createWorker(a.workspaceId, { channelIds: [a.channels.affiliates] });
    const task = await createTask(a.workspaceId, a.channels.affiliates);
    const l = await claim(w, task);
    const t = await report(w, task, l.lease_token, "blocked", { reason: "ambiguous identity" });
    expect(t.status).toBe("blocked");
    expect(t.blocked_reason).toBe("ambiguous identity");
  });

  it("cancellation by an owner invalidates the active lease", async () => {
    const a = await createWorkspace();
    const w = await createWorker(a.workspaceId, { channelIds: [a.channels.affiliates] });
    const task = await createTask(a.workspaceId, a.channels.affiliates);
    const l = await claim(w, task);
    await asUser(a.ownerId, (q) => q("select public.cancel_task($1, 'owner changed plans')", [task]));
    await expectPgError(report(w, task, l.lease_token, "succeeded"), "lease expired");
  });

  it("respects a worker's concurrency limit (backpressure)", async () => {
    const a = await createWorkspace();
    const w = await createWorker(a.workspaceId, { channelIds: [a.channels.affiliates], maxConcurrent: 1 });
    const t1 = await createTask(a.workspaceId, a.channels.affiliates);
    const t2 = await createTask(a.workspaceId, a.channels.affiliates);
    await claim(w, t1);
    await expectPgError(claim(w, t2), "concurrency limit");
  });

  it("signed-in users cannot see lease token hashes", async () => {
    const a = await createWorkspace();
    await expectPgError(asUser(a.ownerId, (q) => q("select lease_token_hash from public.task_attempts")), "permission denied");
  });
});
