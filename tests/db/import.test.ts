// The spreadsheet import loader (public.import_apply): idempotent, provenance-linked,
// never moves real later work backwards, and doesn't flood the audit trail.
import { beforeAll, describe, expect, it } from "vitest";
import { localServiceDb, type ServiceDb } from "../../apps/web/lib/service-db";
import { addMember, admin, asUser, createWorkspace, expectPgError, type WorkspaceFixture } from "./helpers";

let db: ServiceDb;
beforeAll(async () => { db = await localServiceDb(process.env.TEST_DATABASE_URL as string); });

const src = { file: "Affiliates.xlsx", tab: "Prospects", row: 2 };
const plan = {
  source_rows: [{ file: "Affiliates.xlsx", tab: "Prospects", row: 2, values: { Name: "Catch My Party", Status: "Contacted" }, formulas: {}, notes: {},
    links: [{ column: "Website", text: "catchmyparty.com", url: "https://www.catchmyparty.com" }], checksum: "c1" }],
  orgs: [{ key: "org:domain:catchmyparty.com", name: "Catch My Party", website: "https://www.catchmyparty.com", domain: "catchmyparty.com",
    parentKey: null, location: "US", country: null, notes: null, sources: [src], aliases: [{ alias: "Catch My Party Vendor Directory", justification: "Same website domain catchmyparty.com" }] }],
  contacts: [{ key: "contact:email:jillian@catchmyparty.com", orgKey: "org:domain:catchmyparty.com", name: "Jillian", title: "Founder", sources: [src],
    identities: [{ kind: "email", value: "jillian@catchmyparty.com", normalized: "jillian@catchmyparty.com", verified: true, verificationSource: "Verified on site" }] }],
  opps: [{ key: "opp:affiliates:org:domain:catchmyparty.com", channel: "affiliates", orgKey: "org:domain:catchmyparty.com",
    primaryContactKey: "contact:email:jillian@catchmyparty.com", sources: [src], contactKeys: [], details: { imported: { sheet_status: "Contacted" } } }],
  events: [{ key: "event:ledger:x:sent", oppKey: "opp:affiliates:org:domain:catchmyparty.com", eventType: "message.sent", at: "2026-11-05T15:31:00.000Z",
    precision: "minute", timezone: "Asia/Jerusalem", rawTime: "2026-11-05 17:31 Asia/Jerusalem", summary: "Instantly email", source: src,
    message: { provider: "instantly", providerMessageId: null, direction: "outbound", status: "sent", isAutomatic: null, to: ["jillian@catchmyparty.com"] }, assessments: [] }],
  finalize: [{ oppKey: "opp:affiliates:org:domain:catchmyparty.com", stage: "contacted", stageEvidenceKey: "event:ledger:x:sent", disposition: null, milestone: null,
    nextAction: "Follow up", nextActionDue: null, lastVerifiedKey: null, lastVerifiedAt: null }],
  offers: [{ key: "offer:x", oppKey: "opp:affiliates:org:domain:catchmyparty.com", kind: "affiliate_terms", terms: "15%", amount: null, currency: null, isPaid: false, status: "proposed", source: src }],
  tasks: [{ key: "import-task:x", kind: "verification.check", title: "Verify something", channel: "affiliates", oppKey: "opp:affiliates:org:domain:catchmyparty.com", details: {} }],
};

async function runImport(ws: WorkspaceFixture, p: Record<string, unknown[]> = plan) {
  const batch = await db.call<string>("import_begin", { p_workspace_id: ws.workspaceId, p_user_id: ws.ownerId, p_meta: {} });
  const out: Record<string, { created: number; existing: number }> = {};
  for (const kind of ["source_rows", "orgs", "contacts", "opps", "events", "finalize", "offers", "tasks"]) {
    out[kind] = await db.call("import_apply", { p_workspace_id: ws.workspaceId, p_batch_id: batch, p_kind: kind, p_items: p[kind] ?? [] });
  }
  await db.call("import_finish", { p_batch_id: batch, p_status: "completed", p_report: {} });
  return out;
}

describe("spreadsheet import", () => {
  it("creates linked, provenance-backed records with an evidence-backed stage and no audit noise", async () => {
    const ws = await createWorkspace();
    await runImport(ws);
    const opp = (await admin(`select o.stage, o.next_action, e.event_type, e.actor_kind, e.source_row_id is not null as has_source,
      (select count(*)::int from organization_aliases a where a.organization_id = o.organization_id) aliases,
      (select count(*)::int from source_row_targets t where t.workspace_id = o.workspace_id) targets,
      (select count(*)::int from source_links l where l.workspace_id = o.workspace_id) links,
      (select count(*)::int from activity_events a where a.opportunity_id = o.id and a.event_type like 'opportunity.%') audit
      from opportunities o join activity_events e on e.id = o.stage_evidence_event_id where o.workspace_id = $1`, [ws.workspaceId])).rows[0];
    expect(opp).toEqual({ stage: "contacted", next_action: "Follow up", event_type: "message.sent", actor_kind: "import", has_source: true, aliases: 1, targets: 3, links: 1, audit: 0 });
  });

  it("running it again changes nothing", async () => {
    const ws = await createWorkspace();
    await runImport(ws);
    const second = await runImport(ws);
    for (const k of ["source_rows", "orgs", "contacts", "opps", "events", "offers", "tasks"]) expect(second[k].created, k).toBe(0);
    const n = (await admin(`select (select count(*) from organizations where workspace_id=$1)::int o, (select count(*) from activity_events where workspace_id=$1)::int e,
      (select count(*) from messages where workspace_id=$1)::int m, (select count(*) from source_rows where workspace_id=$1)::int r, (select count(*) from tasks where workspace_id=$1)::int t`, [ws.workspaceId])).rows[0];
    expect(n).toEqual({ o: 1, e: 1, m: 1, r: 1, t: 1 });
  });

  it("never moves later real work backwards, and archives a changed source row as a new version", async () => {
    const ws = await createWorkspace();
    await runImport(ws);
    const oppId = (await admin("select id from opportunities where workspace_id = $1", [ws.workspaceId])).rows[0].id;
    const ev = (await asUser(ws.ownerId, (q) => q("select public.record_activity($1, 'manual.reply_received', 'Jillian replied', now()) as id", [oppId]))).rows[0].id;
    await asUser(ws.ownerId, (q) => q("select public.set_opportunity_stage($1, 'replied', $2)", [oppId, ev]));
    await asUser(ws.ownerId, (q) => q("select public.set_opportunity_plan($1, 'Call Jillian', null, null, null)", [oppId]));
    const changed = { ...plan, source_rows: [{ ...plan.source_rows[0], values: { Name: "Catch My Party", Status: "Replied" }, checksum: "c2" }] };
    const r = await runImport(ws, changed);
    expect(r.source_rows.created).toBe(1);
    const o = (await admin("select stage, next_action from opportunities where id = $1", [oppId])).rows[0];
    expect(o).toEqual({ stage: "replied", next_action: "Call Jillian" });
  });

  it("reuses an existing organization with the same domain and keeps a verified email with its owner", async () => {
    const ws = await createWorkspace();
    const org = (await admin("insert into organizations (workspace_id, name, primary_domain) values ($1,'CMP (added by a bot)','catchmyparty.com') returning id", [ws.workspaceId])).rows[0].id;
    const other = (await admin("insert into contacts (workspace_id, organization_id, full_name) values ($1,$2,'Someone') returning id", [ws.workspaceId, org])).rows[0].id;
    await admin(`insert into contact_identities (workspace_id, contact_id, kind, value, normalized_value, is_verified, verified_at)
                 values ($1,$2,'email','jillian@catchmyparty.com','jillian@catchmyparty.com',true,now())`, [ws.workspaceId, other]);
    await runImport(ws);
    const n = (await admin("select count(*)::int c from organizations where workspace_id = $1", [ws.workspaceId])).rows[0].c;
    expect(n).toBe(1);
    const owner = (await admin("select contact_id from contact_identities where workspace_id = $1 and normalized_value = 'jillian@catchmyparty.com' and is_verified", [ws.workspaceId])).rows;
    expect(owner).toEqual([{ contact_id: other }]);
  });

  it("only owners/admins can start an import, and only the backend can write", async () => {
    const ws = await createWorkspace();
    const member = await addMember(ws.workspaceId, "member");
    await expectPgError(db.call("import_begin", { p_workspace_id: ws.workspaceId, p_user_id: member, p_meta: {} }), "only owners and admins");
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.import_apply($1, gen_random_uuid(), 'orgs', '[]')", [ws.workspaceId])), "permission denied");
  });
});

describe("abandoned imports", () => {
  it("a new import marks attempts abandoned for 15+ minutes as failed", async () => {
    const ws = await createWorkspace();
    const old = await db.call<string>("import_begin", { p_workspace_id: ws.workspaceId, p_user_id: ws.ownerId, p_meta: {} });
    await admin("update import_batches set started_at = now() - interval '1 hour' where id = $1", [old]);
    const fresh = await db.call<string>("import_begin", { p_workspace_id: ws.workspaceId, p_user_id: ws.ownerId, p_meta: {} });
    const rows = (await admin("select id, status from import_batches where workspace_id = $1", [ws.workspaceId])).rows;
    expect(rows.find((r) => r.id === old)?.status).toBe("failed");
    expect(rows.find((r) => r.id === fresh)?.status).toBe("running");
  });
});
