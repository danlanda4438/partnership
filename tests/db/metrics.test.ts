// The brief's counting rules: contacts, organizations, opportunities and message events are
// different things, and must never be summed into one another.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admin, asUser, createOpportunity, createOrg, createWorkspace, type WorkspaceFixture } from "./helpers";

type Row = Record<string, any>;
async function metrics(ws: WorkspaceFixture, from?: string, to?: string): Promise<Record<string, Row>> {
  const { rows } = await asUser(ws.ownerId, (q) =>
    q("select * from public.workspace_metrics($1, $2, $3)", [ws.workspaceId, from ?? null, to ?? null]));
  return Object.fromEntries(rows.map((r) => [r.scope, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v]))]));
}

async function contact(ws: WorkspaceFixture, orgId: string, name: string) {
  return (await admin("insert into public.contacts (workspace_id, organization_id, full_name) values ($1,$2,$3) returning id",
    [ws.workspaceId, orgId, name])).rows[0].id as string;
}

async function message(ws: WorkspaceFixture, o: { opp?: string | null; contact?: string | null; direction: "outbound" | "inbound";
  status: string; automatic?: boolean | null; at?: string | null }) {
  return (await admin(
    `insert into public.messages (workspace_id, opportunity_id, contact_id, provider, provider_message_id, direction, status,
       is_automatic, occurred_at, occurred_at_precision)
     values ($1,$2,$3,'gmail',$4,$5,$6,$7,$8, case when $8::timestamptz is null then 'unknown' else 'exact' end::public.timestamp_precision)
     returning id`,
    [ws.workspaceId, o.opp ?? null, o.contact ?? null, randomUUID(), o.direction, o.status, o.automatic ?? null,
     o.at === undefined ? "2026-10-01T10:00:00Z" : o.at])).rows[0].id as string;
}

async function setStage(ws: WorkspaceFixture, opp: string, stage: string) {
  const ev = (await admin(
    `insert into public.activity_events (workspace_id, opportunity_id, event_type, source, actor_kind)
     values ($1,$2,'message.sent','test','system') returning id`, [ws.workspaceId, opp])).rows[0].id;
  await admin("update public.opportunities set stage = $2, stage_evidence_event_id = $3 where id = $1", [opp, stage, ev]);
}

describe("workspace_metrics", () => {
  it("separates opportunities, organizations, contacts and message events, and de-duplicates across channels", async () => {
    const ws = await createWorkspace();
    const hq = await createOrg(ws.workspaceId, "Venue Group HQ");
    // One organization engaged in two channels
    const oppA = await createOpportunity(ws.workspaceId, ws.channels.co_marketing, hq);
    const oppB = await createOpportunity(ws.workspaceId, ws.channels.affiliates, hq);
    await setStage(ws, oppA, "contacted");
    await setStage(ws, oppB, "contacted");
    // Two distinct people at the same HQ
    const alice = await contact(ws, hq, "Alice");
    const bob = await contact(ws, hq, "Bob");
    // Alice emailed in both channels, twice in co-marketing; Bob once
    await message(ws, { opp: oppA, contact: alice, direction: "outbound", status: "sent" });
    await message(ws, { opp: oppA, contact: alice, direction: "outbound", status: "delivered" });
    await message(ws, { opp: oppB, contact: alice, direction: "outbound", status: "sent" });
    await message(ws, { opp: oppA, contact: bob, direction: "outbound", status: "sent" });

    const m = await metrics(ws);
    expect(m.co_marketing).toMatchObject({ opportunities: 1, organizations_engaged: 1, contacts_reached: 2, message_events: 3 });
    expect(m.affiliates).toMatchObject({ opportunities: 1, organizations_engaged: 1, contacts_reached: 1, message_events: 1 });
    // 'all' is distinct across channels — not the sum of channel rows
    expect(m.all).toMatchObject({ opportunities: 2, organizations_engaged: 1, contacts_reached: 2, message_events: 4 });
  });

  it("counts separate venue locations as separate organizations", async () => {
    const ws = await createWorkspace();
    const parent = await createOrg(ws.workspaceId, "Chain");
    const loc = async (label: string) => (await admin(
      "insert into public.organizations (workspace_id, name, parent_organization_id, location_label) values ($1,'Chain',$2,$3) returning id",
      [ws.workspaceId, parent, label])).rows[0].id;
    for (const l of ["Tel Aviv", "Haifa"]) await setStage(ws, await createOpportunity(ws.workspaceId, ws.channels.co_marketing, await loc(l)), "contacted");
    expect((await metrics(ws)).co_marketing.organizations_engaged).toBe(2);
  });

  it("drafts never count as contact or message events; inventory stays outside the funnel", async () => {
    const ws = await createWorkspace();
    const org = await createOrg(ws.workspaceId);
    const opp = await createOpportunity(ws.workspaceId, ws.channels.listings, org);
    const c = await contact(ws, org, "Carol");
    await message(ws, { opp, contact: c, direction: "outbound", status: "draft" });
    const m = await metrics(ws);
    expect(m.listings).toMatchObject({ opportunities: 0, inventory: 1, contacts_reached: 0, message_events: 0, drafts: 1, outbound_attempts: 0 });
  });

  it("separates attempts, acceptance, bounces, failures and uncertain outcomes", async () => {
    const ws = await createWorkspace();
    const org = await createOrg(ws.workspaceId);
    const opp = await createOpportunity(ws.workspaceId, ws.channels.media_pr, org);
    const c = await contact(ws, org, "Dana");
    for (const status of ["sent", "delivered", "bounced", "failed", "uncertain"]) {
      await message(ws, { opp, contact: c, direction: "outbound", status });
    }
    expect((await metrics(ws)).media_pr).toMatchObject({
      outbound_attempts: 5, outbound_accepted: 2, bounced: 1, failed: 1, uncertain: 1, contacts_reached: 1,
    });
  });

  it("separates human replies from automatic responses and unassessed ones", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
    await message(ws, { opp, direction: "inbound", status: "received", automatic: false });
    await message(ws, { opp, direction: "inbound", status: "received", automatic: true });
    await message(ws, { opp, direction: "inbound", status: "received", automatic: true });
    await message(ws, { opp, direction: "inbound", status: "received", automatic: null });
    expect((await metrics(ws)).affiliates).toMatchObject({ inbound_messages: 4, human_replies: 1, automatic_replies: 2, unassessed_replies: 1 });
  });

  it("12 imported Instantly 'Interested' labels stay 12 platform labels, not 12 deals", async () => {
    const ws = await createWorkspace();
    for (let i = 0; i < 12; i++) {
      const opp = await createOpportunity(ws.workspaceId, ws.channels.affiliates);
      await setStage(ws, opp, "replied");
      const msg = await message(ws, { opp, direction: "inbound", status: "received", automatic: false });
      await admin(`insert into public.reply_assessments (workspace_id, message_id, source, platform_label)
                   values ($1,$2,'platform','Interested')`, [ws.workspaceId, msg]);
      if (i < 2) {
        await admin(`insert into public.reply_assessments (workspace_id, message_id, source, classification, conditions)
                     values ($1,$2,'human','paid_only','Only paid placements')`, [ws.workspaceId, msg]);
      }
    }
    const a = (await metrics(ws)).affiliates;
    expect(a.platform_positive_labels).toBe(12);
    expect(a.paid_only_replies).toBe(2);
    expect(a.by_stage).toEqual({ replied: 12 });
    expect(a.by_stage.agreed).toBeUndefined();
  });

  it("date filters exclude undated history and report it separately", async () => {
    const ws = await createWorkspace();
    const opp = await createOpportunity(ws.workspaceId, ws.channels.listings);
    await message(ws, { opp, direction: "outbound", status: "sent", at: "2026-09-15T10:00:00Z" });
    await message(ws, { opp, direction: "outbound", status: "sent", at: "2026-10-15T10:00:00Z" });
    await message(ws, { opp, direction: "outbound", status: "sent", at: null });
    const all = await metrics(ws);
    expect(all.listings).toMatchObject({ message_events: 3, undated_messages: 1 });
    const oct = await metrics(ws, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
    expect(oct.listings).toMatchObject({ message_events: 1, undated_messages: 1 });
  });

  it("messages not linked to an opportunity are reported as unassigned, not dropped", async () => {
    const ws = await createWorkspace();
    await message(ws, { direction: "inbound", status: "received", automatic: false });
    const m = await metrics(ws);
    expect(m.unassigned.inbound_messages).toBe(1);
    expect(m.all.inbound_messages).toBe(1);
  });

  it("returns only zeros for a workspace the caller does not belong to", async () => {
    const mine = await createWorkspace();
    const other = await createWorkspace();
    const opp = await createOpportunity(other.workspaceId, other.channels.affiliates);
    await setStage(other, opp, "contacted");
    const { rows } = await asUser(mine.ownerId, (q) => q("select * from public.workspace_metrics($1)", [other.workspaceId]));
    expect(rows.every((r) => Number(r.opportunities) === 0 && Number(r.inventory) === 0)).toBe(true);
  });
});
