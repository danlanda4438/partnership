-- Gleeday update: 20261108000400_offers_and_approvals.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261108000400') then
    raise exception 'Update 20261108000400 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300')) < 3 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Offers, immutable exact-action approvals, approval history.

-- Stage evidence must be an event about this same opportunity.
create function private.check_stage_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage_evidence_event_id is not null and not exists (
    select 1 from public.activity_events e
    where e.id = new.stage_evidence_event_id and e.opportunity_id = new.id
  ) then
    raise exception 'stage evidence must be an activity event of this opportunity'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;
create trigger opportunities_stage_evidence_check before insert or update of stage, stage_evidence_event_id
  on public.opportunities for each row execute function private.check_stage_evidence();

-- ---------------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------------
create type public.approval_action as enum ('send_message', 'commercial_terms', 'spend', 'commitment', 'campaign_change', 'other');
create type public.approval_status as enum
  ('pending', 'approved', 'rejected', 'expired', 'cancelled', 'executing', 'executed', 'execution_uncertain', 'execution_failed');

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid,
  task_id uuid,                                -- FK added in tasks migration
  action_type public.approval_action not null,
  summary text not null,
  -- The exact action (recipients/body/attachments, or terms/amounts). Immutable.
  payload jsonb not null,
  payload_hash text not null,                  -- sha256(payload::text), computed by the database
  proposed_by_worker_id uuid,
  proposed_by_user_id uuid references auth.users(id),
  status public.approval_status not null default 'pending',
  expires_at timestamptz not null,
  decided_by_user_id uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text,
  execution_started_at timestamptz,
  executed_at timestamptz,
  execution_evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, proposed_by_worker_id) references public.worker_identities (workspace_id, id),
  check (expires_at > created_at),
  check ((status in ('pending', 'expired', 'cancelled')) or decided_at is not null)
);
create index approvals_inbox_idx on public.approvals (workspace_id, status, created_at desc);

create table public.approval_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  approval_id uuid not null,
  event_type text not null,                    -- 'requested','approved','rejected','expired','execution_started',...
  from_status public.approval_status,
  to_status public.approval_status not null,
  payload_hash text not null,
  actor_kind public.actor_kind not null,
  actor_user_id uuid references auth.users(id),
  actor_worker_id uuid,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, approval_id) references public.approvals (workspace_id, id)
);
create index approval_events_approval_idx on public.approval_events (workspace_id, approval_id, created_at);
create trigger approval_events_append_only before update or delete on public.approval_events
  for each row execute function private.forbid_mutation();

create function private.payload_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
$$;

-- On insert: compute hash, force pending. On update: payload/hash/target are immutable.
create function private.guard_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.payload_hash := private.payload_hash(new.payload);
    new.status := 'pending';
    new.decided_by_user_id := null;
    new.decided_at := null;
    new.executed_at := null;
    new.execution_started_at := null;
    new.execution_evidence := null;
    return new;
  end if;

  if (new.payload, new.payload_hash, new.action_type, new.workspace_id, new.opportunity_id, new.task_id,
      new.proposed_by_worker_id, new.proposed_by_user_id, new.expires_at, new.created_at)
     is distinct from
     (old.payload, old.payload_hash, old.action_type, old.workspace_id, old.opportunity_id, old.task_id,
      old.proposed_by_worker_id, old.proposed_by_user_id, old.expires_at, old.created_at) then
    raise exception 'approval proposals are immutable; create a new proposal instead'
      using errcode = 'insufficient_privilege';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger approvals_guard before insert or update on public.approvals
  for each row execute function private.guard_approval();
create trigger approvals_no_delete before delete on public.approvals
  for each row execute function private.forbid_mutation();

create function private.log_approval_requested()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash,
                                      actor_kind, actor_user_id, actor_worker_id)
  values (new.workspace_id, new.id, 'requested', null, 'pending', new.payload_hash,
          case when new.proposed_by_worker_id is not null then 'worker'::public.actor_kind
               when new.proposed_by_user_id is not null then 'user'::public.actor_kind
               else 'system'::public.actor_kind end,
          new.proposed_by_user_id, new.proposed_by_worker_id);
  return new;
end;
$$;
create trigger approvals_log_requested after insert on public.approvals
  for each row execute function private.log_approval_requested();

-- ---------------------------------------------------------------------------
-- Human decision. The caller must confirm the exact payload hash they reviewed,
-- so an approval can never attach to a payload the person did not see.
-- Only active owners/admins (checked live, not from JWT claims) can decide.
-- ---------------------------------------------------------------------------
create function public.decide_approval(p_approval_id uuid, p_decision text, p_payload_hash text, p_note text default null)
returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.approvals;
  v_to public.approval_status;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from public.approvals where id = p_approval_id for update;
  if not found or not private.has_workspace_role(v_row.workspace_id, array['owner','admin']::public.member_role[]) then
    raise exception 'approval not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'approval is %, not pending', v_row.status using errcode = 'check_violation';
  end if;
  if v_row.expires_at <= now() then
    update public.approvals set status = 'expired' where id = v_row.id;
    insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind)
      values (v_row.workspace_id, v_row.id, 'expired', 'pending', 'expired', v_row.payload_hash, 'system');
    raise exception 'approval has expired' using errcode = 'check_violation';
  end if;
  if p_payload_hash is distinct from v_row.payload_hash then
    raise exception 'payload changed since review; re-review required' using errcode = 'check_violation';
  end if;

  v_to := case p_decision when 'approve' then 'approved'::public.approval_status else 'rejected'::public.approval_status end;
  update public.approvals
     set status = v_to, decided_by_user_id = (select auth.uid()), decided_at = now(), decision_note = p_note
   where id = v_row.id
  returning * into v_row;

  insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash,
                                      actor_kind, actor_user_id, note)
  values (v_row.workspace_id, v_row.id, p_decision || 'd', 'pending', v_to, v_row.payload_hash,
          'user', (select auth.uid()), p_note);
  return v_row;
end;
$$;
revoke all on function public.decide_approval(uuid, text, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Execution gate (backend only — service_role). Atomically moves approved -> executing
-- so a payload can be executed at most once. Re-validates at execution time:
--   * status is approved (not rejected/expired/cancelled/already executing)
--   * not expired
--   * payload hash matches what the executor is about to send
--   * the approving person is STILL an active owner/admin (authorization changes block execution)
-- ---------------------------------------------------------------------------
create function private.begin_approval_execution(p_approval_id uuid, p_payload_hash text, p_executor text)
returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.approvals;
begin
  select * into v_row from public.approvals where id = p_approval_id for update;
  if not found then
    raise exception 'approval not found' using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'approved' then
    raise exception 'approval is %, cannot execute', v_row.status using errcode = 'check_violation';
  end if;
  if v_row.expires_at <= now() then
    update public.approvals set status = 'expired' where id = v_row.id;
    insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind)
      values (v_row.workspace_id, v_row.id, 'expired', 'approved', 'expired', v_row.payload_hash, 'system');
    return null;
  end if;
  if p_payload_hash is distinct from v_row.payload_hash then
    raise exception 'payload hash mismatch; execution refused' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = v_row.workspace_id and m.user_id = v_row.decided_by_user_id
      and m.status = 'active' and m.role in ('owner', 'admin')
  ) then
    update public.approvals set status = 'cancelled' where id = v_row.id;
    insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind, note)
      values (v_row.workspace_id, v_row.id, 'invalidated', 'approved', 'cancelled', v_row.payload_hash, 'system',
              'approver no longer authorized');
    return null;
  end if;

  update public.approvals set status = 'executing', execution_started_at = now()
   where id = v_row.id returning * into v_row;
  insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind, details)
    values (v_row.workspace_id, v_row.id, 'execution_started', 'approved', 'executing', v_row.payload_hash, 'system',
            jsonb_build_object('executor', p_executor));
  return v_row;
end;
$$;

-- Records the outcome. 'uncertain' means the provider call may or may not have happened:
-- it must be reconciled against the provider before any retry.
create function private.finish_approval_execution(p_approval_id uuid, p_outcome text, p_evidence jsonb)
returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.approvals;
  v_to public.approval_status;
begin
  v_to := case p_outcome
            when 'executed' then 'executed'::public.approval_status
            when 'failed' then 'execution_failed'::public.approval_status
            when 'uncertain' then 'execution_uncertain'::public.approval_status
          end;
  if v_to is null then
    raise exception 'outcome must be executed, failed or uncertain' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_row from public.approvals where id = p_approval_id for update;
  if not found or v_row.status not in ('executing', 'execution_uncertain') then
    raise exception 'approval is not executing' using errcode = 'check_violation';
  end if;
  update public.approvals
     set status = v_to, execution_evidence = p_evidence,
         executed_at = case when v_to = 'executed' then now() else null end
   where id = v_row.id returning * into v_row;
  insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind, details)
    values (v_row.workspace_id, v_row.id, 'execution_' || p_outcome, 'executing', v_to, v_row.payload_hash, 'system',
            coalesce(p_evidence, '{}'::jsonb));
  return v_row;
end;
$$;
revoke all on function private.begin_approval_execution(uuid, text, text) from public, authenticated;
revoke all on function private.finish_approval_execution(uuid, text, jsonb) from public, authenticated;
grant execute on function private.begin_approval_execution(uuid, text, text) to service_role;
grant execute on function private.finish_approval_execution(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Offers (commercial proposals). A proposal is not approved spend.
-- ---------------------------------------------------------------------------
create type public.offer_status as enum ('draft', 'proposed', 'accepted', 'rejected', 'withdrawn', 'expired');

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null,
  kind text not null,                          -- 'affiliate_terms','co_marketing','paid_placement','listing_fee',...
  terms text not null,
  amount numeric(14, 2),
  currency char(3),
  is_paid boolean not null default false,
  status public.offer_status not null default 'draft',
  approval_id uuid,
  io_signed boolean not null default false,    -- an unsigned IO is not a signed contract
  io_signed_evidence_event_id uuid,
  source_row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, approval_id) references public.approvals (workspace_id, id),
  foreign key (workspace_id, io_signed_evidence_event_id) references public.activity_events (workspace_id, id),
  check (amount is null or currency is not null),
  check (not io_signed or io_signed_evidence_event_id is not null)
);
create trigger offers_updated_at before update on public.offers for each row execute function private.set_updated_at();

alter table public.approvals enable row level security;
revoke all on public.approvals from anon, authenticated;
grant select on public.approvals to authenticated;
create policy approvals_select on public.approvals for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));

select private.apply_workspace_rls('public.approval_events', 'read');
select private.apply_workspace_rls('public.offers', 'write');

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000400', 'offers_and_approvals') on conflict do nothing;
commit;
select 'Update 20261108000400 applied' as result;
