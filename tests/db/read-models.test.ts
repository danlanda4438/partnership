import { describe, expect, it } from "vitest";
import {
  addMember, admin, asUser, createOpportunity, createOrg, createWorkspace, createWorker, expectPgError,
} from "./helpers";

const json = async (userId: string, sql: string, params: unknown[]) =>
  (await asUser(userId, (q) => q(sql, params))).rows[0].r;

describe("UI mutations", () => {
  it("records manual activity, rejects drafts and unsupported types, and verification updates freshness", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.draft', 'x')", [opp])), "unsupported");
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'note.added', '  ')", [opp])), "summary");
    await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.verification', 'Checked listing page is live')", [opp]));
    const { rows } = await admin("select last_verified_at, last_verified_event_id from public.opportunities where id = $1", [opp]);
    expect(rows[0].last_verified_at).not.toBeNull();
  });

  it("an undated manual entry is stored with unknown precision", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.media_pr);
    const id = (await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.linkedin_message_sent', 'Old DM from sheet') as id", [opp]))).rows[0].id;
    const { rows } = await admin("select occurred_at, occurred_at_precision, actor_kind, actor_user_id from public.activity_events where id = $1", [id]);
    expect(rows[0]).toMatchObject({ occurred_at: null, occurred_at_precision: "unknown", actor_kind: "user", actor_user_id: ws.ownerId });
  });

  it("viewers cannot record activity or change stages", async () => {
    const ws = await createWorkspace();
    const viewer = await addMember(ws.workspaceId, "viewer");
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    await expectPgError(asUser(viewer, (q) => q("select public.record_activity($1, 'note.added', 'hi')", [opp])), "row-level security");
    await expectPgError(asUser(viewer, (q) => q("select public.set_opportunity_stage($1, 'contacted', null)", [opp])), "not permitted");
  });

  it("stage changes need evidence and are written to the timeline automatically", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.set_opportunity_stage($1, 'contacted', null)", [opp])), "check constraint");
    const ev = (await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.email_sent', 'Intro sent', now()) as id", [opp]))).rows[0].id;
    await asUser(ws.ownerId, (q) => q("select public.set_opportunity_stage($1, 'contacted', $2)", [opp, ev]));
    const { rows } = await admin("select event_type, summary, actor_kind, actor_user_id from public.activity_events where opportunity_id = $1 and event_type = 'opportunity.stage_changed'", [opp]);
    expect(rows).toEqual([{ event_type: "opportunity.stage_changed", summary: "Stage: not contacted → contacted", actor_kind: "user", actor_user_id: ws.ownerId }]);
  });

  it("owners of an opportunity must be active members of the workspace", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.listings);
    await expectPgError(asUser(a.ownerId, (q) => q("select public.set_opportunity_plan($1, 'Follow up', now(), $2, null)", [opp, b.ownerId])), "active member");
    await asUser(a.ownerId, (q) => q("select public.set_opportunity_plan($1, 'Follow up', now(), $2, null)", [opp, a.ownerId]));
  });

  it("only owners/admins change which channels a bot may work in", async () => {
    const ws = await createWorkspace();
    const member = await addMember(ws.workspaceId, "member");
    const bot = await createWorker(ws.workspaceId, { channelIds: [ws.channels.affiliates] });
    await expectPgError(asUser(member, (q) => q("select public.set_worker_channels($1, '{listings}')", [bot])), "not authorized");
    await asUser(ws.ownerId, (q) => q("select public.set_worker_channels($1, '{listings,media_pr}')", [bot]));
    const { rows } = await admin("select c.kind from public.worker_channel_scopes s join public.channels c on c.id = s.channel_id where s.worker_id = $1 order by 1", [bot]);
    expect(rows.map((r) => r.kind)).toEqual(["media_pr", "listings"]);
  });

  it("notification preferences are private to each person and create no schedule by default", async () => {
    const ws = await createWorkspace();
    const member = await addMember(ws.workspaceId, "member");
    const defaults = await json(member, "select public.ui_notification_preferences($1) as r", [ws.workspaceId]);
    expect(defaults).toMatchObject({ digest_cadence: "off", is_default: true });
    await asUser(ws.ownerId, (q) => q("select public.save_notification_preferences($1, 'daily', '08:30', 0::smallint, true, true, false)", [ws.workspaceId]));
    const { rows } = await asUser(member, (q) => q("select * from public.notification_preferences"));
    expect(rows).toEqual([]);
  });
});

describe("read models", () => {
  it("opportunity detail includes contacts, identities, timeline with provenance, and milestones of its channel", async () => {
    const ws = await createWorkspace();
    const org = await createOrg(ws.workspaceId, "Listing Site");
    const c = (await admin("insert into public.contacts (workspace_id, organization_id, full_name) values ($1,$2,'Eve') returning id", [ws.workspaceId, org])).rows[0].id;
    await admin(`insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value, is_verified, verified_at)
                 values ($1,$2,'email','eve@listing.test','eve@listing.test',true,now())`, [ws.workspaceId, c]);
    const opp = (await admin(`insert into public.opportunities (workspace_id, channel_id, organization_id, primary_contact_id)
                              values ($1,$2,$3,$4) returning id`, [ws.workspaceId, ws.channels.listings, org, c])).rows[0].id;
    const file = (await admin(`insert into public.source_files (workspace_id, external_file_id, title, url) values ($1,'sheet1','Gleeday Listing Prospects','https://docs.google.com/x') returning id`, [ws.workspaceId])).rows[0].id;
    const batch = (await admin("insert into public.import_batches (workspace_id, kind) values ($1,'snapshot') returning id", [ws.workspaceId])).rows[0].id;
    const row = (await admin(`insert into public.source_rows (workspace_id, import_batch_id, source_file_id, tab_name, row_number, raw_values, checksum)
                              values ($1,$2,$3,'Gleeday Listing Prospects',7,'{"Status":"Submitted"}','abc') returning id`, [ws.workspaceId, batch, file])).rows[0].id;
    await admin(`insert into public.activity_events (workspace_id, opportunity_id, event_type, source, actor_kind, source_row_id, summary)
                 values ($1,$2,'listing.submitted','import:sheet1','import',$3,'Submitted (from sheet)')`, [ws.workspaceId, opp, row]);

    const d = await json(ws.ownerId, "select public.ui_opportunity($1) as r", [opp]);
    expect(d.organization.name).toBe("Listing Site");
    expect(d.contacts[0]).toMatchObject({ full_name: "Eve", is_primary: true });
    expect(d.contacts[0].identities[0]).toMatchObject({ value: "eve@listing.test", is_verified: true });
    expect(d.timeline[0]).toMatchObject({ summary: "Submitted (from sheet)", precision: "unknown" });
    expect(d.timeline[0].provenance).toEqual({ file: "Gleeday Listing Prospects", url: "https://docs.google.com/x", tab: "Gleeday Listing Prospects", row: 7 });
    expect(d.milestones.map((m: any) => m.key)).toEqual(["submitted", "pending_review", "approved_scheduled", "publicly_live"]);
  });

  it("returns nothing for another workspace's opportunity", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const opp = await createOpportunity(b.workspaceId, b.channels.affiliates);
    expect(await json(a.ownerId, "select public.ui_opportunity($1) as r", [opp])).toBeNull();
  });

  it("the exception queue gathers blocked work, uncertain sends, verification needs, unhealthy campaigns and ambiguous identities", async () => {
    const ws = await createWorkspace();
    await admin(`insert into public.tasks (workspace_id, kind, title, status, blocked_reason) values ($1,'outreach.send','Send intro','blocked','Ambiguous recipient')`, [ws.workspaceId]);
    const opp = await createOpportunity(ws.workspaceId, ws.channels.media_pr);
    await admin("update public.opportunities set disposition = 'needs_verification' where id = $1", [opp]);
    await admin(`insert into public.campaigns (workspace_id, provider, external_campaign_id, name, status) values ($1,'instantly','c1','Affiliates Q4','error')`, [ws.workspaceId]);
    const org = await createOrg(ws.workspaceId);
    const mk = async () => (await admin("insert into public.contacts (workspace_id, organization_id) values ($1,$2) returning id", [ws.workspaceId, org])).rows[0].id;
    const [c1, c2] = [await mk(), await mk()];
    for (const c of [c1, c2]) {
      await admin(`insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value) values ($1,$2,'email','info@hq.test','info@hq.test')`, [ws.workspaceId, c]);
    }
    const items = await json(ws.ownerId, "select public.ui_exceptions($1) as r", [ws.workspaceId]);
    const kinds = items.map((i: any) => i.kind).sort();
    expect(kinds).toEqual(["campaign_error", "identity_ambiguous", "opportunity_needs_verification", "task_blocked"]);
  });

  it("the daily view shows pending approvals, due work and changes, but not plain notes", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    await asUser(ws.ownerId, (q) => q("select public.set_opportunity_plan($1, 'Send contract', now() - interval '1 hour', null, null)", [opp]));
    await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'note.added', 'just a note')", [opp]));
    await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.reply_received', 'They replied on LinkedIn', now())", [opp]));
    const bot = await createWorker(ws.workspaceId);
    await admin(`insert into public.approvals (workspace_id, opportunity_id, action_type, summary, payload, proposed_by_worker_id, expires_at)
                 values ($1,$2,'send_message','Reply to partner','{"to":["a@b.test"]}',$3, now() + interval '1 day')`, [ws.workspaceId, opp, bot]);
    const d = await json(ws.ownerId, "select public.ui_daily($1) as r", [ws.workspaceId]);
    expect(d.pending_approvals).toHaveLength(1);
    expect(d.due).toHaveLength(1);
    expect(d.due[0].overdue).toBe(true);
    expect(d.changes.map((c: any) => c.summary)).toEqual(["They replied on LinkedIn"]);
  });

  it("members list shows co-members only", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    expect(await json(a.ownerId, "select public.ui_members($1) as r", [b.workspaceId])).toEqual([]);
    const mine = await json(a.ownerId, "select public.ui_members($1) as r", [a.workspaceId]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ role: "owner", is_you: true });
  });
});

describe("bot administration", () => {
  it("only owners/admins can pause a bot or change its limits", async () => {
    const ws = await createWorkspace();
    const member = await addMember(ws.workspaceId, "member");
    const bot = await createWorker(ws.workspaceId);
    await expectPgError(asUser(member, (q) => q("select public.set_worker_settings($1, 'paused', 1, 10)", [bot])), "not authorized");
    await asUser(ws.ownerId, (q) => q("select public.set_worker_settings($1, 'paused', 2, 25)", [bot]));
    const { rows } = await admin("select status, max_concurrent_tasks, daily_action_budget from public.worker_identities where id = $1", [bot]);
    expect(rows[0]).toEqual({ status: "paused", max_concurrent_tasks: 2, daily_action_budget: 25 });
  });
});
