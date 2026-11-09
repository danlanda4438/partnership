-- Gleeday update: 20261111000100_coordinator_tools.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261111000100') then
    raise exception 'Update 20261111000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200')) < 9 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Coordinator (Soled) and prospecting tools for bots.
--   * tasks.assign capability: create/assign/requeue tasks within the bot's channels, overview.
--   * Any bot: search opportunities in scope; add new prospects as uncontacted inventory.
-- Same rules as before: service_role only, identity from the token, scope re-checked here.

insert into public.worker_event_types values
  ('prospect.added', 'A new prospect was added to inventory (not contact)');

-- Coordinators are told when work stops, so they can reassign or escalate.
create function private.notify_task_stopped()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
begin
  if new.status not in ('blocked', 'dead_lettered') or new.status is not distinct from old.status then
    return null;
  end if;
  for w in
    select wi.id from public.worker_identities wi
    where wi.workspace_id = new.workspace_id and wi.status = 'active' and wi.role = 'coordinator'
      and wi.id is distinct from new.assigned_worker_id
  loop
    perform private.enqueue_delivery(new.workspace_id, w.id, 'task.' || new.status,
      jsonb_build_object('event', 'task.' || new.status, 'task_id', new.id, 'kind', new.kind),
      'task.' || new.status || ':' || new.id || ':' || new.attempt_count || ':' || w.id);
  end loop;
  return null;
end;
$$;
create trigger tasks_notify_stopped after update of status on public.tasks
  for each row execute function private.notify_task_stopped();

-- A queued task reassigned to another bot wakes the new assignee.
create function private.notify_task_reassigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'queued' and old.status = 'queued' and new.assigned_worker_id is distinct from old.assigned_worker_id
     and new.assigned_worker_id is not null then
    perform private.enqueue_delivery(new.workspace_id, new.assigned_worker_id, 'task.available',
      jsonb_build_object('event', 'task.available', 'task_id', new.id, 'kind', new.kind, 'attempt', new.attempt_count),
      'task.available:' || new.id || ':' || new.attempt_count || ':' || new.assigned_worker_id);
  end if;
  return null;
end;
$$;
create trigger tasks_notify_reassigned after update of assigned_worker_id on public.tasks
  for each row execute function private.notify_task_reassigned();

create function private.require_capability(p_worker public.worker_identities, p_capability text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not (p_capability = any (p_worker.capabilities)) then
    raise exception 'this bot does not have the % permission', p_capability using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create function private.require_channel_scope(p_worker_id uuid, p_channel public.channel_kind)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_channel uuid;
begin
  select c.id into v_channel
  from public.worker_channel_scopes s join public.channels c on c.id = s.channel_id
  where s.worker_id = p_worker_id and c.kind = p_channel;
  if v_channel is null then
    raise exception 'channel % is not in this bot''s scope', p_channel using errcode = 'insufficient_privilege';
  end if;
  return v_channel;
end;
$$;

-- Create a task (coordinator). Idempotent on idempotency_key.
create function public.worker_create_task(
  p_worker_id uuid, p_channel public.channel_kind, p_kind text, p_title text, p_details jsonb,
  p_opportunity_id uuid default null, p_assign_to uuid default null, p_priority integer default 100,
  p_due_at timestamptz default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_channel uuid;
  v_task public.tasks;
begin
  perform private.require_capability(v_w, 'tasks.assign');
  v_channel := private.require_channel_scope(p_worker_id, p_channel);
  if coalesce(length(trim(p_idempotency_key)), 0) = 0 then
    raise exception 'idempotencyKey is required (it makes retries safe)' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_task from public.tasks where workspace_id = v_w.workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'duplicate', true);
  end if;
  if p_kind !~ '^[a-z][a-z0-9_.]{1,63}$' then
    raise exception 'kind must look like outreach.follow_up' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(length(trim(p_title)), 0) = 0 then
    raise exception 'title is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_opportunity_id is not null and not exists (
    select 1 from public.opportunities o where o.id = p_opportunity_id and o.workspace_id = v_w.workspace_id and o.channel_id = v_channel
  ) then
    raise exception 'opportunity not found in channel %', p_channel using errcode = 'no_data_found';
  end if;
  if p_assign_to is not null and not exists (
    select 1 from public.worker_identities a join public.worker_channel_scopes s on s.worker_id = a.id
    where a.id = p_assign_to and a.workspace_id = v_w.workspace_id and a.status = 'active' and s.channel_id = v_channel
  ) then
    raise exception 'assignee must be an active bot with access to channel %', p_channel using errcode = 'invalid_parameter_value';
  end if;

  insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, details, assigned_worker_id, priority,
                            due_at, idempotency_key, created_by_worker_id)
  values (v_w.workspace_id, v_channel, p_opportunity_id, p_kind, left(trim(p_title), 300), coalesce(p_details, '{}'::jsonb),
          p_assign_to, greatest(0, least(coalesce(p_priority, 100), 1000)), p_due_at, p_idempotency_key, v_w.id)
  returning * into v_task;
  return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'duplicate', false);
exception when unique_violation then
  select * into v_task from public.tasks where workspace_id = v_w.workspace_id and idempotency_key = p_idempotency_key;
  return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'duplicate', true);
end;
$$;

-- Reassign a queued or blocked task (coordinator). A blocked task goes back to the queue.
create function public.worker_assign_task(p_worker_id uuid, p_task_id uuid, p_assign_to uuid, p_note text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_task public.tasks;
  v_kind public.channel_kind;
begin
  perform private.require_capability(v_w, 'tasks.assign');
  select * into v_task from public.tasks where id = p_task_id and workspace_id = v_w.workspace_id for update;
  if not found then
    raise exception 'task not found' using errcode = 'no_data_found';
  end if;
  if v_task.channel_id is not null then
    select kind into v_kind from public.channels where id = v_task.channel_id;
    perform private.require_channel_scope(p_worker_id, v_kind);
  end if;
  if v_task.status not in ('queued', 'blocked') then
    raise exception 'only queued or blocked tasks can be reassigned (this one is %)', v_task.status using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.approvals a where a.task_id = v_task.id and a.status in ('executing', 'execution_uncertain')) then
    raise exception 'this task has an approved action in progress or awaiting reconciliation' using errcode = 'check_violation';
  end if;
  if p_assign_to is not null and not exists (
    select 1 from public.worker_identities a join public.worker_channel_scopes s on s.worker_id = a.id
    where a.id = p_assign_to and a.workspace_id = v_w.workspace_id and a.status = 'active'
      and (v_task.channel_id is null or s.channel_id = v_task.channel_id)
  ) then
    raise exception 'assignee must be an active bot with access to this channel' using errcode = 'invalid_parameter_value';
  end if;
  update public.tasks
     set assigned_worker_id = p_assign_to, status = 'queued', blocked_reason = null,
         max_attempts = greatest(max_attempts, attempt_count + 1),
         details = details || jsonb_build_object('coordinator_note', p_note)
   where id = v_task.id
  returning * into v_task;
  return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'assigned_worker_id', v_task.assigned_worker_id);
end;
$$;

-- Search opportunities in the bot's channels (stage 'none' = uncontacted inventory).
create function public.worker_search_opportunities(p_worker_id uuid, p_channel public.channel_kind default null,
                                                   p_stage text default null, p_query text default null,
                                                   p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_rows jsonb;
  v_total integer;
begin
  if p_stage is not null and p_stage <> 'none' and p_stage not in (select unnest(enum_range(null::public.opportunity_stage))::text) then
    raise exception 'unknown stage %', p_stage using errcode = 'invalid_parameter_value';
  end if;
  with scoped as (
    select v.* from public.opportunity_pipeline v
    join public.opportunities o on o.id = v.id
    where v.workspace_id = v_w.workspace_id
      and exists (select 1 from public.worker_channel_scopes s where s.worker_id = v_w.id and s.channel_id = o.channel_id)
      and (p_channel is null or v.channel_kind = p_channel)
      and (p_stage is null or (p_stage = 'none' and v.stage is null) or v.stage::text = p_stage)
      and (p_query is null or v.organization_name ilike '%' || p_query || '%' or coalesce(v.primary_contact_name, '') ilike '%' || p_query || '%')
  )
  select (select count(*) from scoped),
         coalesce((select jsonb_agg(jsonb_build_object('opportunity_id', s.id, 'organization', s.organization_name, 'channel', s.channel_kind,
             'stage', s.stage, 'disposition', s.disposition, 'milestone', s.milestone_key, 'primary_contact', s.primary_contact_name,
             'next_action', s.next_action, 'next_action_due_at', s.next_action_due_at, 'last_verified_at', s.last_verified_at)
             order by s.organization_name, s.id)
           from (select * from scoped order by organization_name, id offset greatest(0, coalesce(p_offset, 0)) limit v_limit) s), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('opportunities', v_rows, 'total', v_total,
                            'next_offset', case when coalesce(p_offset, 0) + v_limit < v_total then coalesce(p_offset, 0) + v_limit end);
end;
$$;

-- Add a new prospect as uncontacted inventory. Never merges on names: reuses a contact only
-- by an exact verified email, and an organization only by the same website domain.
create function public.worker_create_prospect(p_worker_id uuid, p_channel public.channel_kind, p_external_ref text, p_prospect jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_channel uuid := private.require_channel_scope(p_worker_id, p_channel);
  v_existing uuid;
  v_org uuid;
  v_contact uuid;
  v_opp uuid;
  v_name text := trim(p_prospect #>> '{organization,name}');
  v_site text := nullif(trim(p_prospect #>> '{organization,website}'), '');
  v_domain text;
  v_email text := lower(nullif(trim(p_prospect #>> '{contact,email}'), ''));
  v_event uuid;
  v_reused_org boolean := false;
  v_reused_contact boolean := false;
begin
  if coalesce(length(trim(p_external_ref)), 0) = 0 then
    raise exception 'externalRef is required (it makes retries safe)' using errcode = 'invalid_parameter_value';
  end if;
  select e.opportunity_id into v_existing from public.activity_events e
   where e.workspace_id = v_w.workspace_id and e.source = 'worker:' || v_w.id and e.external_event_id = 'prospect:' || p_external_ref;
  if found then
    return jsonb_build_object('opportunity_id', v_existing, 'duplicate', true);
  end if;
  if coalesce(length(v_name), 0) = 0 then
    raise exception 'organization.name is required' using errcode = 'invalid_parameter_value';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'contact.email is not a valid email address' using errcode = 'invalid_parameter_value';
  end if;
  v_domain := lower(regexp_replace(regexp_replace(coalesce(v_site, ''), '^https?://(www\.)?', ''), '/.*$', ''));
  v_domain := nullif(v_domain, '');

  if v_email is not null then
    select ci.contact_id, c.organization_id into v_contact, v_org
    from public.contact_identities ci join public.contacts c on c.id = ci.contact_id
    where ci.workspace_id = v_w.workspace_id and ci.kind = 'email' and ci.normalized_value = v_email and ci.is_verified
    limit 1;
    v_reused_contact := v_contact is not null;
    v_reused_org := v_org is not null;
  end if;
  if v_org is null and v_domain is not null then
    select id into v_org from public.organizations
     where workspace_id = v_w.workspace_id and lower(primary_domain) = v_domain order by created_at limit 1;
    v_reused_org := v_org is not null;
  end if;
  if v_org is null then
    insert into public.organizations (workspace_id, name, website, primary_domain, location_label, country, notes)
    values (v_w.workspace_id, v_name, v_site, v_domain, p_prospect #>> '{organization,location}',
            p_prospect #>> '{organization,country}', p_prospect ->> 'notes')
    returning id into v_org;
  end if;
  if v_contact is null and (v_email is not null or coalesce(p_prospect #>> '{contact,name}', '') <> '') then
    insert into public.contacts (workspace_id, organization_id, full_name, job_title)
    values (v_w.workspace_id, v_org, p_prospect #>> '{contact,name}', p_prospect #>> '{contact,title}')
    returning id into v_contact;
    if v_email is not null then
      -- Unverified until a real exchange proves it; duplicates surface as "ambiguous identity" exceptions.
      insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value, verification_source)
      values (v_w.workspace_id, v_contact, 'email', p_prospect #>> '{contact,email}', v_email, 'added by ' || v_w.name);
    end if;
  end if;

  select id into v_opp from public.opportunities where workspace_id = v_w.workspace_id and organization_id = v_org and channel_id = v_channel limit 1;
  if v_opp is null then
    insert into public.opportunities (workspace_id, channel_id, organization_id, primary_contact_id, owner_worker_id)
    values (v_w.workspace_id, v_channel, v_org, v_contact, v_w.id) returning id into v_opp;
  else
    if v_contact is not null then
      insert into public.opportunity_contacts (workspace_id, opportunity_id, contact_id, role)
      values (v_w.workspace_id, v_opp, v_contact, 'added by bot') on conflict do nothing;
    end if;
  end if;

  insert into public.activity_events (workspace_id, opportunity_id, organization_id, contact_id, event_type, source, external_event_id,
                                      actor_kind, actor_worker_id, summary, evidence)
  values (v_w.workspace_id, v_opp, v_org, v_contact, 'prospect.added', 'worker:' || v_w.id, 'prospect:' || p_external_ref,
          'worker', v_w.id, left(coalesce(p_prospect ->> 'reason', 'Prospect added'), 2000), coalesce(p_prospect -> 'sources', '{}'::jsonb))
  returning id into v_event;

  return jsonb_build_object('opportunity_id', v_opp, 'organization_id', v_org, 'contact_id', v_contact, 'duplicate', false,
                            'reused_existing_organization', v_reused_org, 'reused_existing_contact', v_reused_contact);
end;
$$;

-- Coordinator overview: queue health and what needs attention, in the bot's channels.
create function public.worker_overview(p_worker_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
begin
  perform private.require_capability(v_w, 'tasks.assign');
  return jsonb_build_object(
    'tasks_by_status', coalesce((
      select jsonb_object_agg(k, n) from (
        select coalesce(c.kind::text, 'none') || ':' || t.status as k, count(*) as n
        from public.tasks t left join public.channels c on c.id = t.channel_id
        where t.workspace_id = v_w.workspace_id and t.status not in ('succeeded', 'cancelled')
          and (t.channel_id is null or exists (select 1 from public.worker_channel_scopes s where s.worker_id = v_w.id and s.channel_id = t.channel_id))
        group by 1) x), '{}'::jsonb),
    'stopped_tasks', coalesce((
      select jsonb_agg(jsonb_build_object('task_id', t.id, 'title', t.title, 'status', t.status, 'reason', t.blocked_reason,
             'assigned_to', w.name, 'channel', c.kind) order by t.updated_at desc)
      from public.tasks t left join public.channels c on c.id = t.channel_id left join public.worker_identities w on w.id = t.assigned_worker_id
      where t.workspace_id = v_w.workspace_id and t.status in ('blocked', 'dead_lettered')
        and (t.channel_id is null or exists (select 1 from public.worker_channel_scopes s where s.worker_id = v_w.id and s.channel_id = t.channel_id))), '[]'::jsonb),
    'approvals_waiting_for_owner', (select count(*) from public.approvals a where a.workspace_id = v_w.workspace_id and a.status = 'pending'),
    'uncertain_actions', (select count(*) from public.approvals a where a.workspace_id = v_w.workspace_id and a.status = 'execution_uncertain'),
    'bots', coalesce((select jsonb_agg(jsonb_build_object('worker_id', b.id, 'name', b.name, 'role', b.role, 'status', b.status,
             'channels', (select jsonb_agg(c.kind) from public.worker_channel_scopes s join public.channels c on c.id = s.channel_id where s.worker_id = b.id),
             'active_tasks', (select count(*) from public.task_attempts a where a.worker_id = b.id and a.status = 'active')) order by b.name)
      from public.worker_identities b where b.workspace_id = v_w.workspace_id and b.status <> 'revoked'), '[]'::jsonb),
    'note', 'Approvals are decided by the owner only. Coordinators assign and requeue work; they cannot approve.'
  );
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.worker_create_task(uuid, public.channel_kind, text, text, jsonb, uuid, uuid, integer, timestamptz, text)',
    'public.worker_assign_task(uuid, uuid, uuid, text)',
    'public.worker_search_opportunities(uuid, public.channel_kind, text, text, integer, integer)',
    'public.worker_create_prospect(uuid, public.channel_kind, text, jsonb)',
    'public.worker_overview(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261111000100', 'coordinator_tools') on conflict do nothing;
commit;
select 'Update 20261111000100 applied' as result;
