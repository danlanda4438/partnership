// The single door between screens and the database.
//
// Production: calls Postgres functions through Supabase's API *as the signed-in user*
// (publishable key + session cookie), so Row Level Security applies to every read and write.
//
// Local development only: when GLEEDAY_LOCAL_DB_URL is set and NODE_ENV is "development",
// the same functions are called over a direct Postgres connection that switches to the
// `authenticated` role with the configured user's claims, exactly as Supabase's API does.
// That mode can never activate in a production build.
import { cache } from "react";
import { createClient } from "./supabase/server";

export class DataError extends Error {}

type SupabaseServerClient = NonNullable<Awaited<ReturnType<typeof createClient>>>;

export interface Db {
  userId: string;
  email: string;
  /** Calls a function that returns a single value (jsonb, uuid, void). */
  call<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls a set-returning function. */
  rows<T = Record<string, unknown>>(fn: string, args?: Record<string, unknown>): Promise<T[]>;
  /** Supabase client for storage (null in local development mode). */
  supabase: SupabaseServerClient | null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

// Database rules that fire as constraints rather than as written messages.
const CONSTRAINT_MESSAGES: [RegExp, string][] = [
  [/opportunities_stage_requires_evidence/, "A stage needs evidence: choose the timeline entry that shows it (record the activity first if it isn't there)."],
  [/opportunities_single_owner/, "An opportunity can have one owner: a person or a bot, not both."],
  [/contact_identities_verified_unique/, "That verified email or profile already belongs to another contact."],
  [/row-level security|permission denied/, "You don't have permission to do that."],
];

function friendly(message: string): string {
  for (const [pattern, text] of CONSTRAINT_MESSAGES) if (pattern.test(message)) return text;
  // Messages raised by our database functions are written for people; strip technical prefixes.
  return message.replace(/^ERROR:\s*/i, "");
}

function localModeEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    !!process.env.GLEEDAY_LOCAL_DB_URL &&
    !!process.env.GLEEDAY_LOCAL_USER_ID
  );
}

async function localDb(): Promise<Db> {
  const { default: pg } = await import("pg");
  const g = globalThis as unknown as { __gleedayPool?: InstanceType<typeof pg.Pool> };
  g.__gleedayPool ??= new pg.Pool({ connectionString: process.env.GLEEDAY_LOCAL_DB_URL, max: 5 });
  const pool = g.__gleedayPool;
  const userId = process.env.GLEEDAY_LOCAL_USER_ID as string;
  const email = process.env.GLEEDAY_LOCAL_USER_EMAIL ?? "local@example.test";

  async function run(wrap: (callExpr: string) => string, fn: string, args: Record<string, unknown>) {
    if (!IDENT.test(fn)) throw new DataError(`invalid function ${fn}`);
    const keys = Object.keys(args);
    for (const k of keys) if (!IDENT.test(k)) throw new DataError(`invalid argument ${k}`);
    const callExpr = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, email, role: "authenticated" }),
      ]);
      const res = await client.query(wrap(callExpr), keys.map((k) => args[k]));
      await client.query("commit");
      return res;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw new DataError(friendly((err as Error).message));
    } finally {
      client.release();
    }
  }

  return {
    userId,
    email,
    supabase: null,
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const res = await run((c) => `select ${c} as r`, fn, args);
      return res.rows[0]?.r as T;
    },
    async rows<T>(fn: string, args: Record<string, unknown> = {}) {
      const res = await run((c) => `select * from ${c}`, fn, args);
      return res.rows as T[];
    },
  };
}

/** Returns a data handle for the signed-in user, or null when not signed in / not configured. */
export const getDb = cache(async (): Promise<Db | null> => {
  if (localModeEnabled()) return localDb();

  const supabase = await createClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;

  return {
    userId: String(claims.sub),
    email: String(claims.email ?? ""),
    supabase,
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data: result, error } = await supabase.rpc(fn, args);
      if (error) throw new DataError(friendly(error.message));
      return result as T;
    },
    async rows<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data: result, error } = await supabase.rpc(fn, args);
      if (error) throw new DataError(friendly(error.message));
      return (result ?? []) as T[];
    },
  };
});

export function isConfigured(): boolean {
  return (
    localModeEnabled() ||
    (!!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  );
}
