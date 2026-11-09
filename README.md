# Gleeday Operations Center

An independent operations app where **Soled coordinates the existing bot team**, bots do authorized work, and the owner handles **decisions, approvals and exceptions** across four workstreams: **Affiliates, Co-Marketing, Media & PR, Listings**.

> **Current state: Phases 1, 3 and 4 built.** The database, operations screens and bot connection (MCP server, tokens, connector sign-in, routine notifications) are built and tested. Phase 2 (spreadsheet migration) waits on access to the sheets. See [`docs/STATUS.md`](docs/STATUS.md) for exactly what is built, tested, configured, deployed or blocked.

## How it works (plain language)

1. **Soled** creates and assigns tasks (e.g. "follow up with these media contacts").
2. **Bots** log in to the app, claim a task they are allowed to do, and get the context they need.
3. Anything outward-facing (emails, prices, commitments, spend) becomes an **exact proposal** that the owner **approves or rejects**. A changed proposal needs a new approval.
4. The bot carries out the approved action and **reports back with proof** (e.g. the Gmail message ID). Partner records update from that evidence.
5. The owner's **daily view** shows only what needs a decision, what is blocked and what changed.

## Repository layout

| Path | What it is |
|---|---|
| `supabase/migrations/` | Versioned database schema, security policies (RLS) and database functions |
| `supabase/tests/support/` | Test-only stand-in for Supabase's auth/storage (never applied to a real project) |
| `tests/db/` | Database tests: isolation, roles, approvals, task leases, evidence rules, storage |
| `packages/domain/` | Shared vocabulary (stages, milestones, statuses) and time formatting |
| `apps/web/` | Next.js web app (login, overview) |
| `tools/` | Operator scripts (workspace bootstrap) |
| `docs/` | Architecture, security review, runbook, status |

## Developer quick start

Requirements: Node 22, pnpm 10, a local PostgreSQL 16+ for tests.

```bash
pnpm install
```

```bash
pnpm test        # database + unit tests (creates and drops a throwaway database)
```

```bash
pnpm typecheck && pnpm build
```

Tests need `TEST_DATABASE_ADMIN_URL` pointing at a local Postgres superuser (default `postgres://postgres@localhost:54329/postgres`). Setting up a real Supabase project and deploying is covered in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Documents

- [`docs/STATUS.md`](docs/STATUS.md): built / tested / configured / deployed / blocked, per component
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system ownership, layers, data model
- [`docs/SECURITY.md`](docs/SECURITY.md): access model and review of every privileged function
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md): Supabase setup, migrations, first workspace, deployment, server settings
- [`docs/BOT_CONNECTION_GUIDE.md`](docs/BOT_CONNECTION_GUIDE.md): connecting your existing bots (connector or token), routines, MCP tool contract

The integration limitations and Command Center adapter guide are written in the phases that build those parts (5–6).

## Hard boundaries

- **No impact.com** integration of any kind.
- The **Command Center** is a separate system. No shared code, database or auth, and no invented endpoints.
- Google Sheets stay untouched until an approved cutover. After that they are read-only archives; their sharing permissions are never changed automatically.
- No real messages, campaign changes or commitments during development without explicit authorization.
