import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMember, admin, asUser, createWorkspace, expectPgError } from "./helpers";

describe("private attachments", () => {
  it("the attachments bucket is private", async () => {
    const { rows } = await admin("select public from storage.buckets where id = 'attachments'");
    expect(rows).toEqual([{ public: false }]);
  });

  it("members read only their workspace's objects", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await admin("insert into storage.objects (bucket_id, name) values ('attachments', $1), ('attachments', $2)", [
      `${a.workspaceId}/${randomUUID()}/io.pdf`,
      `${b.workspaceId}/${randomUUID()}/secret.pdf`,
    ]);
    const { rows } = await asUser(a.ownerId, (q) => q("select name from storage.objects"));
    expect(rows).toHaveLength(1);
    expect(rows[0].name.startsWith(a.workspaceId)).toBe(true);
  });

  it("viewers cannot upload and nobody can upload into another workspace's folder", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const viewer = await addMember(a.workspaceId, "viewer");
    await expectPgError(
      asUser(viewer, (q) => q("insert into storage.objects (bucket_id, name) values ('attachments', $1)", [`${a.workspaceId}/x/file.pdf`])),
      "row-level security",
    );
    await expectPgError(
      asUser(a.ownerId, (q) => q("insert into storage.objects (bucket_id, name) values ('attachments', $1)", [`${b.workspaceId}/x/file.pdf`])),
      "row-level security",
    );
    await asUser(a.ownerId, (q) => q("insert into storage.objects (bucket_id, name) values ('attachments', $1)", [`${a.workspaceId}/x/file.pdf`]));
  });

  it("attachment metadata must point inside its own workspace folder", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await expectPgError(
      asUser(a.ownerId, (q) => q("insert into public.attachments (workspace_id, storage_path, file_name) values ($1, $2, 'f.pdf')", [a.workspaceId, `${b.workspaceId}/x/f.pdf`])),
      "check constraint",
    );
  });
});
