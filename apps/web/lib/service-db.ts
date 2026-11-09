// Server-only access for the MCP server and dispatcher. Uses the Supabase SECRET key
// (never sent to the browser, never given to bots) and may only call the worker_*,
// dispatch_* and run_maintenance functions, which are granted to service_role alone.
//
// In local development and tests (GLEEDAY_LOCAL_DB_URL set, not production) it connects
// to Postgres directly and switches to the service_role role.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class ServiceDbError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
  }
}

export interface ServiceDb {
  call<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
  rows<T = Record<string, unknown>>(fn: string, args?: Record<string, unknown>): Promise<T[]>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function localMode(): boolean {
  return process.env.NODE_ENV !== "production" && !!process.env.GLEEDAY_LOCAL_DB_URL;
}

let cached: ServiceDb | null = null;

/** The project URL is not secret: reuse the public one when SUPABASE_URL isn't set separately. */
function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export function serviceConfigured(): boolean {
  return localMode() || (!!supabaseUrl() && !!process.env.SUPABASE_SECRET_KEY);
}

export async function getServiceDb(): Promise<ServiceDb> {
  if (cached) return cached;
  if (localMode()) {
    cached = await localServiceDb(process.env.GLEEDAY_LOCAL_DB_URL as string);
    return cached;
  }
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new ServiceDbError("Server is not configured (SUPABASE_SECRET_KEY)", "not_configured");
  const client: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  cached = {
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new ServiceDbError(error.message, error.code);
      return data as T;
    },
    async rows<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new ServiceDbError(error.message, error.code);
      return (data ?? []) as T[];
    },
  };
  return cached;
}

export async function localServiceDb(connectionString: string): Promise<ServiceDb> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 5 });
  async function run(wrap: (c: string) => string, fn: string, args: Record<string, unknown>) {
    if (!IDENT.test(fn)) throw new ServiceDbError(`invalid function ${fn}`, "22023");
    const keys = Object.keys(args);
    for (const k of keys) if (!IDENT.test(k)) throw new ServiceDbError(`invalid argument ${k}`, "22023");
    const callExpr = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role service_role");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      const res = await client.query(
        wrap(callExpr),
        keys.map((k) => {
          const v = args[k];
          // JSON objects, and arrays of objects (jsonb), are sent as JSON text; plain arrays stay Postgres arrays.
          const isJson = v !== null && typeof v === "object" && (!Array.isArray(v) || v.some((x) => x !== null && typeof x === "object"));
          return isJson ? JSON.stringify(v) : v;
        }),
      );
      await client.query("commit");
      return res;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      const e = err as Error & { code?: string };
      throw new ServiceDbError(e.message, e.code);
    } finally {
      client.release();
    }
  }
  return {
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      return (await run((c) => `select ${c} as r`, fn, args)).rows[0]?.r as T;
    },
    async rows<T>(fn: string, args: Record<string, unknown> = {}) {
      return (await run((c) => `select * from ${c}`, fn, args)).rows as T[];
    },
  };
}
