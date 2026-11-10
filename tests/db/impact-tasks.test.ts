// Tasks created by a person in the app, and the impact.com workflow for Affiliates and Co-Marketing.
import { describe, expect, it } from "vitest";
import { addMember, admin, asService, asUser, createOpportunity, createWorker, createWorkspace, expectPgError } from "./helpers";

const svc = async (sql: string, params: unknown[] = []) => (await asService((q) => q(sql, params))).rows[0]?.r;

describe("tasks created by a person", () => {
  it("members create tasks for a bot in its program; the bot is notified and sees who asked", async () => {
    const ws = await createWorkspace();
    const aff = await createWorker(ws.workspaceId, { name: "Gleeday affiliates", capabilities: ["gmail.send"], channelIds: [ws.channels.affiliates] });
    const listing = await createWorker(ws.workspaceId, { name: "Gleeday Listing", capabilities: [], channelIds: [ws.channels.listings] });
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);

    const id = (await asUser(ws.ownerId, (q) => q("select public.create_task($1, 'affiliates', 'Contact these 5 podcasts', 'Names: ...', $2, $3, null, 10) as id",
      [ws.workspaceId, aff, opp]))).rows[0].id;
    const t = (await admin("select kind, status, priority, created_by_user_id, details from public.tasks where id = $1", [id])).rows[0];
    expect(t).toMatchObject({ kind: "owner.request", status: "queued", priority: 10, created_by_user_id: ws.ownerId, details: { instructions: "Names: ..." } });
    const d = await admin("select event_type from public.webhook_deliveries where worker_id = $1", [aff]);
    expect(d.rows.map((r) => r.event_type)).toEqual(["task.available"]);
    const list = await svc("select public.worker_list_tasks($1) as r", [aff]);
    expect(list.tasks[0]).toMatchObject({ task_id: id, requested_by: "owner (in the app)", details: { instructions: "Names: ..." } });

    // Wrong bot for the program, wrong program for the partner
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.create_task($1, 'affiliates', 'x task', '', $2)", [ws.workspaceId, listing])), "does not work on this program");
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.create_task($1, 'listings', 'x task', '', null, $2)", [ws.workspaceId, opp])), "not in this program");
  });

  it("viewers and outsiders cannot create tasks", async () => {
    const ws = await createWorkspace();
    const viewer = await addMember(ws.workspaceId, "viewer");
    await expectPgError(asUser(viewer, (q) => q("select public.create_task($1, 'affiliates', 'x task', '')", [ws.workspaceId])), "not authorized");
    const other = await createWorkspace();
    await expectPgError(asUser(other.ownerId, (q) => q("select public.create_task($1, 'affiliates', 'x task', '')", [ws.workspaceId])), "not authorized");
  });
});

describe("impact.com", () => {
  async function setup(caps = ["gmail.send", "impact.manage"]) {
    const ws = await createWorkspace();
    const w = await createWorker(ws.workspaceId, { name: "Gleeday affiliates", capabilities: caps, channelIds: [ws.channels.affiliates, ws.channels.media_pr] });
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    return { ws, w, opp };
  }
  const record = (w: string, opp: string, type: string, id: string) =>
    svc("select public.worker_append_activity($1, 'impact', $2, $3) as r",
      [w, id, JSON.stringify({ opportunity_id: opp, event_type: type, occurred_at: "2026-11-10T10:00:00Z", summary: "from impact.com" })]);

  it("records impact.com activity and sets the joined milestone with proof", async () => {
    const { w, opp } = await setup();
    await record(w, opp, "impact.partner_applied", "imp-app-1");
    const joined = await record(w, opp, "impact.partner_joined", "imp-join-1");
    const m = await svc("select public.worker_set_milestone($1, $2, 'joined_impact', $3) as r", [w, opp, joined.event_id]);
    expect(m).toMatchObject({ milestone: "joined_impact" });
    const o = (await admin("select milestone_key from public.opportunities where id = $1", [opp])).rows[0];
    expect(o.milestone_key).toBe("joined_impact");
    await expectPgError(svc("select public.worker_set_milestone($1, $2, 'launched', $3) as r", [w, opp, joined.event_id]), "does not exist for affiliates");
  });

  it("impact.com activity is refused outside Affiliates and Co-Marketing", async () => {
    const { ws, w } = await setup();
    const media = await createOpportunity(ws.workspaceId, ws.channels.media_pr);
    await expectPgError(record(w, media, "impact.partner_joined", "imp-x"), "only to Affiliates or Co-Marketing");
  });

  it("impact.com actions need an exact proposal, approval, and the impact.manage permission", async () => {
    for (const caps of [["gmail.send", "impact.manage"], ["gmail.send"]]) {
      const { ws, w, opp } = await setup(caps);
      const t = (await admin(`insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title) values ($1,$2,$3,'impact.proposal','Send proposal') returning id`,
        [ws.workspaceId, ws.channels.affiliates, opp])).rows[0].id;
      const lease = await svc("select public.worker_claim_task($1, $2, 600) as r", [w, t]);
      await expectPgError(svc("select public.worker_propose_action($1, $2, $3, 'commercial_terms', 'Proposal', $4) as r",
        [w, t, lease.lease_token, JSON.stringify({ platform: "impact.com", terms: "10%" })]), "need");
      const prop = await svc("select public.worker_propose_action($1, $2, $3, 'commercial_terms', 'Proposal', $4) as r",
        [w, t, lease.lease_token, JSON.stringify({ platform: "impact.com", action: "send_proposal", partner: "Acme Blog", terms: { commission: "10%" } })]);
      await svc("select public.worker_request_approval($1, $2, $3) as r", [w, prop.proposal_id, lease.lease_token]);
      await asUser(ws.ownerId, (q) => q("select public.decide_approval($1, 'approve', $2)", [prop.proposal_id, prop.payload_hash]));
      const l2 = await svc("select public.worker_claim_task($1, $2, 600) as r", [w, t]);
      const start = svc("select public.worker_start_approved_action($1, $2, $3, $4, $5) as r", [w, prop.proposal_id, prop.payload_hash, t, l2.lease_token]);
      if (caps.includes("impact.manage")) {
        expect(await start).toMatchObject({ executable: true });
        const done = await svc("select public.worker_finish_approved_action($1, $2, 'executed', $3) as r", [w, prop.proposal_id, JSON.stringify({ provider_reference: "impact-proposal-991" })]);
        expect(done.status).toBe("executed");
      } else {
        await expectPgError(start, "not allowed to act on impact.com");
      }
    }
  });
});
