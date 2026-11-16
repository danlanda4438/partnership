-- Follow up on an exception from the Exceptions page:
--   * Close it: the owner has dealt with it (or decided it doesn't matter). It leaves the list.
--     The underlying record is not changed. If the same thing goes wrong again later
--     (the record changes after the close), it comes back.
--   * Give it to a bot: creates a normal task for a chosen bot with the problem written into
--     the instructions. The exception stays on the list marked "with <bot>" and leaves the list
--     when that task is done. Approvals still apply to anything outward-facing.

create table public.exception_followups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  exception_kind text not null check (length(exception_kind) between 1 and 100),
  exception_id text not null check (length(exception_id) between 1 and 100),
  action text not null check (action in ('closed', 'task')),
  note text check (note is null or length(note) <= 2000),
  task_id uuid,
  created_by_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.tasks (workspace_id, id),
  check ((action = 'task') = (task_id is not null))
);
create index exception_followups_item on public.exception_followups (workspace_id, exception_kind, exception_id, created_at desc);
alter table public.exception_followups enable row level security;
revoke all on public.exception_followups from anon, authenticated;
grant select on public.exception_followups to authenticated;
create policy exception_followups_select on public.exception_followups for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
create trigger exception_followups_immutable before update or delete on public.exception_followups
  for each row execute function private.forbid_mutation();

-- The list now leaves out closed items and items whose bot task is done, and shows
-- which bot is working on the rest.
create or replace function public.ui_exceptions(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with raw as (
    select jsonb_build_object('kind', 'task_' || t.status, 'id', t.id, 'title', t.title,
      'detail', coalesce(t.blocked_reason, 'Retries exhausted'), 'since', t.updated_at,
      'opportunity_id', t.opportunity_id, 'link', '/tasks?view=board#' || t.id,
      'channel_kind', c.kind) as x
    from public.tasks t left join public.channels c on c.id = t.channel_id
    where t.workspace_id = p_workspace_id and t.status in ('blocked', 'dead_lettered')
    union all
    select jsonb_build_object('kind', 'approval_' || a.status, 'id', a.id, 'title', a.summary,
      'detail', case a.status when 'execution_uncertain' then 'Outcome unknown — reconcile with the provider before any retry'
                              else 'Execution failed' end,
      'since', a.updated_at, 'opportunity_id', a.opportunity_id, 'link', '/approvals/' || a.id,
      'channel_kind', c.kind)
    from public.approvals a
    left join public.opportunities o on o.id = a.opportunity_id
    left join public.channels c on c.id = o.channel_id
    where a.workspace_id = p_workspace_id and a.status in ('execution_uncertain', 'execution_failed')
    union all
    select jsonb_build_object('kind', 'opportunity_' || v.disposition, 'id', v.id,
      'title', v.organization_name || ' (' || v.channel_name || ')',
      'detail', case v.disposition when 'needs_verification' then 'Needs verification' else 'Blocked' end,
      'since', v.updated_at, 'opportunity_id', v.id, 'link', '/opportunities/' || v.id,
      'channel_kind', v.channel_kind)
    from public.opportunity_pipeline v where v.workspace_id = p_workspace_id and v.disposition in ('blocked', 'needs_verification')
    union all
    select jsonb_build_object('kind', 'campaign_' || c.status, 'id', c.id, 'title', c.name,
      'detail', 'Campaign ' || c.status || coalesce(' — ' || c.health_note, ''), 'since', coalesce(c.status_checked_at, c.updated_at),
      'opportunity_id', null, 'link', '/integrations', 'channel_kind', ch.kind)
    from public.campaigns c left join public.channels ch on ch.id = c.channel_id
    where c.workspace_id = p_workspace_id and c.status in ('error', 'paused')
    union all
    select jsonb_build_object('kind', 'connection_' || ic.status, 'id', ic.id, 'title', ic.display_name,
      'detail', coalesce(ic.blocked_reason, ic.last_error, 'Connection ' || ic.status), 'since', ic.updated_at,
      'opportunity_id', null, 'link', '/integrations', 'channel_kind', null)
    from public.integration_connections ic where ic.workspace_id = p_workspace_id and ic.status in ('degraded', 'blocked', 'revoked')
    union all
    select jsonb_build_object('kind', 'identity_ambiguous', 'id', min(ci.id::text), 'title', min(ci.value),
      'detail', 'Claimed by ' || count(distinct ci.contact_id) || ' different contacts and not verified — review before merging',
      'since', max(ci.created_at), 'opportunity_id', null, 'link', null, 'channel_kind', null)
    from public.contact_identities ci
    where ci.workspace_id = p_workspace_id
      and exists (select 1 from public.contact_identities o2
                  where o2.workspace_id = ci.workspace_id and o2.kind = ci.kind
                    and o2.normalized_value = ci.normalized_value and o2.contact_id <> ci.contact_id)
    group by ci.kind, ci.normalized_value
    having bool_or(not ci.is_verified)
  ),
  withf as (
    select r.x, f.action, f.task_id, f.created_at as f_at, t.status as task_status, w.name as worker_name
    from raw r
    left join lateral (
      select ef.* from public.exception_followups ef
      where ef.workspace_id = p_workspace_id and ef.exception_kind = r.x->>'kind' and ef.exception_id = r.x->>'id'
        and ef.created_at >= (r.x->>'since')::timestamptz
      order by ef.created_at desc limit 1
    ) f on true
    left join public.tasks t on t.id = f.task_id
    left join public.worker_identities w on w.id = t.assigned_worker_id
  )
  select coalesce(jsonb_agg(
      x || jsonb_build_object('followup', case when action = 'task' then jsonb_build_object(
             'task_id', task_id, 'task_status', task_status, 'worker_name', worker_name, 'at', f_at) end)
      order by x->>'since' desc), '[]'::jsonb)
  from withf
  where action is null or (action = 'task' and task_status is distinct from 'succeeded');
$$;

-- Close an exception (owner, admin or member). Only items currently on the list can be closed.
create function public.close_exception(p_workspace_id uuid, p_kind text, p_item_id text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_workspace_role(p_workspace_id, array['owner','admin','member']::public.member_role[]) then
    raise exception 'not authorized to close exceptions in this workspace' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.ui_exceptions(p_workspace_id)) e
                 where e->>'kind' = p_kind and e->>'id' = p_item_id) then
    raise exception 'that exception is no longer open' using errcode = 'no_data_found';
  end if;
  insert into public.exception_followups (workspace_id, exception_kind, exception_id, action, note, created_by_user_id)
  values (p_workspace_id, p_kind, p_item_id, 'closed', nullif(left(trim(coalesce(p_note, '')), 2000), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Give an exception to a bot: creates a task (same rules as create_task) describing the problem.
create function public.exception_to_task(p_workspace_id uuid, p_kind text, p_item_id text, p_channel public.channel_kind,
                                         p_assign_to uuid default null, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_opp uuid;
  v_task uuid;
  v_note text := nullif(left(trim(coalesce(p_note, '')), 2000), '');
begin
  if not private.has_workspace_role(p_workspace_id, array['owner','admin','member']::public.member_role[]) then
    raise exception 'not authorized to create tasks in this workspace' using errcode = 'insufficient_privilege';
  end if;
  select e into v_item from jsonb_array_elements(public.ui_exceptions(p_workspace_id)) e
   where e->>'kind' = p_kind and e->>'id' = p_item_id;
  if v_item is null then
    raise exception 'that exception is no longer open' using errcode = 'no_data_found';
  end if;
  -- Link the partner only when it belongs to the chosen program.
  if v_item->>'opportunity_id' is not null and exists (
    select 1 from public.opportunities o join public.channels c on c.id = o.channel_id
    where o.id = (v_item->>'opportunity_id')::uuid and c.kind = p_channel
  ) then
    v_opp := (v_item->>'opportunity_id')::uuid;
  end if;

  v_task := public.create_task(
    p_workspace_id, p_channel,
    'Follow up: ' || left(v_item->>'title', 280),
    'The owner asked you to follow up on this exception from the Exceptions page.' || chr(10) || chr(10) ||
    'Problem: ' || (v_item->>'title') || chr(10) ||
    'What the app says: ' || coalesce(v_item->>'detail', '') || chr(10) ||
    'Type: ' || p_kind || ' · id: ' || p_item_id || chr(10) ||
    coalesce('Owner''s note: ' || v_note || chr(10), '') || chr(10) ||
    'Find out what went wrong and sort it out if you can. Emails and impact.com actions still need the owner''s approval. ' ||
    'Report what you found and did when you finish, or reportBlocked if you need a decision.',
    p_assign_to, v_opp, null, 20);

  insert into public.exception_followups (workspace_id, exception_kind, exception_id, action, note, task_id, created_by_user_id)
  values (p_workspace_id, p_kind, p_item_id, 'task', v_note, v_task, auth.uid());
  return v_task;
end;
$$;

revoke all on function public.close_exception(uuid, text, text, text) from public, anon;
grant execute on function public.close_exception(uuid, text, text, text) to authenticated;
revoke all on function public.exception_to_task(uuid, text, text, public.channel_kind, uuid, text) from public, anon;
grant execute on function public.exception_to_task(uuid, text, text, public.channel_kind, uuid, text) to authenticated;
