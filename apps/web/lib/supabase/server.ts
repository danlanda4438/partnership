import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicSupabaseEnv } from "../env";

/**
 * Server client acting AS the signed-in user (publishable key + their session cookie),
 * so every query is filtered by Row Level Security. Create one per request.
 */
export async function createClient() {
  const env = publicSupabaseEnv();
  if (!env) return null;
  const cookieStore = await cookies();
  return createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: the proxy refreshes sessions, so this is safe to ignore.
        }
      },
    },
  });
}
