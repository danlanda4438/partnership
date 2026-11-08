import { describe, expect, it } from "vitest";
import { admin, asUser, createOpportunity, createOrg, createWorkspace, createWorker, expectPgError } from "./helpers";

async function recordEvent(userId: string, workspaceId: string, opportunityId: string, externalId: string | null = null) {
  const { rows } = await asUser(userId, (q) =>
    q(
      `insert into public.activity_events (workspace_id, opportunity_id, event_type, source, external_event_id,
         occurred_at, occurred_at_precision, actor_kind)
       values ($1, $2, 'message.sent', 'manual', $3, now(), 'exact', 'user') returning id`,
      [workspaceId, opportunityId, externalId],
    ),
  );
  return rows[0].id as string;
}

describe("evidence-backed stages", () => {
  it("rejects a funnel stage without evidence, and there is no research stage", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.affiliates);
    await expectPgError(asUser(a.ownerId, (q) => q("update public.opportunities set stage = 'contacted' where id = $1", [opp])), "check constraint");
    await expectPgError(asUser(a.ownerId, (q) => q("update public.opportunities set stage = 'research' where id = $1", [opp])), "invalid input value");
  });

  it("accepts a stage backed by an event of the same opportunity only", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.affiliates);
    const other = await createOpportunity(a.workspaceId, a.channels.affiliates);
    const otherEvent = await recordEvent(a.ownerId, a.workspaceId, other);
    await expectPgError(
      asUser(a.ownerId, (q) => q("update public.opportunities set stage = 'contacted', stage_evidence_event_id = $2 where id = $1", [opp, otherEvent])),
      "stage evidence",
    );
    const ev = await recordEvent(a.ownerId, a.workspaceId, opp);
    await asUser(a.ownerId, (q) => q("update public.opportunities set stage = 'contacted', stage_evidence_event_id = $2 where id = $1", [opp, ev]));
    const { rows } = await admin("select stage, stage_changed_at from public.opportunities where id = $1", [opp]);
    expect(rows[0].stage).toBe("contacted");
    expect(rows[0].stage_changed_at).not.toBeNull();
  });

  it("only accepts milestones that belong to the opportunity's channel", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.listings);
    await expectPgError(asUser(a.ownerId, (q) => q("update public.opportunities set milestone_key = 'signed_io' where id = $1", [opp])), "not valid for channel");
    await asUser(a.ownerId, (q) => q("update public.opportunities set milestone_key = 'pending_review' where id = $1", [opp]));
  });
});

describe("append-only activity", () => {
  it("events cannot be edited or deleted by anyone, including the backend", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.media_pr);
    const ev = await recordEvent(a.ownerId, a.workspaceId, opp);
    await expectPgError(admin("update public.activity_events set summary = 'rewritten' where id = $1", [ev]), "append-only");
    await expectPgError(admin("delete from public.activity_events where id = $1", [ev]), "append-only");
  });

  it("replaying the same external event cannot create a duplicate", async () => {
    const a = await createWorkspace();
    const opp = await createOpportunity(a.workspaceId, a.channels.media_pr);
    await recordEvent(a.ownerId, a.workspaceId, opp, "gmail:abc123");
    await expectPgError(recordEvent(a.ownerId, a.workspaceId, opp, "gmail:abc123"), "duplicate key");
  });

  it("a user cannot record activity as a bot or as another person", async () => {
    const a = await createWorkspace();
    const worker = await createWorker(a.workspaceId);
    const { rows } = await asUser(a.ownerId, (q) =>
      q(`insert into public.activity_events (workspace_id, event_type, source, actor_kind, actor_worker_id)
         values ($1, 'note.added', 'manual', 'worker', $2) returning actor_kind, actor_user_id, actor_worker_id`, [a.workspaceId, worker]),
    );
    expect(rows[0]).toEqual({ actor_kind: "user", actor_user_id: a.ownerId, actor_worker_id: null });
  });

  it("never stores an invented precise time for an undated historical send", async () => {
    const a = await createWorkspace();
    await expectPgError(
      admin(`insert into public.activity_events (workspace_id, event_type, source, actor_kind, occurred_at_precision)
             values ($1, 'message.sent', 'import:test', 'import', 'exact')`, [a.workspaceId]),
      "check constraint",
    );
    await admin(`insert into public.activity_events (workspace_id, event_type, source, actor_kind)
                 values ($1, 'message.sent', 'import:test', 'import')`, [a.workspaceId]);
  });

  it("message content is immutable once stored; drafts are distinct from sends", async () => {
    const a = await createWorkspace();
    const { rows } = await admin(
      `insert into public.messages (workspace_id, provider, provider_message_id, direction, status, body_text)
       values ($1, 'gmail', 'm-1', 'outbound', 'draft', 'hello') returning id`, [a.workspaceId]);
    await expectPgError(admin("update public.messages set body_text = 'edited' where id = $1", [rows[0].id]), "immutable");
    await admin("update public.messages set status = 'sent' where id = $1", [rows[0].id]);
  });
});

describe("people and organization identity", () => {
  it("a verified email belongs to exactly one contact; distinct people at one org stay distinct", async () => {
    const a = await createWorkspace();
    const org = await createOrg(a.workspaceId, "Shared HQ");
    const mk = async (name: string) =>
      (await admin("insert into public.contacts (workspace_id, organization_id, full_name) values ($1, $2, $3) returning id", [a.workspaceId, org, name])).rows[0].id;
    const alice = await mk("Alice");
    const bob = await mk("Bob");
    const add = (contact: string, email: string, verified: boolean) =>
      admin(
        `insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value, is_verified, verified_at)
         values ($1, $2, 'email', $3, lower($3), $4, case when $4 then now() end)`, [a.workspaceId, contact, email, verified]);
    await add(alice, "alice@hq.test", true);
    await add(bob, "bob@hq.test", true);
    await expectPgError(add(bob, "Alice@HQ.test", true), "duplicate key");
    // An unverified claim of the same address is held for review rather than merged.
    await add(bob, "alice@hq.test", false);
    const { rows } = await admin("select count(*)::int as n from public.contacts where organization_id = $1", [org]);
    expect(rows[0].n).toBe(2);
  });

  it("organization aliases need a justification", async () => {
    const a = await createWorkspace();
    const org = await createOrg(a.workspaceId);
    await expectPgError(
      admin("insert into public.organization_aliases (workspace_id, organization_id, alias, justification) values ($1, $2, 'Alias', ' ')", [a.workspaceId, org]),
      "check constraint",
    );
  });
});

describe("views count organizations and opportunities separately", () => {
  it("two channel engagements with one organization are 2 opportunities, 1 organization", async () => {
    const a = await createWorkspace();
    const org = await createOrg(a.workspaceId, "Venue Group");
    await createOpportunity(a.workspaceId, a.channels.co_marketing, org);
    await createOpportunity(a.workspaceId, a.channels.co_marketing, org);
    const { rows } = await asUser(a.ownerId, (q) =>
      q("select opportunity_count::int, organization_count::int from public.channel_stage_counts where channel_kind = 'co_marketing'"));
    expect(rows).toEqual([{ opportunity_count: 2, organization_count: 1 }]);
  });
});
