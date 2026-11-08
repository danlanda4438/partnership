# Architecture

## System ownership (after verified cutover)

| Data | Owner | This app's role |
|---|---|---|
| Opportunities, tasks, approvals, classifications, stages | **This app** | Source of truth |
| Actual email correspondence | Gmail | Stores provider IDs + bodies as evidence |
| Campaign events and labels | Instantly | Stores events/labels verbatim; deduplicated |
| Submission/placement outcomes | Provider evidence | Recorded as activity events |
| Summaries shown in Command Center | This app (projections) | Exposes versioned read interfaces + deep links |
| Historical spreadsheets | Archive | Immutable raw snapshots in `source_rows`; Sheets become read-only archives |

## Layers

```
 Browser (owner/team)                      Bots (existing workers)
        │ publishable key + user session          │ app-issued worker token
        ▼                                          ▼
 apps/web (Next.js)  ──────────────►  MCP server (Phase 4, HTTPS, authenticated)
   UI + application API                    │
        │                                  ▼
        └──────────►  Domain layer (packages/domain + database functions)
                               │
                               ▼
                 Supabase Postgres (RLS on every table) + private Storage
                               ▲
                               │ secret key (server-only)
 Worker service (Phase 4–5): durable queue, integration sync (Instantly, Sheets),
 webhook dispatcher → bot routines, lease sweeper
                               │
                               ▼
               Command Center adapter (Phase 6, contract-first)
```

- **Browser** traffic always runs as the signed-in user, so Row Level Security filters every query.
- **Bots never get database credentials.** They call MCP tools; the server resolves the worker identity from the token (never from an asserted `bot_id`) and calls the `private.*` task functions.
- **Durable processing** uses Postgres itself (task table with leases + a Postgres-backed job queue), so there is no extra queue infrastructure to run.

## Data model (Phase 1)

| Area | Tables |
|---|---|
| Tenancy & workers | `workspaces`, `workspace_members`, `worker_identities`, `worker_channel_scopes`, `private.worker_credentials` |
| Relationships | `channels`, `channel_milestones`, `organizations`, `organization_aliases`, `contacts`, `contact_identities`, `opportunities`, `opportunity_contacts`, `campaigns` |
| Evidence | `activity_events`, `messages`, `reply_assessments` |
| Commercial & approvals | `offers`, `approvals`, `approval_events` |
| Execution | `tasks`, `task_attempts` |
| Provenance | `source_files`, `import_batches`, `source_rows`, `source_links`, `source_row_targets` |
| Integrations | `integration_connections`, `sync_cursors` |
| Files | `attachments` + private Storage bucket `attachments` (path `<workspace_id>/…`) |
| Views | `opportunity_pipeline`, `channel_stage_counts` (security invoker) |

### Rules the database enforces

- **No "research" stage.** Uncontacted inventory has `stage = NULL`.
- **A funnel stage needs evidence:** `stage_evidence_event_id` must point to an activity event of the same opportunity.
- **Dispositions are separate from stage** (declined, on hold, bounced, automatic-only, blocked, needs verification).
- **Milestones are per channel** and validated (`channel_milestones`).
- **People dedupe only on verified identities.** A verified email maps to exactly one contact. Unverified matches are kept for review, and names alone never merge records.
- **Organization aliases need a written justification.** Venue locations are separate organizations linked to a parent.
- **Evidence is append-only.** Events, assessments, approval history and raw source rows cannot be edited or deleted. Message content is immutable; only its delivery status progresses.
- **Idempotency.** `(workspace, source, external_event_id)` and `(workspace, provider, provider_message_id)` are unique, so replays cannot duplicate.
- **No invented timestamps.** An event without a date must have precision `unknown`.
- **Cross-workspace links are impossible.** Every reference uses a composite `(workspace_id, id)` foreign key.
- **Metrics separate counts:** views count opportunities and organizations separately. Message events and contacts are counted from their own tables (Phase 3 adds the full metric set).

### Time

Stored as `timestamptz` (UTC) with explicit `*_precision` and `source_timezone`. Displayed in **Asia/Jerusalem** via `formatEvidenceTime`, which never shows more precision than the source had.
