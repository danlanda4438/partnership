#!/usr/bin/env node
// Creates (or reuses) the first workspace and its owner. Idempotent; safe to re-run.
// Runs on YOUR machine or a server only — it needs the Supabase SECRET key, which must never
// be placed in the web app's public environment or given to bots.
//
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   node tools/bootstrap-workspace.mjs --name "Gleeday" --slug gleeday --owner-email dan@gleeday.com
//
// It does not send any email. The owner signs in afterwards with a magic link from /login.
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    "owner-email": { type: "string" },
    role: { type: "string", default: "owner" },
  },
});
const name = values.name;
const slug = values.slug;
const email = values["owner-email"]?.trim().toLowerCase();
const role = values.role;
if (!name || !slug || !email) {
  console.error("Usage: --name <name> --slug <slug> --owner-email <email> [--role owner|admin|member|viewer]");
  process.exit(1);
}
const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment (never in a URL or file in git).");
  process.exit(1);
}

const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

async function findUser(address) {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === address);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

let user = await findUser(email);
if (!user) {
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  user = data.user;
  console.log(`Created auth user ${email}`);
} else {
  console.log(`Reusing auth user ${email}`);
}

let { data: ws, error: wsErr } = await db.from("workspaces").select("id, name").eq("slug", slug).maybeSingle();
if (wsErr) throw wsErr;
if (!ws) {
  const res = await db.from("workspaces").insert({ name, slug }).select("id, name").single();
  if (res.error) throw res.error;
  ws = res.data;
  console.log(`Created workspace ${ws.name} (${ws.id}) with its four channels`);
} else {
  console.log(`Reusing workspace ${ws.name} (${ws.id})`);
}

const { error: memErr } = await db
  .from("workspace_members")
  .upsert({ workspace_id: ws.id, user_id: user.id, role, status: "active", revoked_at: null }, { onConflict: "workspace_id,user_id" });
if (memErr) throw memErr;
console.log(`${email} is an active ${role} of ${ws.name}. Sign in at /login.`);
