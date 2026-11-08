// Public configuration only. The Supabase SECRET key must never be read here:
// it is used solely by server-side tools/workers, never by the browser bundle.
export function publicSupabaseEnv(): { url: string; publishableKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}
