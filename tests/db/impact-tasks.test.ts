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

describe("conversations with bots", () => {
  it("a message becomes a task for the tagged bot; the bot reads the thread and answers", async () => {
    const ws = await createWorkspace();
    const soled = await createWorker(ws.workspaceId, { name: "Soled", capabilities: ["tasks.assign"], channelIds: Object.values(ws.channels) });
    await admin("update public.worker_identities set role = 'coordinator' where id = $1", [soled]);
    const aff = await createWorker(ws.workspaceId, { name: "Gleeday affiliates", capabilities: ["gmail.send"], channelIds: [ws.channels.affiliates] });
    const outsider = await createWorker(ws.workspaceId, { name: "Gleeday Listing", capabilities: [], channelIds: [ws.channels.listings] });

    // No bot chosen → Soled
    const thread = (await asUser(ws.ownerId, (q) => q("select public.send_bot_message($1, null, 'What is open this week?') as t", [ws.workspaceId]))).rows[0].t;
    const list = await svc("select public.worker_list_tasks($1) as r", [soled]);
    const task = list.tasks.find((t: { kind: string }) => t.kind === "owner.message");
    expect(task).toMatchObject({ requested_by: "owner (in the app)", details: { thread_id: thread, message: "What is open this week?" } });
    const d = await admin("select event_type from public.webhook_deliveries where worker_id = $1", [soled]);
    expect(d.rows.map((r) => r.event_type)).toContain("task.available");

    const conv = await svc("select public.worker_get_conversation($1, $2) as r", [soled, thread]);
    expect(conv.messages).toMatchObject([{ from: "owner", to: "Soled", text: "What is open this week?" }]);
    await svc("select public.worker_reply($1, $2, 'Three follow-ups are due.') as r", [soled, thread]);

    // Soled hands work to the affiliates bot in the same thread; that bot may answer there.
    await expectPgError(svc("select public.worker_reply($1, $2, 'hi') as r", [aff, thread]), "conversation not found");
    await svc("select public.worker_create_task($1, 'affiliates', 'outreach.follow_up', 'Follow-ups', $3, null, $2, 50, null, 'conv-1') as r",
      [soled, aff, JSON.stringify({ thread_id: thread })]);
    await svc("select public.worker_reply($1, $2, 'On it.') as r", [aff, thread]);
    await expectPgError(svc("select public.worker_get_conversation($1, $2) as r", [outsider, thread]), "conversation not found");

    // The owner replies to the affiliates bot directly in the same thread.
    await asUser(ws.ownerId, (q) => q("select public.send_bot_message($1, $2, 'Thanks — start with Acme.', $3)", [ws.workspaceId, aff, thread]));
    const view = (await asUser(ws.ownerId, (q) => q("select public.ui_conversation($1, $2) as v", [ws.workspaceId, thread]))).rows[0].v;
    expect(view.messages.map((m: { from_bot: string | null; text: string }) => `${m.from_bot ?? "You"}: ${m.text}`)).toEqual([
      "You: What is open this week?", "Soled: Three follow-ups are due.", "Gleeday affiliates: On it.", "You: Thanks — start with Acme.",
    ]);
    expect(view.tasks).toMatchObject([{ title: "Follow-ups", bot: "Gleeday affiliates" }]);
    const threads = (await asUser(ws.ownerId, (q) => q("select public.ui_conversations($1) as v", [ws.workspaceId]))).rows[0].v;
    expect(threads).toMatchObject([{ thread_id: thread, messages: 4, waiting_for_bot: true }]);

    // Other workspaces see nothing; viewers can read but not send; messages are immutable.
    const other = await createWorkspace();
    expect((await asUser(other.ownerId, (q) => q("select public.ui_conversations($1) as v", [ws.workspaceId]))).rows[0].v).toEqual([]);
    const viewer = await addMember(ws.workspaceId, "viewer");
    await expectPgError(asUser(viewer, (q) => q("select public.send_bot_message($1, null, 'hi')", [ws.workspaceId])), "not authorized");
    await expectPgError(admin("update public.conversation_messages set body = 'x' where thread_id = $1", [thread]));
  });
});

describe("quick approvals list", () => {
  it("shows a preview and the fingerprint; a decision with that fingerprint works, a stale one is refused", async () => {
    const ws = await createWorkspace();
    const w = await createWorker(ws.workspaceId, { name: "Gleeday affiliates", capabilities: ["gmail.send"], channelIds: [ws.channels.affiliates] });
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    const mk = async (body: string) => (await admin(`insert into public.approvals (workspace_id, opportunity_id, action_type, summary, payload, proposed_by_worker_id, expires_at)
      values ($1,$2,'send_message','Intro',$3,$4, now() + interval '1 day') returning id, payload_hash`,
      [ws.workspaceId, opp, JSON.stringify({ to: ["a@x.com", "b@x.com"], subject: "Hi", body, attachments: [] }), w])).rows[0];
    const a1 = await mk("Hello   there\nfriend");
    const a2 = await mk("Second");
    const list = (await asUser(ws.ownerId, (q) => q("select public.ui_approvals($1, 'pending') as v", [ws.workspaceId]))).rows[0].v;
    const item = list.find((x: { id: string }) => x.id === a1.id);
    expect(item).toMatchObject({ payload_hash: a1.payload_hash, preview: { to: "a@x.com, b@x.com", subject: "Hi", body: "Hello there friend", attachments: 0 } });
    await asUser(ws.ownerId, (q) => q("select public.decide_approval($1, 'approve', $2)", [a1.id, item.payload_hash]));
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.decide_approval($1, 'approve', $2)", [a2.id, a1.payload_hash])), "payload changed");
  });
});
