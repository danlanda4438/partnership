import { randomUUID } from "node:crypto";
import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Superuser access, used only to arrange fixtures (stands in for migration/import tooling). */
export const admin: Q = (sql, params) => pool.query(sql, params);

async function withRole<T>(role: string, claims: Record<string, unknown> | null, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    if (claims) await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Runs queries exactly as a signed-in browser user would reach them through the Supabase Data API. */
export const asUser = <T>(userId: string, fn: (q: Q) => Promise<T>) =>
  withRole("authenticated", { sub: userId, role: "authenticated" }, fn);
export const asAnon = <T>(fn: (q: Q) => Promise<T>) => withRole("anon", { role: "anon" }, fn);
/** The application backend (secret key). Bypasses RLS; used by MCP server / workers. */
export const asService = <T>(fn: (q: Q) => Promise<T>) => withRole("service_role", { role: "service_role" }, fn);

export async function createUser(label = "user"): Promise<string> {
  const { rows } = await admin("insert into auth.users (email) values ($1) returning id", [
    `${label}-${randomUUID()}@example.test`,
  ]);
  return rows[0].id;
}

export interface WorkspaceFixture {
  workspaceId: string;
  ownerId: string;
  channels: Record<"affiliates" | "co_marketing" | "media_pr" | "listings", string>;
}

export async function createWorkspace(): Promise<WorkspaceFixture> {
  const ownerId = await createUser("owner");
  const slug = `ws-${randomUUID().slice(0, 12)}`;
  const { rows } = await admin("insert into public.workspaces (name, slug) values ($1, $1) returning id", [slug]);
  const workspaceId = rows[0].id;
  await admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [
    workspaceId,
    ownerId,
  ]);
  const ch = await admin("select id, kind from public.channels where workspace_id = $1", [workspaceId]);
  const channels = Object.fromEntries(ch.rows.map((r) => [r.kind, r.id])) as WorkspaceFixture["channels"];
  return { workspaceId, ownerId, channels };
}

export async function addMember(workspaceId: string, role: "owner" | "admin" | "member" | "viewer"): Promise<string> {
  const userId = await createUser(role);
  await admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [
    workspaceId,
    userId,
    role,
  ]);
  return userId;
}

export async function createOrg(workspaceId: string, name = "Org"): Promise<string> {
  const { rows } = await admin("insert into public.organizations (workspace_id, name) values ($1, $2) returning id", [
    workspaceId,
    name,
  ]);
  return rows[0].id;
}

export async function createOpportunity(workspaceId: string, channelId: string, orgId?: string): Promise<string> {
  const organizationId = orgId ?? (await createOrg(workspaceId));
  const { rows } = await admin(
    "insert into public.opportunities (workspace_id, channel_id, organization_id) values ($1, $2, $3) returning id",
    [workspaceId, channelId, organizationId],
  );
  return rows[0].id;
}

export async function createWorker(
  workspaceId: string,
  opts: { channelIds?: string[]; capabilities?: string[]; maxConcurrent?: number; name?: string } = {},
): Promise<string> {
  const { rows } = await admin(
    `insert into public.worker_identities (workspace_id, name, role, capabilities, max_concurrent_tasks)
     values ($1, $2, 'test', $3, $4) returning id`,
    [workspaceId, opts.name ?? `bot-${randomUUID().slice(0, 8)}`, opts.capabilities ?? [], opts.maxConcurrent ?? 5],
  );
  for (const channelId of opts.channelIds ?? []) {
    await admin("insert into public.worker_channel_scopes (workspace_id, worker_id, channel_id) values ($1, $2, $3)", [
      workspaceId,
      rows[0].id,
      channelId,
    ]);
  }
  return rows[0].id;
}

export async function expectPgError(promise: Promise<unknown>, pattern?: RegExp | string): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { code?: string };
    if (pattern && !(typeof pattern === "string" ? e.message.includes(pattern) : pattern.test(e.message))) {
      throw new Error(`expected error matching ${pattern}, got: ${e.message}`);
    }
    return e;
  }
  throw new Error(`expected query to fail${pattern ? ` with ${pattern}` : ""}, but it succeeded`);
}
