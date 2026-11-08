// The TypeScript vocabulary used by the UI must match the database exactly.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATUSES, CHANNEL_KINDS, CONNECTION_STATUSES, DISPOSITIONS, MEMBER_ROLES, MILESTONES, STAGES, TASK_STATUSES,
} from "../../packages/domain/src/vocabulary";
import { admin } from "./helpers";

async function enumValues(name: string): Promise<string[]> {
  const { rows } = await admin(
    "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder",
    [name],
  );
  return rows.map((r) => r.enumlabel);
}

describe("domain vocabulary matches database enums", () => {
  it.each([
    ["channel_kind", CHANNEL_KINDS],
    ["opportunity_stage", STAGES],
    ["opportunity_disposition", DISPOSITIONS],
    ["member_role", MEMBER_ROLES],
    ["approval_status", APPROVAL_STATUSES],
    ["task_status", TASK_STATUSES],
    ["connection_status", CONNECTION_STATUSES],
  ])("%s", async (name, values) => {
    expect(await enumValues(name)).toEqual([...values]);
  });

  it("channel milestones", async () => {
    const { rows } = await admin("select channel_kind, key from public.channel_milestones order by channel_kind, ordinal");
    const fromDb: Record<string, string[]> = {};
    for (const r of rows) (fromDb[r.channel_kind] ??= []).push(r.key);
    const fromTs = Object.fromEntries(Object.entries(MILESTONES).map(([k, v]) => [k, v.map((m) => m.key)]));
    expect(fromDb).toEqual(fromTs);
  });
});
