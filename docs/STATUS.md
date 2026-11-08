# Status

Legend: **Built**: code exists · **Tested**: automated tests pass · **Configured**: real credentials or settings are in place · **Deployed**: running for real users · **Blocked**: waiting on an external dependency.

_Last updated: 2026-11-08 (Phase 1)._

## Phase 1: Foundation

| Component | Built | Tested | Configured | Deployed | Notes |
|---|---|---|---|---|---|
| Database schema (all brief tables, four channels) | ✅ | ✅ | ✅ | ✅ | Applied to Supabase project `Partnerships` on 2026-11-08; owner's verification (`02_verify.sql`) all OK. Tests pass on Postgres 16 locally and 17 in CI |
| Row Level Security + grants on every table | ✅ | ✅ | ✅ | ✅ | Cross-workspace, roles, revocation, views, storage |
| Append-only evidence, idempotent events | ✅ | ✅ | ❌ | ❌ | |
| Approvals: immutable payload, hash-confirmed decision, single execution, expiry, approver revocation | ✅ | ✅ | ❌ | ❌ | Database layer only; UI in Phase 3 |
| Task leases: atomic claims, scope, retries, dead-letter, cancellation, backpressure | ✅ | ✅ | ❌ | ❌ | Database layer only; MCP tools in Phase 4 |
| Private attachments bucket + policies | ✅ | ✅ (against stub) | ❌ | ❌ | Needs re-check on a real Supabase project |
| Web app: invite-only magic-link login, overview | ✅ | Smoke-tested locally | ❌ | ❌ | Not yet tried against a live Supabase project |
| Workspace bootstrap tool | ✅ | ❌ | ❌ | — | Needs a real Supabase project |
| CI workflow | ✅ | ✅ | — | — | Green on GitHub Actions (Postgres 17) |

**Test count:** 69 database tests + 2 unit tests, all passing.

**Important:** the database tests use a local stand-in for Supabase's auth and storage (`supabase/tests/support/supabase_stub.sql`). Passing them shows the rules are correct. It does not show they are live on a real project. That is verified after `supabase db push` (see RUNBOOK).

## Upcoming phases

| Phase | Scope | Status | Blocked on |
|---|---|---|---|
| 2 | Spreadsheet snapshot → staging → reconciliation report | Not started | Read access to the 5 linked Google Sheets |
| 3 | Pipelines, partner detail, task board, approval inbox, exceptions, daily view, metrics | Not started | — |
| 4 | MCP server for bots, durable execution, webhook routines | Not started | List of actual bots/roles; where Soled runs |
| 5 | Instantly sync; Gmail sends through bots' existing access with approval | Not started | Instantly API key and plan |
| 6 | Command Center adapter, cutover, end-to-end | Not started | Command Center owner's agreed contract |

## Decisions recorded

- **Supabase project:** `Partnerships` (ref `ujtgbkilcownazwudtjt`, org Invitfull, region ap-southeast-2). Set up by the owner via the SQL Editor (`supabase/manual/`). No Supabase keys are held by the build sessions.

- **Gmail:** bots already have Gmail access. The app does not hold its own Gmail connection at first. Bots send approved payloads and report provider message IDs back. The bots' own connector confirmation still applies. An app-owned read-only Gmail connection may be added later for independent verification.
- **Hosting (proposed):** Vercel (web) + Supabase + one small worker service. To be confirmed before deployment.
