# Status

Legend: **Built**: code exists · **Tested**: automated tests pass · **Configured**: real credentials or settings are in place · **Deployed**: running for real users · **Blocked**: waiting on an external dependency.

_Last updated: 2026-11-10 (spreadsheets imported into production; next: verify, connect bots, cutover)._

## Phase 1: Foundation

| Component | Built | Tested | Configured | Deployed | Notes |
|---|---|---|---|---|---|
| Database schema (all brief tables, four channels) | ✅ | ✅ | ✅ | ✅ | Applied to Supabase project `Partnerships` on 2026-11-08; owner's verification (`02_verify.sql`) all OK. Tests pass on Postgres 16 locally and 17 in CI |
| Row Level Security + grants on every table | ✅ | ✅ | ✅ | ✅ | Cross-workspace, roles, revocation, views, storage |
| Append-only evidence, idempotent events | ✅ | ✅ | ✅ | ✅ | Part of the applied schema |
| Approvals: immutable payload, hash-confirmed decision, single execution, expiry, approver revocation | ✅ | ✅ | ✅ | ✅ | Database layer applied; UI built in Phase 3 |
| Task leases: atomic claims, scope, retries, dead-letter, cancellation, backpressure | ✅ | ✅ | ✅ | ✅ | Database layer applied; MCP tools in Phase 4 |
| Private attachments bucket + policies | ✅ | ✅ (against stub) | ❌ | ❌ | Needs re-check on a real Supabase project |
| Web app: invite-only magic-link login | ✅ | Smoke-tested locally | ⏳ | ⏳ | Vercel deploy in progress; Supabase URL settings need an Invitfull Administrator |
| Workspace bootstrap tool | ✅ | ❌ | ❌ | — | Needs a real Supabase project |
| CI workflow | ✅ | ✅ | — | — | Green on GitHub Actions (Postgres 17) |



**Important:** the database tests use a local stand-in for Supabase's auth and storage (`supabase/tests/support/supabase_stub.sql`). Passing them shows the rules are correct. It does not show they are live on a real project. That is verified after `supabase db push` (see RUNBOOK).

## Phase 3: Operations UI, metrics, approvals

| Component | Built | Tested | Configured | Deployed | Notes |
|---|---|---|---|---|---|
| Read models + metrics functions (`20261109000100`) | ✅ | ✅ | ✅ | ✅ | Applied to `Partnerships` project |
| Today (daily owner view) | ✅ | ✅ browser | — | ❌ | Approvals, exceptions, due actions, changes grouped by partner |
| Metrics | ✅ | ✅ db + browser | — | ❌ | Separate contacts / organizations / opportunities / messages; de-duplicated totals; periods; freshness |
| Four pipelines | ✅ | ✅ browser | — | ❌ | Stage columns, inventory outside the funnel, search, declined/bounced toggle |
| Partner detail | ✅ | ✅ db + browser | — | ❌ | Evidence timeline with source provenance, people, offers, attachments, tasks; plan / activity / stage / status forms |
| Approval inbox + detail | ✅ | ✅ db + browser | — | ❌ | Shows exact payload; decision bound to its fingerprint |
| Task board | ✅ | ✅ browser | — | ❌ | Cancel (owner/admin) |
| Exception queue | ✅ | ✅ db + browser | — | ❌ | Blocked/failed tasks, uncertain sends, verification, ambiguous identities, unhealthy campaigns, connections |
| Bot administration | ✅ | ✅ db + browser | — | ❌ | Pause/resume, channels, parallel and daily limits. Bots are added in Phase 4 |
| Integrations & source registry | ✅ | ✅ browser | — | ❌ | Shows every required connection as "not configured" until a real verified check |
| Settings: notification preferences, members | ✅ | ✅ db | — | ❌ | Preferences saved only; **delivery is not active** until the Phase 4 worker |
| Attachment downloads (signed links) | ✅ | ❌ | — | ❌ | Needs a real Supabase project to test |

**Tests:** 91 database tests + 5 unit tests passing, plus a browser smoke test (`tests/e2e/smoke.cjs`) over every screen against fictional demo data. That test is not yet in CI.

**Important:** the database tests use a local stand-in for Supabase's auth and storage (`supabase/tests/support/supabase_stub.sql`). Passing them shows the rules are correct. It does not show they are live on a real project.

## Phase 2: Spreadsheet migration

| Component | Built | Tested | Configured | Deployed | Notes |
|---|---|---|---|---|---|
| Migration package (snapshot, normalize, verify, report) | ✅ | ✅ unit + real files | — | — | Runs in the browser; spreadsheets never committed to git |
| Dry run on the real 5 workbooks + agent verification | ✅ | ✅ | — | — | Reproduces the Nov 8 sheet totals exactly (209/14/12, 38/1/1, 36/17/16, 16/0/4) |
| Import loader (`20261112000100`) | ✅ | ✅ db + real data | ✅ | ✅ | Applied to `Partnerships` |
| Abandoned-import tidy-up (`20261113000100`) | ✅ | ✅ | ❌ | ❌ | Optional: `supabase/manual/updates/20261113000100_import_tidy.sql` |
| Import page (Settings → Import data) | ✅ | ✅ browser, real files, 57 s | ✅ | ✅ | Live on Vercel |
| Real import into production | ✅ | — | ✅ | ✅ | Run by the owner on 2026-11-09 with the 5 workbooks + verification file. One earlier attempt was interrupted and is superseded |
| Cutover (app becomes source of truth; sheets read-only) | ❌ | ❌ | ❌ | ❌ | Separate, approved step with backup and rollback |

## Phase 4: Bots, MCP and durable execution

| Component | Built | Tested | Configured | Deployed | Notes |
|---|---|---|---|---|---|
| Worker execution layer (`20261110000100`) | ✅ | ✅ | ✅ | ✅ | Applied to `Partnerships` project; verification all OK |
| Connector OAuth tables (`20261110000200`) | ✅ | ✅ | ✅ | ✅ | Applied to `Partnerships` project; verification all OK |
| MCP server `/api/mcp` (13 tools, typed errors) | ✅ | ✅ real MCP client + real HTTP | ❌ | ❌ | Needs `SUPABASE_URL` + `SUPABASE_SECRET_KEY` as server-only Vercel variables |
| Per-bot tokens (create once, revoke, expiry) | ✅ | ✅ db + browser | — | ❌ | |
| claude.ai connector sign-in (OAuth 2.1, PKCE, rotation) | ✅ | ✅ db + browser + HTTP | — | ❌ | Not yet tried with a real claude.ai connector |
| Approval → task lifecycle, single execution, daily limits | ✅ | ✅ | — | ❌ | |
| Routine notifications (outbox, retries, dead-letter) | ✅ | ✅ (fake routine) | ❌ | ❌ | Needs each routine's fire URL/token as server variables |
| Scheduled maintenance (`/api/worker/maintenance`) | ✅ | ✅ db | ❌ | ❌ | Vercel Cron once a day (Hobby limit) + immediate dispatch after approvals and bot reports |
| Bots page: add bot, channels, limits, pause, tokens, routine, connections, notifications | ✅ | ✅ browser | — | ❌ | |
| Coordinator + prospect tools, Grok webhook format (`20261111000100`) | ✅ | ✅ | ❌ | ❌ | **Owner must run** `supabase/manual/updates/20261111000100_coordinator_tools.sql` |
| Your 5 Grok bots registered (`04_create_bots.sql`) | ✅ | ✅ (on a copy) | ❌ | ❌ | **Owner must run** after the update above |
| Grok connectors + routines for the 5 bots | — | — | ❌ | ❌ | Steps in `docs/BOT_CONNECTION_GUIDE.md`; needs the deployed app and sign-in |
| Real authorized end-to-end task with an existing bot | ❌ | ❌ | ❌ | ❌ | **Blocked:** needs deployment + sign-in |

**Tests:** 130 database/MCP/OAuth tests + 5 unit tests, plus browser tests `tests/e2e/smoke.cjs` and `tests/e2e/bots.mjs`.

## Upcoming phases

| Phase | Scope | Status | Blocked on |
|---|---|---|---|
| 2 | Spreadsheet snapshot → staging → reconciliation report | Not started | Read access to the 5 linked Google Sheets |
| 5 | Instantly sync; Gmail sends through bots' existing access with approval | Not started | Instantly API key and plan |
| 6 | Command Center adapter, cutover, end-to-end | Not started | Command Center owner's agreed contract |

## Decisions recorded

- **Bots run on Grok Bot** (Soled = coordinator; affiliates, co-marketing, media & PR, listing). They connect through Grok custom connectors (OAuth, one per bot) and are woken by Grok routine webhooks. Grok's connectors may be account-wide, so each bot's instructions name its own connector, and the server limits each connector to its bot's scope.
- **impact.com stays out of the app**, even though the bots use it elsewhere. Only manual affiliate milestones are recorded.

- **Supabase project:** `Partnerships` (ref `ujtgbkilcownazwudtjt`, org Invitfull, region ap-southeast-2). Set up by the owner via the SQL Editor (`supabase/manual/`). No Supabase keys are held by the build sessions.

- **Gmail:** bots already have Gmail access. The app does not hold its own Gmail connection at first. Bots send approved payloads and report provider message IDs back. The bots' own connector confirmation still applies. An app-owned read-only Gmail connection may be added later for independent verification.
- **Hosting:** Vercel (web) + Supabase; one small worker service to be added in Phase 4.
- **Screens read data through database functions** (`ui_*`, `workspace_metrics`) running as the signed-in user, so Row Level Security applies to every screen, and screen logic is tested in SQL.
- **Supabase access:** the owner's Invitfull role is Developer; changing Authentication settings needs Administrator.
