-- Gleeday update: 20261109000100_operations_read_models.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261109000100') then
    raise exception 'Update 20261109000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600')) < 6 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Phase 3: operational read models, metrics, UI mutations, notification preferences.
--
-- Every function here is SECURITY INVOKER (Postgres default) unless stated otherwise,
-- so Row Level Security of the calling user applies to everything it reads or writes.
-- The web app reads through these functions, which keeps screen logic testable in SQL.

-- Give unnamed Phase 1 constraints names that explain themselves in error messages.
alter table public.opportunities rename constraint opportunities_check to opportunities_stage_requires_evidence;
alter table public.opportunities rename constraint opportunities_check1 to opportunities_single_owner;

create function private.label(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select replace(p, '_', ' ') $$;

-- ---------------------------------------------------------------------------
-- Audit: stage / disposition / milestone changes become timeline events.
-- ---------------------------------------------------------------------------
create function private.log_opportunity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.stage_changed', 'app', 'system',
            now(), 'exact',
            'Stage: ' || coalesce(private.label(old.stage::text), 'not contacted') || ' → ' || coalesce(private.label(new.stage::text), 'not contacted'),
            jsonb_build_object('from', old.stage, 'to', new.stage, 'evidence_event_id', new.stage_evidence_event_id));
  end if;
  if new.disposition is distinct from old.disposition then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.disposition_changed', 'app', 'system',
            now(), 'exact',
            'Disposition: ' || coalesce(private.label(old.disposition::text), 'none') || ' → ' || coalesce(private.label(new.disposition::text), 'none'),
            jsonb_build_object('from', old.disposition, 'to', new.disposition));
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.milestone_changed', 'app', 'system',
            now(), 'exact',
            'Milestone: ' || coalesce(private.label(old.milestone_key), 'none') || ' → ' || coalesce(private.label(new.milestone_key), 'none'),
            jsonb_build_object('from', old.milestone_key, 'to', new.milestone_key));
  end if;
  return null;
end;
$$;
create trigger opportunities_log_change after update of stage, disposition, milestone_key on public.opportunities
  for each row execute function private.log_opportunity_change();

-- ---------------------------------------------------------------------------
-- Notification preferences (delivery is implemented by the worker in a later phase;
-- nothing is scheduled automatically).
-- ---------------------------------------------------------------------------
create type public.digest_cadence as enum ('off', 'daily', 'weekdays', 'weekly');

create table public.notification_preferences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  digest_cadence public.digest_cadence not null default 'off',
  digest_local_time time not null default '08:30',
  digest_weekday smallint not null default 0 check (digest_weekday between 0 and 6),  -- 0 = Sunday
  digest_timezone text not null default 'Asia/Jerusalem',
  notify_approvals boolean not null default true,
  notify_exceptions boolean not null default true,
  notify_material_changes boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create trigger notification_preferences_updated_at before update on public.notification_preferences
  for each row execute function private.set_updated_at();
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
create policy notification_preferences_select on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.member_workspace_ids()));
create policy notification_preferences_insert on public.notification_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and workspace_id in (select private.member_workspace_ids()));
create policy notification_preferences_update on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.member_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select private.member_workspace_ids()));

-- ---------------------------------------------------------------------------
-- Metrics
-- Distinguishes opportunities (channel engagements), organizations, contacts and message
-- events; attempts vs acceptance vs bounces vs uncertain; human vs automatic replies;
-- platform labels vs content assessments. One row per channel, 'unassigned' for messages
-- not linked to an opportunity, and 'all' with cross-channel de-duplication (distinct counts,
-- never a sum of channel rows).
-- Funnel/stage counts are CURRENT state. Message metrics respect [p_from, p_to); undated
-- messages are excluded from date-filtered counts and reported in undated_messages.
-- ---------------------------------------------------------------------------
create function public.workspace_metrics(p_workspace_id uuid, p_from timestamptz default null, p_to timestamptz default null)
returns table (
  scope text,
  opportunities bigint,
  inventory bigint,
  by_stage jsonb,
  by_disposition jsonb,
  organizations_engaged bigint,
  contacts_reached bigint,
  message_events bigint,
  outbound_attempts bigint,
  outbound_accepted bigint,
  bounced bigint,
  failed bigint,
  uncertain bigint,
  drafts bigint,
  inbound_messages bigint,
  human_replies bigint,
  automatic_replies bigint,
  unassessed_replies bigint,
  platform_positive_labels bigint,
  paid_only_replies bigint,
  undated_messages bigint,
  active_opportunities bigint,
  verified_last_30_days bigint,
  last_evidence_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  with scopes(sc) as (
    values ('affiliates'), ('co_marketing'), ('media_pr'), ('listings'), ('unassigned'), ('all')
  ),
  opp as (
    select o.*, s.sc
    from public.opportunities o
    join public.channels c on c.id = o.channel_id
    cross join lateral (values (c.kind::text), ('all')) s(sc)
    where o.workspace_id = p_workspace_id
  ),
  msg_all as (
    select m.*, s.sc
    from public.messages m
    left join public.opportunities o on o.id = m.opportunity_id
    left join public.channels c on c.id = o.channel_id
    cross join lateral (values (coalesce(c.kind::text, 'unassigned')), ('all')) s(sc)
    where m.workspace_id = p_workspace_id
  ),
  msg as (
    select * from msg_all
    where (p_from is null and p_to is null)
       or (occurred_at is not null
           and (p_from is null or occurred_at >= p_from)
           and (p_to is null or occurred_at < p_to))
  ),
  latest_assessment as (
    select distinct on (a.message_id, a.source) a.*
    from public.reply_assessments a
    where a.workspace_id = p_workspace_id
    order by a.message_id, a.source, a.assessed_at desc, a.id
  ),
  opp_stats as (
    select sc,
      count(*) filter (where stage is not null) as opportunities,
      count(*) filter (where stage is null) as inventory,
      count(distinct organization_id) filter (where stage is not null) as organizations_engaged,
      count(*) filter (where stage is not null and stage <> 'live'
                        and (disposition is null or disposition not in ('declined', 'bounced'))) as active_opportunities,
      count(*) filter (where stage is not null and stage <> 'live'
                        and (disposition is null or disposition not in ('declined', 'bounced'))
                        and last_verified_at >= now() - interval '30 days') as verified_last_30_days
    from opp group by sc
  ),
  stage_counts as (
    select sc, jsonb_object_agg(stage, n) as by_stage
    from (select sc, stage::text as stage, count(*) as n from opp where stage is not null group by sc, stage) x
    group by sc
  ),
  disposition_counts as (
    select sc, jsonb_object_agg(disposition, n) as by_disposition
    from (select sc, disposition::text as disposition, count(*) as n from opp where disposition is not null group by sc, disposition) x
    group by sc
  ),
  msg_stats as (
    select m.sc,
      count(*) filter (where m.status <> 'draft') as message_events,
      count(distinct m.contact_id) filter (where m.direction = 'outbound' and m.status in ('sent', 'delivered')) as contacts_reached,
      count(*) filter (where m.direction = 'outbound' and m.status in ('sent', 'delivered', 'bounced', 'failed', 'uncertain')) as outbound_attempts,
      count(*) filter (where m.direction = 'outbound' and m.status in ('sent', 'delivered')) as outbound_accepted,
      count(*) filter (where m.direction = 'outbound' and m.status = 'bounced') as bounced,
      count(*) filter (where m.direction = 'outbound' and m.status = 'failed') as failed,
      count(*) filter (where m.direction = 'outbound' and m.status = 'uncertain') as uncertain,
      count(*) filter (where m.status = 'draft') as drafts,
      count(*) filter (where m.direction = 'inbound') as inbound_messages,
      count(*) filter (where m.direction = 'inbound' and m.is_automatic = false) as human_replies,
      count(*) filter (where m.direction = 'inbound' and m.is_automatic = true) as automatic_replies,
      count(*) filter (where m.direction = 'inbound' and m.is_automatic is null) as unassessed_replies,
      count(*) filter (where m.direction = 'inbound' and exists (
        select 1 from latest_assessment a where a.message_id = m.id and a.source = 'platform'
          and lower(a.platform_label) in ('interested', 'meeting booked', 'meeting completed', 'won'))) as platform_positive_labels,
      count(*) filter (where m.direction = 'inbound' and exists (
        select 1 from latest_assessment a where a.message_id = m.id and a.source in ('human', 'automatic')
          and a.classification = 'paid_only')) as paid_only_replies
    from msg m group by m.sc
  ),
  undated as (
    select sc, count(*) as undated_messages from msg_all where occurred_at is null and status <> 'draft' group by sc
  ),
  evidence as (
    select s.sc, max(e.recorded_at) as last_evidence_at
    from public.activity_events e
    left join public.opportunities o on o.id = e.opportunity_id
    left join public.channels c on c.id = o.channel_id
    cross join lateral (values (coalesce(c.kind::text, 'unassigned')), ('all')) s(sc)
    where e.workspace_id = p_workspace_id
    group by s.sc
  )
  select s.sc,
    coalesce(o.opportunities, 0), coalesce(o.inventory, 0),
    coalesce(st.by_stage, '{}'::jsonb), coalesce(dc.by_disposition, '{}'::jsonb),
    coalesce(o.organizations_engaged, 0), coalesce(m.contacts_reached, 0), coalesce(m.message_events, 0),
    coalesce(m.outbound_attempts, 0), coalesce(m.outbound_accepted, 0), coalesce(m.bounced, 0),
    coalesce(m.failed, 0), coalesce(m.uncertain, 0), coalesce(m.drafts, 0),
    coalesce(m.inbound_messages, 0), coalesce(m.human_replies, 0), coalesce(m.automatic_replies, 0),
    coalesce(m.unassessed_replies, 0), coalesce(m.platform_positive_labels, 0), coalesce(m.paid_only_replies, 0),
    coalesce(u.undated_messages, 0), coalesce(o.active_opportunities, 0), coalesce(o.verified_last_30_days, 0),
    ev.last_evidence_at
  from scopes s
  left join opp_stats o on o.sc = s.sc
  left join stage_counts st on st.sc = s.sc
  left join disposition_counts dc on dc.sc = s.sc
  left join msg_stats m on m.sc = s.sc
  left join undated u on u.sc = s.sc
  left join evidence ev on ev.sc = s.sc;
$$;

-- ---------------------------------------------------------------------------
-- Read models for screens (return jsonb; RLS applies)
-- ---------------------------------------------------------------------------
create function public.ui_context()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', (select auth.uid()),
    'email', (select auth.jwt()) ->> 'email',
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug,
                                          'display_timezone', w.display_timezone, 'role', m.role) order by w.name)
      from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
      where m.user_id = (select auth.uid()) and m.status = 'active'), '[]'::jsonb)
  );
$$;

create function public.ui_pipeline(p_workspace_id uuid, p_channel public.channel_kind)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.next_action_due_at nulls last, p.organization_name), '[]'::jsonb)
  from (
    select v.*,
      (select ci.value from public.contact_identities ci
        where ci.contact_id = v.primary_contact_id and ci.kind = 'email'
        order by ci.is_verified desc, ci.created_at limit 1) as primary_contact_email,
      (select count(*) from public.activity_events e where e.opportunity_id = v.id) as event_count
    from public.opportunity_pipeline v
    where v.workspace_id = p_workspace_id and v.channel_kind = p_channel
  ) p;
$$;

create function public.ui_opportunity(p_opportunity_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'opportunity', to_jsonb(v),
    'stage_evidence_event_id', o.stage_evidence_event_id,
    'organization', (
      select jsonb_build_object('id', org.id, 'name', org.name, 'website', org.website,
        'location_label', org.location_label, 'country', org.country, 'notes', org.notes,
        'parent', (select jsonb_build_object('id', p.id, 'name', p.name) from public.organizations p where p.id = org.parent_organization_id),
        'aliases', coalesce((select jsonb_agg(jsonb_build_object('alias', a.alias, 'justification', a.justification))
                             from public.organization_aliases a where a.organization_id = org.id), '[]'::jsonb))
      from public.organizations org where org.id = o.organization_id),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'full_name', c.full_name, 'job_title', c.job_title,
          'is_primary', c.id = o.primary_contact_id,
          'identities', coalesce((select jsonb_agg(jsonb_build_object('kind', ci.kind, 'value', ci.value,
                                    'is_verified', ci.is_verified, 'verification_source', ci.verification_source)
                                    order by ci.kind, ci.value)
                                  from public.contact_identities ci where ci.contact_id = c.id), '[]'::jsonb))
        order by (c.id = o.primary_contact_id) desc, c.full_name)
      from public.contacts c
      where c.id = o.primary_contact_id
         or c.id in (select oc.contact_id from public.opportunity_contacts oc where oc.opportunity_id = o.id)), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(x.t order by x.sort_at desc nulls last, x.t->>'id')
      from (
        select coalesce(e.occurred_at, e.recorded_at) as sort_at, jsonb_build_object(
          'kind', 'event', 'id', e.id, 'event_type', e.event_type, 'source', e.source, 'summary', e.summary,
          'occurred_at', e.occurred_at, 'precision', e.occurred_at_precision, 'recorded_at', e.recorded_at,
          'sort_at', coalesce(e.occurred_at, e.recorded_at),
          'actor_kind', e.actor_kind,
          'actor_worker', (select w.name from public.worker_identities w where w.id = e.actor_worker_id),
          'message', (select jsonb_build_object('id', m.id, 'direction', m.direction, 'status', m.status,
                        'subject', m.subject, 'from', m.from_address, 'to', m.to_addresses,
                        'body_text', m.body_text, 'provider', m.provider, 'provider_message_id', m.provider_message_id,
                        'is_automatic', m.is_automatic)
                      from public.messages m where m.id = e.message_id),
          'provenance', (select jsonb_build_object('file', sf.title, 'url', sf.url, 'tab', sr.tab_name, 'row', sr.row_number)
                         from public.source_rows sr join public.source_files sf on sf.id = sr.source_file_id
                         where sr.id = e.source_row_id)) as t
        from public.activity_events e where e.opportunity_id = o.id
        union all
        select coalesce(m.occurred_at, m.created_at) as sort_at, jsonb_build_object(
          'kind', 'message', 'id', m.id, 'event_type', 'message.' || m.direction, 'source', m.provider,
          'summary', m.subject, 'occurred_at', m.occurred_at, 'precision', m.occurred_at_precision,
          'recorded_at', m.created_at, 'sort_at', coalesce(m.occurred_at, m.created_at), 'actor_kind', null,
          'message', jsonb_build_object('id', m.id, 'direction', m.direction, 'status', m.status,
                        'subject', m.subject, 'from', m.from_address, 'to', m.to_addresses,
                        'body_text', m.body_text, 'provider', m.provider, 'provider_message_id', m.provider_message_id,
                        'is_automatic', m.is_automatic,
                        'assessments', coalesce((select jsonb_agg(jsonb_build_object('source', a.source,
                            'classification', a.classification, 'platform_label', a.platform_label,
                            'conditions', a.conditions, 'is_human_reply', a.is_human_reply, 'assessed_at', a.assessed_at)
                            order by a.assessed_at desc)
                          from public.reply_assessments a where a.message_id = m.id), '[]'::jsonb)),
          'provenance', (select jsonb_build_object('file', sf.title, 'url', sf.url, 'tab', sr.tab_name, 'row', sr.row_number)
                         from public.source_rows sr join public.source_files sf on sf.id = sr.source_file_id
                         where sr.id = m.source_row_id))
        from public.messages m
        where m.opportunity_id = o.id
          and not exists (select 1 from public.activity_events e2 where e2.message_id = m.id)
      ) x), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'terms', f.terms,
        'amount', f.amount, 'currency', f.currency, 'is_paid', f.is_paid, 'status', f.status,
        'io_signed', f.io_signed, 'approval_id', f.approval_id, 'created_at', f.created_at) order by f.created_at desc)
      from public.offers f where f.opportunity_id = o.id), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name,
        'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'storage_path', a.storage_path, 'created_at', a.created_at)
        order by a.created_at desc)
      from public.attachments a where a.opportunity_id = o.id), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind,
        'status', t.status, 'due_at', t.due_at, 'blocked_reason', t.blocked_reason,
        'worker', (select w.name from public.worker_identities w where w.id = t.assigned_worker_id)) order by t.created_at desc)
      from public.tasks t where t.opportunity_id = o.id), '[]'::jsonb),
    'approvals', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'summary', a.summary,
        'action_type', a.action_type, 'status', a.status, 'created_at', a.created_at) order by a.created_at desc)
      from public.approvals a where a.opportunity_id = o.id), '[]'::jsonb),
    'sibling_opportunities', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'channel_kind', s.channel_kind,
        'stage', s.stage, 'disposition', s.disposition))
      from public.opportunity_pipeline s where s.organization_id = o.organization_id and s.id <> o.id), '[]'::jsonb),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('key', cm.key, 'label', cm.label) order by cm.ordinal)
      from public.channel_milestones cm where cm.channel_kind = v.channel_kind), '[]'::jsonb),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) order by w.name)
      from public.worker_identities w where w.workspace_id = o.workspace_id and w.status <> 'revoked'), '[]'::jsonb)
  )
  from public.opportunities o
  join public.opportunity_pipeline v on v.id = o.id
  where o.id = p_opportunity_id;
$$;

create function public.ui_tasks(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'kind', t.kind, 'status', t.status, 'priority', t.priority,
      'channel_kind', c.kind, 'opportunity_id', t.opportunity_id, 'organization_name', org.name,
      'worker', w.name, 'due_at', t.due_at, 'attempt_count', t.attempt_count, 'max_attempts', t.max_attempts,
      'lease_expires_at', t.lease_expires_at, 'blocked_reason', t.blocked_reason,
      'created_at', t.created_at, 'updated_at', t.updated_at)
    order by t.priority, t.due_at nulls last, t.created_at), '[]'::jsonb)
  from public.tasks t
  left join public.channels c on c.id = t.channel_id
  left join public.worker_identities w on w.id = t.assigned_worker_id
  left join public.opportunities o on o.id = t.opportunity_id
  left join public.organizations org on org.id = o.organization_id
  where t.workspace_id = p_workspace_id
    and (t.status not in ('succeeded', 'cancelled') or t.updated_at > now() - interval '14 days');
$$;

create function public.ui_approvals(p_workspace_id uuid, p_status public.approval_status default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'summary', a.summary, 'action_type', a.action_type, 'status', a.status,
      'created_at', a.created_at, 'expires_at', a.expires_at, 'decided_at', a.decided_at,
      'proposed_by', coalesce(w.name, 'a person'), 'opportunity_id', a.opportunity_id,
      'organization_name', org.name, 'channel_kind', c.kind)
    order by a.created_at desc), '[]'::jsonb)
  from public.approvals a
  left join public.worker_identities w on w.id = a.proposed_by_worker_id
  left join public.opportunities o on o.id = a.opportunity_id
  left join public.organizations org on org.id = o.organization_id
  left join public.channels c on c.id = o.channel_id
  where a.workspace_id = p_workspace_id
    and (p_status is null or a.status = p_status)
    and (p_status is not null or a.created_at > now() - interval '30 days' or a.status = 'pending');
$$;

create function public.ui_approval(p_approval_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'summary', a.summary, 'action_type', a.action_type, 'status', a.status,
    'payload', a.payload, 'payload_hash', a.payload_hash,
    'created_at', a.created_at, 'expires_at', a.expires_at, 'is_expired', a.expires_at <= now(),
    'decided_at', a.decided_at, 'decision_note', a.decision_note,
    'executed_at', a.executed_at, 'execution_evidence', a.execution_evidence,
    'proposed_by', coalesce(w.name, 'a person'), 'opportunity_id', a.opportunity_id,
    'organization_name', org.name, 'channel_kind', c.kind, 'task_id', a.task_id, 'task_title', t.title,
    'history', coalesce((select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'to_status', e.to_status,
        'actor_kind', e.actor_kind, 'note', e.note, 'created_at', e.created_at) order by e.created_at, e.id)
      from public.approval_events e where e.approval_id = a.id), '[]'::jsonb))
  from public.approvals a
  left join public.worker_identities w on w.id = a.proposed_by_worker_id
  left join public.opportunities o on o.id = a.opportunity_id
  left join public.organizations org on org.id = o.organization_id
  left join public.channels c on c.id = o.channel_id
  left join public.tasks t on t.id = a.task_id
  where a.id = p_approval_id;
$$;

-- Everything that needs a human: blocked work, uncertain outcomes, unhealthy campaigns and
-- connections, records needing verification, and ambiguous identities.
create function public.ui_exceptions(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x->>'since' desc), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'task_' || t.status, 'id', t.id, 'title', t.title,
      'detail', coalesce(t.blocked_reason, 'Retries exhausted'), 'since', t.updated_at,
      'opportunity_id', t.opportunity_id, 'link', '/tasks#' || t.id) as x
    from public.tasks t where t.workspace_id = p_workspace_id and t.status in ('blocked', 'dead_lettered')
    union all
    select jsonb_build_object('kind', 'approval_' || a.status, 'id', a.id, 'title', a.summary,
      'detail', case a.status when 'execution_uncertain' then 'Outcome unknown — reconcile with the provider before any retry'
                              else 'Execution failed' end,
      'since', a.updated_at, 'opportunity_id', a.opportunity_id, 'link', '/approvals/' || a.id)
    from public.approvals a where a.workspace_id = p_workspace_id and a.status in ('execution_uncertain', 'execution_failed')
    union all
    select jsonb_build_object('kind', 'opportunity_' || v.disposition, 'id', v.id,
      'title', v.organization_name || ' (' || v.channel_name || ')',
      'detail', case v.disposition when 'needs_verification' then 'Needs verification' else 'Blocked' end,
      'since', v.updated_at, 'opportunity_id', v.id, 'link', '/opportunities/' || v.id)
    from public.opportunity_pipeline v where v.workspace_id = p_workspace_id and v.disposition in ('blocked', 'needs_verification')
    union all
    select jsonb_build_object('kind', 'campaign_' || c.status, 'id', c.id, 'title', c.name,
      'detail', 'Campaign ' || c.status || coalesce(' — ' || c.health_note, ''), 'since', coalesce(c.status_checked_at, c.updated_at),
      'opportunity_id', null, 'link', '/integrations')
    from public.campaigns c where c.workspace_id = p_workspace_id and c.status in ('error', 'paused')
    union all
    select jsonb_build_object('kind', 'connection_' || ic.status, 'id', ic.id, 'title', ic.display_name,
      'detail', coalesce(ic.blocked_reason, ic.last_error, 'Connection ' || ic.status), 'since', ic.updated_at,
      'opportunity_id', null, 'link', '/integrations')
    from public.integration_connections ic where ic.workspace_id = p_workspace_id and ic.status in ('degraded', 'blocked', 'revoked')
    union all
    select jsonb_build_object('kind', 'identity_ambiguous', 'id', min(ci.id::text), 'title', min(ci.value),
      'detail', 'Claimed by ' || count(distinct ci.contact_id) || ' different contacts and not verified — review before merging',
      'since', max(ci.created_at), 'opportunity_id', null, 'link', null)
    from public.contact_identities ci
    where ci.workspace_id = p_workspace_id
      and exists (select 1 from public.contact_identities o2
                  where o2.workspace_id = ci.workspace_id and o2.kind = ci.kind
                    and o2.normalized_value = ci.normalized_value and o2.contact_id <> ci.contact_id)
    group by ci.kind, ci.normalized_value
    having bool_or(not ci.is_verified)
  ) s;
$$;

create function public.ui_daily(p_workspace_id uuid, p_since timestamptz default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'since', coalesce(p_since, now() - interval '24 hours'),
    'pending_approvals', public.ui_approvals(p_workspace_id, 'pending'),
    'exceptions', public.ui_exceptions(p_workspace_id),
    'due', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'organization_name', v.organization_name,
          'channel_kind', v.channel_kind, 'stage', v.stage, 'next_action', v.next_action,
          'next_action_due_at', v.next_action_due_at, 'owner_worker_name', v.owner_worker_name,
          'overdue', v.next_action_due_at < now()) order by v.next_action_due_at)
        from public.opportunity_pipeline v
        where v.workspace_id = p_workspace_id and v.next_action_due_at < now() + interval '2 days'
          and (v.disposition is null or v.disposition not in ('declined', 'bounced'))), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'event_type', e.event_type,
          'summary', e.summary, 'recorded_at', e.recorded_at, 'opportunity_id', e.opportunity_id,
          'organization_name', org.name, 'channel_kind', c.kind, 'actor_kind', e.actor_kind,
          'actor_worker', w.name) order by e.recorded_at desc)
        from (select * from public.activity_events
              where workspace_id = p_workspace_id and recorded_at >= coalesce(p_since, now() - interval '24 hours')
                and event_type <> 'note.added'
              order by recorded_at desc limit 50) e
        left join public.opportunities o on o.id = e.opportunity_id
        left join public.organizations org on org.id = o.organization_id
        left join public.channels c on c.id = o.channel_id
        left join public.worker_identities w on w.id = e.actor_worker_id), '[]'::jsonb)
  );
$$;

create function public.ui_bots(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'role', w.role, 'description', w.description, 'status', w.status,
      'capabilities', w.capabilities, 'max_concurrent_tasks', w.max_concurrent_tasks,
      'daily_action_budget', w.daily_action_budget,
      'channels', coalesce((select jsonb_agg(c.kind order by c.kind) from public.worker_channel_scopes s
                            join public.channels c on c.id = s.channel_id where s.worker_id = w.id), '[]'::jsonb),
      'active_attempts', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'active'),
      'succeeded_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'succeeded'
                       and a.finished_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status in ('failed', 'expired')
                    and a.finished_at > now() - interval '7 days'),
      'blocked_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'blocked'
                     and a.finished_at > now() - interval '7 days'),
      'last_seen_at', (select max(a.heartbeat_at) from public.task_attempts a where a.worker_id = w.id))
    order by w.name), '[]'::jsonb)
  from public.worker_identities w
  where w.workspace_id = p_workspace_id;
$$;

create function public.ui_integrations(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'connections', coalesce((select jsonb_agg(jsonb_build_object('id', ic.id, 'provider', ic.provider,
        'display_name', ic.display_name, 'status', ic.status, 'account_identity', ic.account_identity,
        'scopes', ic.scopes, 'blocked_reason', ic.blocked_reason, 'last_checked_at', ic.last_checked_at,
        'last_error', ic.last_error,
        'cursors', coalesce((select jsonb_agg(jsonb_build_object('stream', sc.stream, 'last_synced_at', sc.last_synced_at,
                               'last_success_at', sc.last_success_at))
                             from public.sync_cursors sc where sc.connection_id = ic.id), '[]'::jsonb))
        order by ic.provider)
      from public.integration_connections ic where ic.workspace_id = p_workspace_id), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'provider', c.provider,
        'status', c.status, 'status_checked_at', c.status_checked_at, 'health_note', c.health_note,
        'channel_kind', ch.kind) order by c.name)
      from public.campaigns c left join public.channels ch on ch.id = c.channel_id
      where c.workspace_id = p_workspace_id), '[]'::jsonb),
    'source_files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'url', f.url,
        'owner_label', f.owner_label, 'channel_kind', ch.kind, 'is_included', f.is_included,
        'exclusion_reason', f.exclusion_reason,
        'rows_captured', (select count(*) from public.source_rows r where r.source_file_id = f.id),
        'tabs', (select count(distinct r.tab_name) from public.source_rows r where r.source_file_id = f.id),
        'last_captured_at', (select max(r.captured_at) from public.source_rows r where r.source_file_id = f.id))
        order by f.title)
      from public.source_files f left join public.channels ch on ch.id = f.channel_id
      where f.workspace_id = p_workspace_id), '[]'::jsonb),
    'import_batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'status', b.status,
        'started_at', b.started_at, 'finished_at', b.finished_at, 'stats', b.stats) order by b.started_at desc)
      from (select * from public.import_batches where workspace_id = p_workspace_id order by started_at desc limit 20) b), '[]'::jsonb)
  );
$$;

-- Member list with emails. SECURITY DEFINER because auth.users is not readable by API roles;
-- only returns rows for workspaces the caller is an active member of.
create function public.ui_members(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('member_id', m.id, 'user_id', m.user_id, 'email', u.email,
      'role', m.role, 'status', m.status, 'is_you', m.user_id = (select auth.uid())) order by m.status, m.role, u.email), '[]'::jsonb)
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = p_workspace_id
    and private.has_workspace_role(p_workspace_id, array['owner','admin','member','viewer']::public.member_role[]);
$$;

create function public.ui_notification_preferences(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select to_jsonb(p) from public.notification_preferences p
      where p.workspace_id = p_workspace_id and p.user_id = (select auth.uid())),
    jsonb_build_object('digest_cadence', 'off', 'digest_local_time', '08:30:00', 'digest_weekday', 0,
                       'digest_timezone', 'Asia/Jerusalem', 'notify_approvals', true, 'notify_exceptions', true,
                       'notify_material_changes', false, 'is_default', true));
$$;

-- ---------------------------------------------------------------------------
-- Mutations used by the UI (SECURITY INVOKER: RLS + table triggers enforce the rules)
-- ---------------------------------------------------------------------------

-- Manual verified activity (LinkedIn/Facebook messages, calls, meetings, submissions,
-- verification checks, notes). Drafts are not an accepted type: they never establish contact.
create function public.record_activity(
  p_opportunity_id uuid,
  p_event_type text,
  p_summary text,
  p_occurred_at timestamptz default null,
  p_precision public.timestamp_precision default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_opp public.opportunities;
  v_id uuid;
begin
  if p_event_type not in ('note.added', 'manual.email_sent', 'manual.linkedin_message_sent', 'manual.facebook_message_sent',
                          'manual.call', 'manual.meeting', 'manual.reply_received', 'manual.submission',
                          'manual.verification', 'manual.agreement', 'manual.live_confirmed') then
    raise exception 'unsupported manual event type %', p_event_type using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(length(trim(p_summary)), 0) = 0 then
    raise exception 'a summary is required' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_opp from public.opportunities where id = p_opportunity_id;
  if not found then
    raise exception 'opportunity not found' using errcode = 'no_data_found';
  end if;

  insert into public.activity_events (workspace_id, opportunity_id, organization_id, contact_id, event_type, source,
                                      occurred_at, occurred_at_precision, actor_kind, summary, evidence)
  values (v_opp.workspace_id, v_opp.id, v_opp.organization_id, v_opp.primary_contact_id, p_event_type, 'manual',
          p_occurred_at,
          case when p_occurred_at is null then 'unknown'::public.timestamp_precision
               else coalesce(p_precision, 'exact'::public.timestamp_precision) end,
          'user', trim(p_summary), coalesce(p_details, '{}'::jsonb))
  returning id into v_id;

  if p_event_type = 'manual.verification' then
    update public.opportunities set last_verified_at = now(), last_verified_event_id = v_id where id = v_opp.id;
  end if;
  return v_id;
end;
$$;

create function public.set_opportunity_stage(p_opportunity_id uuid, p_stage public.opportunity_stage, p_evidence_event_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.opportunities
     set stage = p_stage,
         stage_evidence_event_id = case when p_stage is null then null else p_evidence_event_id end
   where id = p_opportunity_id;
  if not found then
    raise exception 'opportunity not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create function public.set_opportunity_status(
  p_opportunity_id uuid,
  p_disposition public.opportunity_disposition,
  p_milestone_key text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.opportunities
     set disposition = p_disposition,
         milestone_key = nullif(p_milestone_key, ''),
         milestone_changed_at = case when milestone_key is distinct from nullif(p_milestone_key, '') then now() else milestone_changed_at end
   where id = p_opportunity_id;
  if not found then
    raise exception 'opportunity not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create function public.set_opportunity_plan(
  p_opportunity_id uuid,
  p_next_action text,
  p_next_action_due_at timestamptz,
  p_owner_user_id uuid,
  p_owner_worker_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.opportunities where id = p_opportunity_id;
  if v_ws is null then
    raise exception 'opportunity not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_owner_user_id is not null and not exists (
    select 1 from public.workspace_members m where m.workspace_id = v_ws and m.user_id = p_owner_user_id and m.status = 'active'
  ) then
    raise exception 'owner must be an active member of this workspace' using errcode = 'check_violation';
  end if;
  update public.opportunities
     set next_action = nullif(trim(p_next_action), ''),
         next_action_due_at = p_next_action_due_at,
         owner_user_id = p_owner_user_id,
         owner_worker_id = case when p_owner_user_id is null then p_owner_worker_id else null end
   where id = p_opportunity_id;
  if not found then
    raise exception 'opportunity not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create function public.save_notification_preferences(
  p_workspace_id uuid,
  p_digest_cadence public.digest_cadence,
  p_digest_local_time time,
  p_digest_weekday smallint,
  p_notify_approvals boolean,
  p_notify_exceptions boolean,
  p_notify_material_changes boolean
)
returns void
language sql
set search_path = ''
as $$
  insert into public.notification_preferences (workspace_id, user_id, digest_cadence, digest_local_time, digest_weekday,
      notify_approvals, notify_exceptions, notify_material_changes)
  values (p_workspace_id, (select auth.uid()), p_digest_cadence, p_digest_local_time, p_digest_weekday,
      p_notify_approvals, p_notify_exceptions, p_notify_material_changes)
  on conflict (workspace_id, user_id) do update set
    digest_cadence = excluded.digest_cadence, digest_local_time = excluded.digest_local_time,
    digest_weekday = excluded.digest_weekday, notify_approvals = excluded.notify_approvals,
    notify_exceptions = excluded.notify_exceptions, notify_material_changes = excluded.notify_material_changes;
$$;

-- Admin: which channels a bot may work in. SECURITY DEFINER because worker_channel_scopes
-- has no direct write grants (and no API role may DELETE).
create function public.set_worker_channels(p_worker_id uuid, p_channels public.channel_kind[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.worker_identities where id = p_worker_id;
  if v_ws is null or not private.has_workspace_role(v_ws, array['owner','admin']::public.member_role[]) then
    raise exception 'worker not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
  delete from public.worker_channel_scopes s
   using public.channels c
   where s.worker_id = p_worker_id and c.id = s.channel_id and not (c.kind = any (coalesce(p_channels, '{}')));
  insert into public.worker_channel_scopes (workspace_id, worker_id, channel_id)
  select v_ws, p_worker_id, c.id from public.channels c
   where c.workspace_id = v_ws and c.kind = any (coalesce(p_channels, '{}'))
  on conflict do nothing;
end;
$$;

-- Admin: pause/resume a bot and set its limits (administrative pause / backpressure).
-- SECURITY INVOKER: the worker_identities admin-only UPDATE policy decides.
create function public.set_worker_settings(
  p_worker_id uuid,
  p_status public.worker_status,
  p_max_concurrent_tasks integer,
  p_daily_action_budget integer
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.worker_identities
     set status = p_status, max_concurrent_tasks = p_max_concurrent_tasks, daily_action_budget = p_daily_action_budget
   where id = p_worker_id;
  if not found then
    raise exception 'worker not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: never anon; signed-in users only.
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.workspace_metrics(uuid, timestamptz, timestamptz)',
    'public.ui_context()',
    'public.ui_pipeline(uuid, public.channel_kind)',
    'public.ui_opportunity(uuid)',
    'public.ui_tasks(uuid)',
    'public.ui_approvals(uuid, public.approval_status)',
    'public.ui_approval(uuid)',
    'public.ui_exceptions(uuid)',
    'public.ui_daily(uuid, timestamptz)',
    'public.ui_bots(uuid)',
    'public.ui_integrations(uuid)',
    'public.ui_members(uuid)',
    'public.ui_notification_preferences(uuid)',
    'public.record_activity(uuid, text, text, timestamptz, public.timestamp_precision, jsonb)',
    'public.set_opportunity_stage(uuid, public.opportunity_stage, uuid)',
    'public.set_opportunity_status(uuid, public.opportunity_disposition, text)',
    'public.set_opportunity_plan(uuid, text, timestamptz, uuid, uuid)',
    'public.save_notification_preferences(uuid, public.digest_cadence, time, smallint, boolean, boolean, boolean)',
    'public.set_worker_channels(uuid, public.channel_kind[])',
    'public.set_worker_settings(uuid, public.worker_status, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261109000100', 'operations_read_models') on conflict do nothing;
commit;
select 'Update 20261109000100 applied' as result;
