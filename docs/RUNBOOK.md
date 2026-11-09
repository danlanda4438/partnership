# Runbook

## 1. Create the Supabase project (owner, ~10 min)

1. Create a new project at supabase.com. It must be **separate from the Command Center's** project.
2. **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up" (the app is invite-only). Keep Email enabled.
3. **Authentication → URL Configuration:** set the Site URL to the deployed app URL and add `<app-url>/auth/confirm` to the redirect URLs.
4. **Project Settings → API Keys:** note the **publishable** key (for the web app) and the **secret** key (server-side only; never paste it into the web app's public variables or give it to a bot).

## 2. Apply the database migrations

**Option A, no command line (recommended for the first setup):** in the Supabase Dashboard open **SQL Editor → New query** and run these files from `supabase/manual/` in order, pasting each one in full:

1. `00_precheck.sql`: read-only. `existing_tables` must be 0; if not, stop.
2. `01_setup.sql`: creates everything in one transaction (all or nothing) and records the migrations for the CLI.
3. `02_verify.sql`: read-only. Every row must say `OK`.
4. `03_first_owner.sql`: creates the Gleeday workspace and makes you owner. First create your user under Authentication → Users → Add user, with Auto Confirm ticked.

`01_setup.sql` is generated. After adding a migration, rebuild it with `tools/build-manual-setup.sh`.

**Option B, Supabase CLI:**

```bash
pnpm exec supabase login
```

```bash
pnpm exec supabase link --project-ref <your-project-ref>
```

```bash
pnpm db:push
```

Then verify on the real project:

```bash
pnpm exec supabase db lint
```

In the SQL editor, confirm RLS is enabled on every table:

```sql
select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
```

The query must return no rows.

### Applying later updates

Each new migration also gets a ready-to-paste file in `supabase/manual/updates/`. Paste it into SQL Editor → New query → Run. Each file runs all-or-nothing, refuses to run twice, and refuses to run before the earlier updates. Then run `02_verify.sql` again.

## 3. Bootstrap the first workspace

Run from a trusted machine. This sends no email.

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret> node tools/bootstrap-workspace.mjs --name "Gleeday" --slug gleeday --owner-email dan@gleeday.com
```

Add more people later the same way with `--role admin|member|viewer`.

## 4. Run the web app locally

Copy `.env.example` to `apps/web/.env.local`, fill in the two `NEXT_PUBLIC_` values, then:

```bash
pnpm dev
```

## 5. Deploy the web app (proposed: Vercel)

- Import the repository and set **Root Directory** to `apps/web`.
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` only.
- After deploying, update the Supabase Site URL and redirect URL (step 1.3).

## 6. Local development with demo data

Needs a local Postgres. This builds a throwaway database with fictional demo data (`supabase/dev/seed_demo.sql`) and starts the app signed in as a demo owner, with no Supabase involved:

```bash
LOCAL_PG=postgres://postgres@localhost:5432 tools/dev/local-demo.sh
```

Then, in another terminal, run the browser smoke test:

```bash
node tests/e2e/smoke.cjs /tmp/screens
```

The local data mode only activates under `next dev` with `GLEEDAY_LOCAL_DB_URL` set. It cannot run in a production build.

## 7. Running tests locally

Tests need a local PostgreSQL superuser. Each run creates a fresh database, loads the Supabase stub plus all migrations, runs the suite and drops the database.

```bash
TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

## Backups and rollback (Phase 1 scope)

Migrations are forward-only and version-controlled. Before any production migration, take a backup (Supabase Dashboard → Database → Backups, or `pg_dump`). The full cutover, rollback and replay procedure arrives with the migration tooling in Phase 2 and the cutover in Phase 6.
