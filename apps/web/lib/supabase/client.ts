"use client";
import { createBrowserClient } from "@supabase/ssr";
import { publicSupabaseEnv } from "../env";

export function createClient() {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured");
  return createBrowserClient(env.url, env.publishableKey);
}
