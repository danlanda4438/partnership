-- Gleeday update: 20261108000500_tasks.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261108000500') then
    raise exception 'Update 20261108000500 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400')) < 4 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Durable task model: assignment, leases, attempts, retries, cancellation, dead-letter.
-- Claim/lease/report logic used by the MCP server lives in private functions (service_role only).

create type public.task_status as enum
  ('queued', 'claimed', 'awaiting_approval', 'blocked', 'succeeded', 'failed', 'cancelled', 'dead_lettered');
create type public.attempt_status as enum ('active', 'succeeded', 'failed', 'blocked', 'expired', 'cancelled');

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id uuid,
  opportunity_id uuid,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),  -- references work; never an executable prompt
  title text not null,
  details jsonb not null default '{}'::jsonb,
  status public.task_status not null default 'queued',
  priority smallint not null default 100,
  required_capability text,
  assigned_worker_id uuid,                     -- NULL = any eligible worker in scope
  due_at timestamptz,
  not_before timestamptz,
  max_attempts smallint not null default 3 check (max_attempts between 1 and 20),
  attempt_count smallint not null default 0,
  current_attempt_id uuid,
  lease_expires_at timestamptz,
  idempotency_key text,
  blocked_reason text,
  result jsonb,
  created_by_user_id uuid references auth.users(id),
  created_by_worker_id uuid,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, channel_id) references public.channels (workspace_id, id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, assigned_worker_id) references public.worker_identities (workspace_id, id),
  foreign key (workspace_id, created_by_worker_id) references public.worker_identities (workspace_id, id),
  check ((status = 'claimed') = (current_attempt_id is not null and lease_expires_at is not null))
);
create unique index tasks_idempotency on public.tasks (workspace_id, idempotency_key) where idempotency_key is not null;
create index tasks_queue_idx on public.tasks (workspace_id, status, priority, created_at) where status = 'queued';
create index tasks_lease_idx on public.tasks (lease_expires_at) where status = 'claimed';

create table public.task_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  worker_id uuid not null,
  attempt_number smallint not null,
  lease_token_hash text not null,
  status public.attempt_status not null default 'active',
  claimed_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz,
  result jsonb,
  evidence jsonb,
  error text,
  unique (workspace_id, id),
  unique (task_id, attempt_number),
  foreign key (workspace_id, task_id) references public.tasks (workspace_id, id),
  foreign key (workspace_id, worker_id) references public.worker_identities (workspace_id, id)
);
create index task_attempts_task_idx on public.task_attempts (workspace_id, task_id);
-- At most one active attempt per task (prevents concurrent claims).
create unique index task_attempts_one_active on public.task_attempts (task_id) where status = 'active';

alter table public.tasks
  add constraint tasks_current_attempt_fk foreign key (workspace_id, current_attempt_id)
    references public.task_attempts (workspace_id, id) deferrable initially deferred;
alter table public.approvals
  add constraint approvals_task_fk foreign key (workspace_id, task_id) references public.tasks (workspace_id, id);

create trigger tasks_updated_at before update on public.tasks for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Claim: atomic, scope-checked. The worker id comes from the authenticated MCP token
-- (resolved server-side), never from a client-asserted bot_id.
-- Returns the attempt; the raw lease token is generated here and returned once.
-- ---------------------------------------------------------------------------
create function private.claim_task(p_worker_id uuid, p_task_id uuid, p_lease_seconds integer)
returns table (attempt_id uuid, lease_token text, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker public.worker_identities;
  v_task public.tasks;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 3600)));
  v_attempt_id uuid := gen_random_uuid();
  v_active integer;
begin
  select * into v_worker from public.worker_identities where id = p_worker_id;
  if not found or v_worker.status <> 'active' then
    raise exception 'worker not active' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update skip locked;
  if not found then
    raise exception 'task unavailable' using errcode = 'lock_not_available';
  end if;
  if v_task.workspace_id <> v_worker.workspace_id then
    raise exception 'task not in worker scope' using errcode = 'insufficient_privilege';
  end if;
  if v_task.channel_id is not null and not exists (
    select 1 from public.worker_channel_scopes s where s.worker_id = v_worker.id and s.channel_id = v_task.channel_id
  ) then
    raise exception 'task not in worker scope' using errcode = 'insufficient_privilege';
  end if;
  if v_task.assigned_worker_id is not null and v_task.assigned_worker_id <> v_worker.id then
    raise exception 'task assigned to another worker' using errcode = 'insufficient_privilege';
  end if;
  if v_task.required_capability is not null and not (v_task.required_capability = any (v_worker.capabilities)) then
    raise exception 'worker lacks capability %', v_task.required_capability using errcode = 'insufficient_privilege';
  end if;
  if v_task.status <> 'queued' or (v_task.not_before is not null and v_task.not_before > now()) then
    raise exception 'task is %, not claimable', v_task.status using errcode = 'lock_not_available';
  end if;
  if v_task.attempt_count >= v_task.max_attempts then
    update public.tasks set status = 'dead_lettered' where id = v_task.id;
    raise exception 'task exhausted its attempts' using errcode = 'lock_not_available';
  end if;

  select count(*) into v_active from public.task_attempts a
    where a.worker_id = v_worker.id and a.status = 'active';
  if v_active >= v_worker.max_concurrent_tasks then
    raise exception 'worker at concurrency limit' using errcode = 'too_many_connections';
  end if;

  insert into public.task_attempts (id, workspace_id, task_id, worker_id, attempt_number, lease_token_hash, lease_expires_at)
    values (v_attempt_id, v_task.workspace_id, v_task.id, v_worker.id, v_task.attempt_count + 1,
            encode(pg_catalog.sha256(convert_to(v_token, 'UTF8')), 'hex'), v_expires);
  update public.tasks
     set status = 'claimed', current_attempt_id = v_attempt_id, lease_expires_at = v_expires,
         attempt_count = attempt_count + 1
   where id = v_task.id;

  return query select v_attempt_id, v_token, v_expires;
end;
$$;

-- Validates a lease token for (task, worker). Raises typed errors on mismatch/expiry.
create function private.require_lease(p_worker_id uuid, p_task_id uuid, p_lease_token text)
returns public.task_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.task_attempts;
begin
  select a.* into v_attempt from public.task_attempts a
   where a.task_id = p_task_id
     and a.lease_token_hash = encode(pg_catalog.sha256(convert_to(p_lease_token, 'UTF8')), 'hex')
   for update;
  if not found or v_attempt.worker_id <> p_worker_id then
    raise exception 'invalid lease' using errcode = 'insufficient_privilege';
  end if;
  if v_attempt.status <> 'active' or v_attempt.lease_expires_at <= now() then
    raise exception 'lease expired' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_attempt;
end;
$$;

create function private.heartbeat_task(p_worker_id uuid, p_task_id uuid, p_lease_token text, p_lease_seconds integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.task_attempts := private.require_lease(p_worker_id, p_task_id, p_lease_token);
  v_expires timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 3600)));
begin
  update public.task_attempts set heartbeat_at = now(), lease_expires_at = v_expires where id = v_attempt.id;
  update public.tasks set lease_expires_at = v_expires where id = p_task_id;
  return v_expires;
end;
$$;

-- Terminal or blocked report. Idempotent: repeating the same report on a finished
-- attempt returns without changing anything.
create function private.report_task(p_worker_id uuid, p_task_id uuid, p_lease_token text,
                                    p_outcome text, p_result jsonb, p_evidence jsonb)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.task_attempts;
  v_task public.tasks;
  v_hash text := encode(pg_catalog.sha256(convert_to(p_lease_token, 'UTF8')), 'hex');
begin
  if p_outcome not in ('succeeded', 'failed', 'blocked') then
    raise exception 'outcome must be succeeded, failed or blocked' using errcode = 'invalid_parameter_value';
  end if;

  -- Idempotent replay of a report already accepted for this lease.
  select a.* into v_attempt from public.task_attempts a
   where a.task_id = p_task_id and a.worker_id = p_worker_id and a.lease_token_hash = v_hash
     and a.status::text = p_outcome;
  if found then
    select * into v_task from public.tasks where id = p_task_id;
    return v_task;
  end if;

  v_attempt := private.require_lease(p_worker_id, p_task_id, p_lease_token);
  update public.task_attempts
     set status = p_outcome::public.attempt_status, finished_at = now(), result = p_result, evidence = p_evidence,
         error = case when p_outcome <> 'succeeded' then coalesce(p_result->>'error', p_result->>'reason') end
   where id = v_attempt.id;

  select * into v_task from public.tasks where id = p_task_id for update;
  update public.tasks
     set status = case
                    when p_outcome = 'succeeded' then 'succeeded'::public.task_status
                    when p_outcome = 'blocked' then 'blocked'::public.task_status
                    when v_task.attempt_count >= v_task.max_attempts then 'dead_lettered'::public.task_status
                    else 'queued'::public.task_status
                  end,
         current_attempt_id = null,
         lease_expires_at = null,
         result = p_result,
         blocked_reason = case when p_outcome = 'blocked' then coalesce(p_result->>'reason', 'unspecified') else null end,
         completed_at = case when p_outcome = 'succeeded' then now() else null end
   where id = p_task_id
  returning * into v_task;
  return v_task;
end;
$$;

-- Sweeper: expire stale leases and return tasks to the queue (or dead-letter them).
create function private.expire_leases()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.task_attempts a set status = 'expired', finished_at = now()
     where a.status = 'active' and a.lease_expires_at <= now()
    returning a.task_id
  )
  update public.tasks t
     set status = case when t.attempt_count >= t.max_attempts then 'dead_lettered'::public.task_status
                       else 'queued'::public.task_status end,
         current_attempt_id = null, lease_expires_at = null
    from expired e
   where t.id = e.task_id and t.status = 'claimed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Human cancellation (owner/admin). Active attempts are cancelled; their leases stop working.
create function public.cancel_task(p_task_id uuid, p_reason text default null)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or not private.has_workspace_role(v_task.workspace_id, array['owner','admin']::public.member_role[]) then
    raise exception 'task not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
  if v_task.status in ('succeeded', 'cancelled', 'dead_lettered') then
    return v_task;
  end if;
  update public.task_attempts set status = 'cancelled', finished_at = now(), error = p_reason
   where task_id = p_task_id and status = 'active';
  update public.tasks set status = 'cancelled', cancelled_at = now(), current_attempt_id = null,
         lease_expires_at = null, blocked_reason = p_reason
   where id = p_task_id returning * into v_task;
  return v_task;
end;
$$;

revoke all on function private.claim_task(uuid, uuid, integer) from public, authenticated;
revoke all on function private.require_lease(uuid, uuid, text) from public, authenticated;
revoke all on function private.heartbeat_task(uuid, uuid, text, integer) from public, authenticated;
revoke all on function private.report_task(uuid, uuid, text, text, jsonb, jsonb) from public, authenticated;
revoke all on function private.expire_leases() from public, authenticated;
grant execute on function private.claim_task(uuid, uuid, integer) to service_role;
grant execute on function private.heartbeat_task(uuid, uuid, text, integer) to service_role;
grant execute on function private.report_task(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function private.expire_leases() to service_role;
revoke all on function public.cancel_task(uuid, text) from public, anon;
grant execute on function public.cancel_task(uuid, text) to authenticated;

select private.apply_workspace_rls('public.tasks', 'read');
select private.apply_workspace_rls('public.task_attempts', 'read');
-- Lease token hashes are not needed by the UI.
revoke select on public.task_attempts from authenticated;
grant select (id, workspace_id, task_id, worker_id, attempt_number, status, claimed_at, heartbeat_at,
              lease_expires_at, finished_at, result, evidence, error) on public.task_attempts to authenticated;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000500', 'tasks') on conflict do nothing;
commit;
select 'Update 20261108000500 applied' as result;
