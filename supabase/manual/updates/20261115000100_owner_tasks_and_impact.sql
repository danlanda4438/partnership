-- Gleeday update: 20261115000100_owner_tasks_and_impact.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261115000100') then
    raise exception 'Update 20261115000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100','20261114000100')) < 13 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- 1. The owner (or an admin/member) can create a task for a bot from the app.
-- 2. impact.com becomes part of the Affiliates and Co-Marketing workflow:
--    bots record impact.com activity as evidence, set milestones with proof, and carry out
--    impact.com actions (approving partners, sending proposals/contracts, changing terms)
--    only after the owner approves the exact action — like emails.

-- ---------------------------------------------------------------------------
-- 1. Tasks created by a person
-- ---------------------------------------------------------------------------
create function public.create_task(
  p_workspace_id uuid, p_channel public.channel_kind, p_title text, p_instructions text,
  p_assign_to uuid default null, p_opportunity_id uuid default null, p_due_at timestamptz default null,
  p_priority integer default 50
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel uuid;
  v_id uuid;
begin
  if not private.has_workspace_role(p_workspace_id, array['owner','admin','member']::public.member_role[]) then
    raise exception 'not authorized to create tasks in this workspace' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(length(trim(p_title)), 0) < 3 then
    raise exception 'a task needs a title' using errcode = 'invalid_parameter_value';
  end if;
  select id into v_channel from public.channels where workspace_id = p_workspace_id and kind = p_channel;
  if v_channel is null then
    raise exception 'channel % not found', p_channel using errcode = 'no_data_found';
  end if;
  if p_opportunity_id is not null and not exists (
    select 1 from public.opportunities o where o.id = p_opportunity_id and o.workspace_id = p_workspace_id and o.channel_id = v_channel
  ) then
    raise exception 'that partner is not in this program' using errcode = 'invalid_parameter_value';
  end if;
  if p_assign_to is not null and not exists (
    select 1 from public.worker_identities a join public.worker_channel_scopes s on s.worker_id = a.id
    where a.id = p_assign_to and a.workspace_id = p_workspace_id and a.status = 'active' and s.channel_id = v_channel
  ) then
    raise exception 'that bot is not active or does not work on this program' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, details, assigned_worker_id, priority,
                            due_at, created_by_user_id)
  values (p_workspace_id, v_channel, p_opportunity_id, 'owner.request', left(trim(p_title), 300),
          jsonb_build_object('instructions', left(coalesce(trim(p_instructions), ''), 4000)),
          p_assign_to, greatest(0, least(coalesce(p_priority, 50), 1000)), p_due_at, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_task(uuid, public.channel_kind, text, text, uuid, uuid, timestamptz, integer) from public, anon;
grant execute on function public.create_task(uuid, public.channel_kind, text, text, uuid, uuid, timestamptz, integer) to authenticated;

-- Bots see who asked for a task: a person in the app, or a bot (e.g. Soled).
create or replace function public.worker_list_tasks(p_worker_id uuid, p_mine boolean default false, p_channel public.channel_kind default null,
                                                    p_limit integer default 20, p_cursor text default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_items jsonb := '[]'::jsonb;
  v_next text;
  v_n integer := 0;
  c_prio integer; c_created timestamptz; c_id uuid;
  t record;
begin
  if p_cursor is not null then
    begin
      c_prio := split_part(p_cursor, '|', 1)::integer;
      c_created := split_part(p_cursor, '|', 2)::timestamptz;
      c_id := split_part(p_cursor, '|', 3)::uuid;
    exception when others then
      raise exception 'invalid cursor' using errcode = 'invalid_parameter_value';
    end;
  end if;

  for t in
    select tk.*, c.kind as channel_kind, cw.name as created_by_bot
    from public.tasks tk
    left join public.channels c on c.id = tk.channel_id
    left join public.worker_identities cw on cw.id = tk.created_by_worker_id
    where tk.workspace_id = v_w.workspace_id
      and (p_channel is null or c.kind = p_channel)
      and (tk.channel_id is null or exists (select 1 from public.worker_channel_scopes s where s.worker_id = v_w.id and s.channel_id = tk.channel_id))
      and (case when coalesce(p_mine, false)
             then tk.status = 'claimed' and exists (select 1 from public.task_attempts a where a.id = tk.current_attempt_id and a.worker_id = v_w.id)
             else tk.status = 'queued'
                  and (tk.assigned_worker_id is null or tk.assigned_worker_id = v_w.id)
                  and (tk.required_capability is null or tk.required_capability = any (v_w.capabilities))
                  and (tk.not_before is null or tk.not_before <= now())
           end)
      and (p_cursor is null or (tk.priority, tk.created_at, tk.id) > (c_prio, c_created, c_id))
    order by tk.priority, tk.created_at, tk.id
    limit v_limit + 1
  loop
    v_n := v_n + 1;
    if v_n > v_limit then
      exit;
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'task_id', t.id, 'kind', t.kind, 'title', t.title, 'details', t.details, 'status', t.status, 'priority', t.priority,
      'channel', t.channel_kind, 'opportunity_id', t.opportunity_id, 'due_at', t.due_at,
      'attempt_count', t.attempt_count, 'max_attempts', t.max_attempts, 'assigned_to_you', t.assigned_worker_id = v_w.id,
      'requested_by', case when t.created_by_user_id is not null then 'owner (in the app)'
                           when t.created_by_bot is not null then t.created_by_bot else 'system' end,
      'approved_approval_id', (select a.id from public.approvals a where a.task_id = t.id and a.status = 'approved' order by a.decided_at desc limit 1)));
    v_next := t.priority || '|' || t.created_at || '|' || t.id;
  end loop;
  return jsonb_build_object('tasks', v_items, 'next_cursor', case when v_n > v_limit then v_next end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. impact.com
-- ---------------------------------------------------------------------------
insert into public.worker_event_types values
  ('impact.partner_applied',   'A partner applied to (or was found in) our impact.com program'),
  ('impact.proposal_sent',     'A proposal / contract was sent to a partner on impact.com'),
  ('impact.partner_joined',    'A partner accepted the contract and joined on impact.com'),
  ('impact.partner_declined',  'A partner declined, or we declined their application, on impact.com'),
  ('impact.terms_changed',     'A partner''s contract or commission terms changed on impact.com'),
  ('impact.performance',       'impact.com performance for a partner (clicks, actions, revenue, commission) for a period');

-- impact.com evidence belongs only to the Affiliates and Co-Marketing programs.
create function private.check_impact_channel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type like 'impact.%' and new.opportunity_id is not null and not exists (
    select 1 from public.opportunities o join public.channels c on c.id = o.channel_id
    where o.id = new.opportunity_id and c.kind in ('affiliates', 'co_marketing')
  ) then
    raise exception 'impact.com activity belongs only to Affiliates or Co-Marketing partners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger activity_events_impact_channel before insert on public.activity_events
  for each row execute function private.check_impact_channel();

-- New Affiliates milestone: joined through impact.com (alongside the manual onboarding path).
update public.channel_milestones set ordinal = 4 where channel_kind = 'affiliates' and key = 'promoting';
insert into public.channel_milestones (channel_kind, key, label, ordinal)
values ('affiliates', 'joined_impact', 'Joined on impact.com', 3);

-- Bots may set a channel milestone, citing the activity event that proves it.
create function public.worker_set_milestone(p_worker_id uuid, p_opportunity_id uuid, p_milestone_key text, p_evidence_event_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_opp public.opportunities := private.require_opportunity_scope(p_worker_id, p_opportunity_id);
  v_kind public.channel_kind;
begin
  select c.kind into v_kind from public.channels c where c.id = v_opp.channel_id;
  if not exists (select 1 from public.channel_milestones m where m.channel_kind = v_kind and m.key = p_milestone_key) then
    raise exception 'milestone % does not exist for %; valid: %', p_milestone_key, v_kind,
      (select string_agg(m.key, ', ' order by m.ordinal) from public.channel_milestones m where m.channel_kind = v_kind)
      using errcode = 'invalid_parameter_value';
  end if;
  if p_evidence_event_id is null or not exists (
    select 1 from public.activity_events e where e.id = p_evidence_event_id and e.opportunity_id = v_opp.id
  ) then
    raise exception 'evidenceEventId must be an activity event of this partner' using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('app.actor_worker_id', v_w.id::text, true);
  update public.opportunities
     set milestone_key = p_milestone_key,
         milestone_changed_at = case when milestone_key is distinct from p_milestone_key then now() else milestone_changed_at end
   where id = v_opp.id;
  perform set_config('app.actor_worker_id', '', true);
  return jsonb_build_object('opportunity_id', v_opp.id, 'milestone', p_milestone_key, 'evidence_event_id', p_evidence_event_id);
end;
$$;
revoke all on function public.worker_set_milestone(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.worker_set_milestone(uuid, uuid, text, uuid) to service_role;

-- impact.com actions: proposals must say exactly what will be done, and only bots with the
-- impact.manage permission may carry them out.
create function private.check_impact_payload()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if lower(coalesce(new.payload ->> 'platform', '')) in ('impact', 'impact.com') then
    if coalesce(new.payload ->> 'action', '') = '' or coalesce(new.payload ->> 'partner', '') = '' then
      raise exception 'impact.com proposals need "platform": "impact.com", "action" (e.g. send_proposal, approve_application, decline_application, change_terms) and "partner"'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  return new;
end;
$$;
create trigger approvals_impact_payload before insert on public.approvals
  for each row execute function private.check_impact_payload();

create or replace function public.worker_start_approved_action(p_worker_id uuid, p_approval_id uuid, p_payload_hash text,
                                                               p_task_id uuid, p_lease_token text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_a public.approvals;
  v_used integer;
begin
  select * into v_a from public.approvals where id = p_approval_id and workspace_id = v_w.workspace_id;
  if not found then
    raise exception 'approval not found' using errcode = 'no_data_found';
  end if;
  if v_a.opportunity_id is not null then
    perform private.require_opportunity_scope(p_worker_id, v_a.opportunity_id);
  end if;
  if v_a.task_id is not null then
    if p_task_id is distinct from v_a.task_id then
      raise exception 'this approval belongs to another task' using errcode = 'insufficient_privilege';
    end if;
    perform private.require_lease(p_worker_id, v_a.task_id, p_lease_token);
  end if;
  if v_a.action_type = 'send_message' and not ('gmail.send' = any (v_w.capabilities)) then
    raise exception 'this bot is not allowed to send messages' using errcode = 'insufficient_privilege';
  end if;
  if lower(coalesce(v_a.payload ->> 'platform', '')) in ('impact', 'impact.com') and not ('impact.manage' = any (v_w.capabilities)) then
    raise exception 'this bot is not allowed to act on impact.com' using errcode = 'insufficient_privilege';
  end if;
  if v_w.daily_action_budget is not null then
    select count(*) into v_used from public.approval_events e
     where e.event_type = 'execution_started' and e.details ->> 'executor' = v_w.id::text
       and e.created_at > now() - interval '24 hours';
    if v_used >= v_w.daily_action_budget then
      raise exception 'daily action limit reached (% in the last 24 hours)', v_used using errcode = 'too_many_connections';
    end if;
  end if;

  v_a := private.begin_approval_execution(p_approval_id, p_payload_hash, v_w.id::text);
  if v_a.id is null then
    select * into v_a from public.approvals where id = p_approval_id;
    return jsonb_build_object('approval_id', v_a.id, 'executable', false, 'status', v_a.status);
  end if;
  return jsonb_build_object('approval_id', v_a.id, 'executable', true, 'status', v_a.status, 'payload', v_a.payload, 'payload_hash', v_a.payload_hash,
                            'note', 'Execute exactly this payload once, then call reportActionOutcome with provider evidence.');
end;
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261115000100', 'owner_tasks_and_impact') on conflict do nothing;
commit;
select 'Update 20261115000100 applied' as result;
