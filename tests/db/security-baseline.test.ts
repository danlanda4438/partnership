// Structural guarantees that must hold for every table, view and function — including
// ones added by future migrations.
import { describe, expect, it } from "vitest";
import { admin } from "./helpers";

const ALLOWED_PUBLIC_SECURITY_DEFINER = ["cancel_task", "create_worker", "decide_approval", "issue_worker_token", "revoke_worker_token", "set_member_role", "set_worker_channels", "ui_members", "ui_worker_tokens"];

describe("security baseline", () => {
  it("enables RLS on every table in exposed schema public", async () => {
    const { rows } = await admin(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("gives the anon role no privileges on any public table or view", async () => {
    const { rows } = await admin(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'`);
    expect(rows).toEqual([]);
  });

  it("never lets API roles delete rows directly", async () => {
    const { rows } = await admin(`
      select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('DELETE','TRUNCATE')`);
    expect(rows).toEqual([]);
  });

  it("makes every view security_invoker", async () => {
    const { rows } = await admin(`
      select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.reloptions ?? []).toContain("security_invoker=true");
  });

  it("limits SECURITY DEFINER functions in public to the reviewed allowlist", async () => {
    const { rows } = await admin(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef order by 1`);
    expect(rows.map((r) => r.proname)).toEqual(ALLOWED_PUBLIC_SECURITY_DEFINER);
  });

  it("pins search_path on every SECURITY DEFINER function", async () => {
    const { rows } = await admin(`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it("does not let anon execute any public function", async () => {
    const { rows } = await admin(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it("keeps backend-only functions away from signed-in users", async () => {
    for (const fn of [
      "private.claim_task(uuid,uuid,integer)",
      "private.report_task(uuid,uuid,text,text,jsonb,jsonb)",
      "private.begin_approval_execution(uuid,text,text)",
      "private.finish_approval_execution(uuid,text,jsonb)",
      "private.expire_leases()",
    ]) {
      const { rows } = await admin(`select has_function_privilege('authenticated', $1, 'execute') as ok`, [fn]);
      expect(rows[0].ok, fn).toBe(false);
    }
  });

  it("does not expose worker credential hashes", async () => {
    const { rows } = await admin(
      `select has_table_privilege('authenticated', 'private.worker_credentials', 'select') as ok`,
    );
    expect(rows[0].ok).toBe(false);
  });
});
