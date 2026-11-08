import { describe, expect, it } from "vitest";
import {
  addMember, admin, asAnon, asUser, createOpportunity, createOrg, createWorkspace, expectPgError,
} from "./helpers";

describe("workspace isolation", () => {
  it("members only see their own workspace's records, including through views", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await createOpportunity(a.workspaceId, a.channels.affiliates);
    await createOpportunity(b.workspaceId, b.channels.listings);

    await asUser(a.ownerId, async (q) => {
      for (const table of ["workspaces", "channels", "organizations", "opportunities", "opportunity_pipeline", "channel_stage_counts"]) {
        const { rows } = await q(`select distinct ${table === "workspaces" ? "id" : "workspace_id"} as ws from public.${table}`);
        expect(rows.map((r) => r.ws), table).toEqual([a.workspaceId]);
      }
    });
  });

  it("creates the four channels for every workspace", async () => {
    const a = await createWorkspace();
    expect(Object.keys(a.channels).sort()).toEqual(["affiliates", "co_marketing", "listings", "media_pr"]);
  });

  it("anonymous requests see nothing and cannot write", async () => {
    const a = await createWorkspace();
    await createOrg(a.workspaceId);
    await expectPgError(asAnon((q) => q("select * from public.organizations")), "permission denied");
    await expectPgError(
      asAnon((q) => q("insert into public.organizations (workspace_id, name) values ($1, 'x')", [a.workspaceId])),
      "permission denied",
    );
  });

  it("a member cannot write into another workspace", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await expectPgError(
      asUser(a.ownerId, (q) => q("insert into public.organizations (workspace_id, name) values ($1, 'intruder')", [b.workspaceId])),
      "row-level security",
    );
  });

  it("cannot link a record to another workspace's row even with a known id", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const foreignOrg = await createOrg(b.workspaceId);
    await expectPgError(
      asUser(a.ownerId, (q) => q("insert into public.contacts (workspace_id, organization_id, full_name) values ($1, $2, 'x')", [a.workspaceId, foreignOrg])),
      "foreign key",
    );
  });

  it("cannot move a record to another workspace by updating workspace_id", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const org = await createOrg(a.workspaceId);
    await expectPgError(
      asUser(a.ownerId, (q) => q("update public.organizations set workspace_id = $1 where id = $2", [b.workspaceId, org])),
      "row-level security",
    );
  });

  it("viewers can read but not write", async () => {
    const a = await createWorkspace();
    const viewer = await addMember(a.workspaceId, "viewer");
    const org = await createOrg(a.workspaceId, "Visible");
    const { rows } = await asUser(viewer, (q) => q("select name from public.organizations where id = $1", [org]));
    expect(rows).toEqual([{ name: "Visible" }]);
    await expectPgError(
      asUser(viewer, (q) => q("insert into public.organizations (workspace_id, name) values ($1, 'x')", [a.workspaceId])),
      "row-level security",
    );
    const upd = await asUser(viewer, (q) => q("update public.organizations set name = 'changed' where id = $1", [org]));
    expect(upd.rowCount).toBe(0);
  });

  it("no one can delete operational records through the API", async () => {
    const a = await createWorkspace();
    const org = await createOrg(a.workspaceId);
    await expectPgError(asUser(a.ownerId, (q) => q("delete from public.organizations where id = $1", [org])), "permission denied");
  });
});

describe("membership changes take effect immediately", () => {
  it("a revoked member loses access on the next request, whatever their token says", async () => {
    const a = await createWorkspace();
    const member = await addMember(a.workspaceId, "member");
    await createOrg(a.workspaceId);
    expect((await asUser(member, (q) => q("select id from public.organizations"))).rowCount).toBe(1);

    const { rows } = await admin("select id from public.workspace_members where user_id = $1", [member]);
    await asUser(a.ownerId, (q) => q("select public.set_member_role($1, 'member', 'revoked')", [rows[0].id]));

    expect((await asUser(member, (q) => q("select id from public.organizations"))).rowCount).toBe(0);
    expect((await asUser(member, (q) => q("select id from public.workspaces"))).rowCount).toBe(0);
  });

  it("a downgraded admin immediately loses admin powers", async () => {
    const a = await createWorkspace();
    const adminUser = await addMember(a.workspaceId, "admin");
    const { rows } = await admin("select id from public.workspace_members where user_id = $1", [adminUser]);
    await asUser(a.ownerId, (q) => q("select public.set_member_role($1, 'viewer', 'active')", [rows[0].id]));
    const upd = await asUser(adminUser, (q) => q("update public.workspaces set name = 'hijack' where id = $1", [a.workspaceId]));
    expect(upd.rowCount).toBe(0);
  });

  it("members cannot change roles, admins cannot make owners, and the last owner stays", async () => {
    const a = await createWorkspace();
    const member = await addMember(a.workspaceId, "member");
    const adminUser = await addMember(a.workspaceId, "admin");
    const ids = await admin("select id, user_id from public.workspace_members where workspace_id = $1", [a.workspaceId]);
    const idOf = (u: string) => ids.rows.find((r) => r.user_id === u)!.id;

    await expectPgError(asUser(member, (q) => q("select public.set_member_role($1, 'owner', 'active')", [idOf(member)])), "not authorized");
    await expectPgError(asUser(adminUser, (q) => q("select public.set_member_role($1, 'owner', 'active')", [idOf(adminUser)])), "only owners");
    await expectPgError(asUser(a.ownerId, (q) => q("select public.set_member_role($1, 'admin', 'active')", [idOf(a.ownerId)])), "last owner");
  });

  it("users cannot edit their own membership rows directly", async () => {
    const a = await createWorkspace();
    const member = await addMember(a.workspaceId, "member");
    await expectPgError(
      asUser(member, (q) => q("update public.workspace_members set role = 'owner' where user_id = $1", [member])),
      "permission denied",
    );
  });

  it("a paused worker setting is admin-only", async () => {
    const a = await createWorkspace();
    const member = await addMember(a.workspaceId, "member");
    const { rows } = await admin("insert into public.worker_identities (workspace_id, name, role) values ($1, 'Soled', 'coordinator') returning id", [a.workspaceId]);
    const byMember = await asUser(member, (q) => q("update public.worker_identities set status = 'paused' where id = $1", [rows[0].id]));
    expect(byMember.rowCount).toBe(0);
    const byOwner = await asUser(a.ownerId, (q) => q("update public.worker_identities set status = 'paused' where id = $1", [rows[0].id]));
    expect(byOwner.rowCount).toBe(1);
  });
});
