// Creates a throwaway database, loads the Supabase test stub, then applies every
// migration in supabase/migrations in order — exactly as `supabase db push` would.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const root = resolve(__dirname, "../..");
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:54329/postgres";

export default async function setup() {
  const dbName = `ops_test_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(readFileSync(join(root, "supabase/tests/support/supabase_stub.sql"), "utf8"));
  const dir = join(root, "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await client.query("begin");
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  await client.end();
  process.env.TEST_DATABASE_URL = url.toString();

  return async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`drop database if exists ${dbName} with (force)`);
    await a.end();
  };
}
