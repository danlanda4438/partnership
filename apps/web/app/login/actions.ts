"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function sendLoginLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const supabase = await createClient();
  if (!supabase || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/login?sent=1");

  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host")}`;
  // Invite-only: never creates new accounts from the login form.
  await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/confirm` },
  });
  // Same response whether or not the address has access (no account enumeration).
  redirect("/login?sent=1");
}
