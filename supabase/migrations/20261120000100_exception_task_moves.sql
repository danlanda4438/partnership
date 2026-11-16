-- An exception given to a bot now leaves the Exceptions list right away: it is followed on
-- the Tasks board from then on, like any other task. (If that task gets blocked or fails, it
-- shows up here again as a blocked or failed task.) A closed exception still leaves the list
-- too, and either comes back if its record changes again later.

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
  )
  select coalesce(jsonb_agg(r.x order by r.x->>'since' desc), '[]'::jsonb)
  from raw r
  where not exists (
    select 1 from public.exception_followups ef
    where ef.workspace_id = p_workspace_id and ef.exception_kind = r.x->>'kind' and ef.exception_id = r.x->>'id'
      and ef.created_at >= (r.x->>'since')::timestamptz);
$$;
