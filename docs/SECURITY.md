# Security model

## Principles

- **RLS on every table** in the exposed `public` schema. Default grants are revoked; each table gets explicit grants. `anon` gets nothing. No API role can `DELETE`.
- **Authorization reads live membership rows**, not JWT claims or user metadata, so revoking or downgrading someone takes effect on their next request even if their token is still valid.
- **Roles:** `owner` > `admin` > `member` > `viewer`. Viewers read only. Members edit relationship records. Owners/admins approve, cancel tasks and manage workers and members.
- **Secrets:** only the publishable key reaches the browser. The secret key is used only by server-side tools and workers. `integration_connections.secret_ref` stores the *name* of a server-side secret, never its value.
- **Bots** authenticate to the MCP server with app-issued tokens (only the sha256 is stored, in `private.worker_credentials`). They never receive database credentials, and their identity is never taken from a self-asserted ID.
- **Views** use `security_invoker = true`, so they obey the caller's RLS.
- **Attachments** live in a private bucket. Access requires membership of the workspace named in the first path segment.
- **External content** (emails, documents, webhooks, spreadsheet cells) is stored as data and never executed. Imported formulas are archived as text.

## Privileged function review

Every `SECURITY DEFINER` function pins `search_path = ''` and schema-qualifies names. A test fails if a new definer function appears in `public` without being added to the reviewed allowlist.

### Callable by signed-in users (`public`)

| Function | Who may succeed | Checks |
|---|---|---|
| `set_member_role(member_id, role, status)` | owner/admin of that workspace | Only owners grant or remove owner; the last owner cannot be removed or demoted |
| `decide_approval(id, approve/reject, payload_hash, note)` | owner/admin | Must be pending and unexpired; the caller must supply the hash of the exact payload they reviewed |
| `cancel_task(id, reason)` | owner/admin | Cancels active attempts, so their leases stop working |

### Backend only (`private`, executable by `service_role` only)

| Function | Purpose | Checks |
|---|---|---|
| `claim_task(worker, task, lease_s)` | Atomic claim with lease | Worker active; same workspace; channel scope; assignment; capability; attempt budget; concurrency limit; `SKIP LOCKED` |
| `heartbeat_task(...)` | Extends lease | Valid, unexpired lease of this worker |
| `report_task(..., outcome, result, evidence)` | Terminal or blocked report | Valid lease; idempotent replay; retry → dead-letter |
| `expire_leases()` | Sweeper | Returns expired tasks to queue or dead-letter |
| `begin_approval_execution(id, hash, executor)` | Approved → executing, at most once | Status approved; unexpired; hash matches; approver **still** an active owner/admin |
| `finish_approval_execution(id, outcome, evidence)` | Records executed/failed/uncertain | `uncertain` blocks re-execution until reconciled |

### Internal helpers (not API-callable)

`member_workspace_ids`, `writer_workspace_ids`, `admin_workspace_ids`, `has_workspace_role` (used inside policies), and trigger functions (`create_default_channels`, `check_opportunity_milestone`, `check_stage_evidence`, `log_approval_requested`).

## Tested

See `tests/db/`. The suite covers cross-workspace reads, writes and foreign-key linking, anonymous access, viewer write attempts, membership revocation and downgrade, role-escalation attempts, view isolation, storage isolation, append-only enforcement, actor spoofing, approval immutability, hash mismatch, expiry, single and concurrent execution, approver revocation, uncertain outcomes, task scope, concurrent claims, lease expiry, idempotent reports, retries and dead-letter, cancellation and backpressure.

**Not yet tested:** behaviour on a real Supabase project (auth, storage service, API exposure settings). This is checked after the first `supabase db push`.
