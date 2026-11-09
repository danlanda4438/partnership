-- Phase 2: importing the spreadsheet migration plan into the app (idempotent, provenance-linked).

-- ---------------------------------------------------------------------------
-- Import bookkeeping
-- ---------------------------------------------------------------------------
alter table public.opportunities add column details jsonb not null default '{}'::jsonb;
comment on column public.opportunities.details is 'Source-specific attributes and notes (e.g. imported sheet columns). Not used for authorization or metrics.';

-- Stable natural keys from the import plan → the rows they created. Makes re-runs idempotent.
create table public.import_keys (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  entity_table text not null,
  entity_id uuid not null,
  first_batch_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
select private.apply_workspace_rls('public.import_keys', 'read');

-- Started by the app server after it has checked (live) that the user is an owner/admin.
create function public.import_begin(p_workspace_id uuid, p_user_id uuid, p_meta jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = p_user_id
                 and m.status = 'active' and m.role in ('owner', 'admin')) then
    raise exception 'only owners and admins can import' using errcode = 'insufficient_privilege';
  end if;
  insert into public.import_batches (workspace_id, kind, status, mapping_version, stats)
  values (p_workspace_id, 'upsert', 'running', coalesce(p_meta ->> 'mapping_version', 'v1'), coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

create function public.import_finish(p_batch_id uuid, p_status public.import_batch_status, p_report jsonb)
returns void
language sql
set search_path = ''
as $$
  update public.import_batches set status = p_status, finished_at = now(), report = p_report where id = p_batch_id;
$$;

create function private.import_key(p_ws uuid, p_key text)
returns uuid language sql stable set search_path = ''
as $$ select entity_id from public.import_keys where workspace_id = p_ws and key = p_key $$;

create function private.import_remember(p_ws uuid, p_key text, p_table text, p_id uuid, p_batch uuid)
returns void language sql set search_path = ''
as $$ insert into public.import_keys (workspace_id, key, entity_table, entity_id, first_batch_id)
      values (p_ws, p_key, p_table, p_id, p_batch) on conflict (workspace_id, key) do nothing $$;

-- The latest archived version of a source row (any batch): provenance points at what was imported.
create function private.import_source_row(p_ws uuid, p_batch uuid, p_ref jsonb)
returns uuid language sql stable set search_path = ''
as $$
  select r.id from public.source_rows r join public.source_files f on f.id = r.source_file_id
  where r.workspace_id = p_ws and f.external_file_id = p_ref ->> 'file'
    and r.tab_name = p_ref ->> 'tab' and r.row_number = (p_ref ->> 'row')::integer
  order by r.captured_at desc, r.id limit 1
$$;

create function private.import_link_sources(p_ws uuid, p_batch uuid, p_sources jsonb, p_table text, p_id uuid)
returns void language plpgsql set search_path = ''
as $$
declare
  s jsonb;
  v_row uuid;
begin
  for s in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    v_row := private.import_source_row(p_ws, p_batch, s);
    if v_row is not null then
      insert into public.source_row_targets (workspace_id, source_row_id, target_table, target_id, mapping_version)
      values (p_ws, v_row, p_table, p_id, 'v1') on conflict do nothing;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- import_apply: writes one chunk of the plan. Kinds, in order:
--   source_rows → orgs → contacts → opps → events → finalize → offers → tasks
-- Re-running with the same plan changes nothing; values set later by people or bots are
-- never overwritten (stages only move forward; dispositions/milestones fill blanks).
-- ---------------------------------------------------------------------------
create function public.import_apply(p_workspace_id uuid, p_batch_id uuid, p_kind text, p_items jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  it jsonb;
  v_id uuid;
  v_id2 uuid;
  v_file uuid;
  v_created integer := 0;
  v_existing integer := 0;
  v_skipped integer := 0;
  v_order text[] := array['contacted','replied','interested','discussion_proposal','agreed','live'];
  v_channel uuid;
  v_msg uuid;
  v_event uuid;
  v_cur public.opportunities;
  l jsonb;
  i jsonb;
  a jsonb;
begin
  if not exists (select 1 from public.import_batches b where b.id = p_batch_id and b.workspace_id = p_workspace_id and b.status = 'running') then
    raise exception 'import batch is not running' using errcode = 'check_violation';
  end if;
  perform set_config('app.suppress_audit', 'on', true);

  if p_kind = 'source_rows' then
    for it in select * from jsonb_array_elements(p_items) loop
      insert into public.source_files (workspace_id, provider, external_file_id, title)
      values (p_workspace_id, 'xlsx_export', it ->> 'file', it ->> 'file')
      on conflict (workspace_id, provider, external_file_id) do update set updated_at = now()
      returning id into v_file;
      -- Unchanged rows are already archived: keep one copy; changed rows get a new version.
      if exists (select 1 from public.source_rows x where x.workspace_id = p_workspace_id and x.source_file_id = v_file
                 and x.tab_name = it ->> 'tab' and x.row_number = (it ->> 'row')::integer and x.checksum = it ->> 'checksum') then
        v_existing := v_existing + 1; continue;
      end if;
      insert into public.source_rows (workspace_id, import_batch_id, source_file_id, tab_name, row_number, header, raw_values, formulas, cell_notes, checksum)
      values (p_workspace_id, p_batch_id, v_file, it ->> 'tab', (it ->> 'row')::integer, it -> 'header', coalesce(it -> 'values', '{}'::jsonb),
              nullif(it -> 'formulas', '{}'::jsonb), nullif(it -> 'notes', '{}'::jsonb), it ->> 'checksum')
      on conflict (import_batch_id, source_file_id, tab_name, row_number) do nothing
      returning id into v_id;
      if v_id is null then v_existing := v_existing + 1; continue; end if;
      v_created := v_created + 1;
      for l in select * from jsonb_array_elements(coalesce(it -> 'links', '[]'::jsonb)) loop
        insert into public.source_links (workspace_id, source_row_id, column_key, link_text, url)
        values (p_workspace_id, v_id, l ->> 'column', l ->> 'text', l ->> 'url');
      end loop;
    end loop;

  elsif p_kind = 'orgs' then
    for it in select * from jsonb_array_elements(p_items) loop
      v_id := private.import_key(p_workspace_id, it ->> 'key');
      if v_id is null and nullif(it ->> 'domain', '') is not null then
        -- An organization that already exists (e.g. added by a bot) with the same company domain.
        select id into v_id from public.organizations where workspace_id = p_workspace_id and lower(primary_domain) = lower(it ->> 'domain') limit 1;
      end if;
      v_id2 := case when it ->> 'parentKey' is not null then private.import_key(p_workspace_id, it ->> 'parentKey') end;
      if v_id is null then
        insert into public.organizations (workspace_id, name, website, primary_domain, parent_organization_id, location_label, country, notes)
        values (p_workspace_id, it ->> 'name', it ->> 'website', it ->> 'domain', v_id2, it ->> 'location', it ->> 'country', it ->> 'notes')
        returning id into v_id;
        v_created := v_created + 1;
      else
        update public.organizations set website = coalesce(website, it ->> 'website'), primary_domain = coalesce(primary_domain, it ->> 'domain'),
               parent_organization_id = coalesce(parent_organization_id, v_id2), location_label = coalesce(location_label, it ->> 'location'),
               country = coalesce(country, it ->> 'country'), notes = coalesce(notes, it ->> 'notes')
         where id = v_id;
        v_existing := v_existing + 1;
      end if;
      perform private.import_remember(p_workspace_id, it ->> 'key', 'organizations', v_id, p_batch_id);
      for a in select * from jsonb_array_elements(coalesce(it -> 'aliases', '[]'::jsonb)) loop
        insert into public.organization_aliases (workspace_id, organization_id, alias, justification)
        values (p_workspace_id, v_id, a ->> 'alias', a ->> 'justification') on conflict do nothing;
      end loop;
      perform private.import_link_sources(p_workspace_id, p_batch_id, it -> 'sources', 'organizations', v_id);
    end loop;

  elsif p_kind = 'contacts' then
    for it in select * from jsonb_array_elements(p_items) loop
      v_id := private.import_key(p_workspace_id, it ->> 'key');
      if v_id is null then
        -- Same verified email already known → same person.
        select ci.contact_id into v_id from jsonb_array_elements(coalesce(it -> 'identities', '[]'::jsonb)) x
          join public.contact_identities ci on ci.workspace_id = p_workspace_id and ci.kind::text = x ->> 'kind'
           and ci.normalized_value = x ->> 'normalized' and ci.is_verified
         where (x ->> 'verified')::boolean limit 1;
      end if;
      if v_id is null then
        insert into public.contacts (workspace_id, organization_id, full_name, job_title)
        values (p_workspace_id, private.import_key(p_workspace_id, it ->> 'orgKey'), it ->> 'name', it ->> 'title')
        returning id into v_id;
        v_created := v_created + 1;
      else
        update public.contacts set full_name = coalesce(full_name, it ->> 'name'), job_title = coalesce(job_title, it ->> 'title') where id = v_id;
        v_existing := v_existing + 1;
      end if;
      perform private.import_remember(p_workspace_id, it ->> 'key', 'contacts', v_id, p_batch_id);
      for i in select * from jsonb_array_elements(coalesce(it -> 'identities', '[]'::jsonb)) loop
        if exists (select 1 from public.contact_identities ci where ci.contact_id = v_id and ci.kind::text = i ->> 'kind' and ci.normalized_value = i ->> 'normalized') then
          if (i ->> 'verified')::boolean then
            update public.contact_identities set is_verified = true, verified_at = coalesce(verified_at, now()),
                   verification_source = coalesce(verification_source, i ->> 'verificationSource')
             where contact_id = v_id and kind::text = i ->> 'kind' and normalized_value = i ->> 'normalized' and not is_verified
               and not exists (select 1 from public.contact_identities o where o.workspace_id = p_workspace_id and o.kind::text = i ->> 'kind'
                               and o.normalized_value = i ->> 'normalized' and o.is_verified);
          end if;
          continue;
        end if;
        -- A verified address owned by someone else stays with them; this one is stored unverified (shows up for review).
        insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value, is_verified, verified_at, verification_source)
        select p_workspace_id, v_id, (i ->> 'kind')::public.identity_kind, i ->> 'value', i ->> 'normalized', ok, case when ok then now() end,
               case when ok then i ->> 'verificationSource' end
        from (select (i ->> 'verified')::boolean and not exists (select 1 from public.contact_identities o where o.workspace_id = p_workspace_id
                and o.kind::text = i ->> 'kind' and o.normalized_value = i ->> 'normalized' and o.is_verified) as ok) z;
      end loop;
      perform private.import_link_sources(p_workspace_id, p_batch_id, it -> 'sources', 'contacts', v_id);
    end loop;

  elsif p_kind = 'opps' then
    for it in select * from jsonb_array_elements(p_items) loop
      select id into v_channel from public.channels where workspace_id = p_workspace_id and kind::text = it ->> 'channel';
      v_id2 := private.import_key(p_workspace_id, it ->> 'orgKey');
      if v_id2 is null then v_skipped := v_skipped + 1; continue; end if;
      v_id := private.import_key(p_workspace_id, it ->> 'key');
      if v_id is null then
        select id into v_id from public.opportunities where workspace_id = p_workspace_id and channel_id = v_channel and organization_id = v_id2 limit 1;
      end if;
      if v_id is null then
        insert into public.opportunities (workspace_id, channel_id, organization_id, primary_contact_id, details)
        values (p_workspace_id, v_channel, v_id2, private.import_key(p_workspace_id, it ->> 'primaryContactKey'), coalesce(it -> 'details', '{}'::jsonb))
        returning id into v_id;
        v_created := v_created + 1;
      else
        update public.opportunities set primary_contact_id = coalesce(primary_contact_id, private.import_key(p_workspace_id, it ->> 'primaryContactKey')),
               details = coalesce(it -> 'details', '{}'::jsonb) || details
         where id = v_id;
        v_existing := v_existing + 1;
      end if;
      perform private.import_remember(p_workspace_id, it ->> 'key', 'opportunities', v_id, p_batch_id);
      for i in select * from jsonb_array_elements(coalesce(it -> 'contactKeys', '[]'::jsonb)) loop
        v_id2 := private.import_key(p_workspace_id, i #>> '{}');
        if v_id2 is not null then
          insert into public.opportunity_contacts (workspace_id, opportunity_id, contact_id) values (p_workspace_id, v_id, v_id2) on conflict do nothing;
        end if;
      end loop;
      perform private.import_link_sources(p_workspace_id, p_batch_id, it -> 'sources', 'opportunities', v_id);
    end loop;

  elsif p_kind = 'events' then
    for it in select * from jsonb_array_elements(p_items) loop
      v_id := private.import_key(p_workspace_id, it ->> 'oppKey');
      if v_id is null then v_skipped := v_skipped + 1; continue; end if;
      if exists (select 1 from public.activity_events where workspace_id = p_workspace_id and source = 'import:migration' and external_event_id = it ->> 'key') then
        v_existing := v_existing + 1; continue;
      end if;
      select * into v_cur from public.opportunities where id = v_id;
      v_msg := null;
      if it -> 'message' is not null and jsonb_typeof(it -> 'message') = 'object' then
        if nullif(it #>> '{message,providerMessageId}', '') is not null then
          select id into v_msg from public.messages where workspace_id = p_workspace_id and provider = it #>> '{message,provider}'
            and provider_message_id = it #>> '{message,providerMessageId}';
        end if;
        if v_msg is null then
          insert into public.messages (workspace_id, opportunity_id, contact_id, provider, provider_message_id, provider_thread_id, direction, status,
                                       is_automatic, from_address, to_addresses, subject, body_text, occurred_at, occurred_at_precision, source_timezone, source_row_id)
          values (p_workspace_id, v_id, v_cur.primary_contact_id, it #>> '{message,provider}', nullif(it #>> '{message,providerMessageId}', ''),
                  nullif(it #>> '{message,threadId}', ''), (it #>> '{message,direction}')::public.message_direction,
                  (it #>> '{message,status}')::public.message_status, (it #>> '{message,isAutomatic}')::boolean, it #>> '{message,from}',
                  coalesce(array(select jsonb_array_elements_text(it #> '{message,to}')), '{}'), it #>> '{message,subject}', it #>> '{message,body}',
                  (it ->> 'at')::timestamptz, coalesce(it ->> 'precision', 'unknown')::public.timestamp_precision, it ->> 'timezone',
                  private.import_source_row(p_workspace_id, p_batch_id, it -> 'source'))
          returning id into v_msg;
        end if;
      end if;
      insert into public.activity_events (workspace_id, opportunity_id, organization_id, contact_id, message_id, event_type, source, external_event_id,
                                          occurred_at, occurred_at_precision, source_timezone, actor_kind, summary, source_row_id, evidence)
      values (p_workspace_id, v_id, v_cur.organization_id, v_cur.primary_contact_id, v_msg, it ->> 'eventType', 'import:migration', it ->> 'key',
              (it ->> 'at')::timestamptz, coalesce(it ->> 'precision', 'unknown')::public.timestamp_precision, it ->> 'timezone', 'import',
              left(it ->> 'summary', 2000), private.import_source_row(p_workspace_id, p_batch_id, it -> 'source'),
              jsonb_build_object('raw_time', it ->> 'rawTime', 'batch', p_batch_id))
      returning id into v_event;
      v_created := v_created + 1;
      for a in select * from jsonb_array_elements(coalesce(it -> 'assessments', '[]'::jsonb)) loop
        if v_msg is not null then
          insert into public.reply_assessments (workspace_id, message_id, source, classification, is_human_reply, platform_label, conditions, rationale)
          values (p_workspace_id, v_msg, (a ->> 'source')::public.assessment_source, a ->> 'classification', (a ->> 'isHumanReply')::boolean,
                  a ->> 'platformLabel', a ->> 'conditions', 'imported from spreadsheets');
        end if;
      end loop;
    end loop;

  elsif p_kind = 'finalize' then
    for it in select * from jsonb_array_elements(p_items) loop
      v_id := private.import_key(p_workspace_id, it ->> 'oppKey');
      if v_id is null then v_skipped := v_skipped + 1; continue; end if;
      select * into v_cur from public.opportunities where id = v_id for update;
      v_event := case when it ->> 'stageEvidenceKey' is not null then
        (select e.id from public.activity_events e where e.workspace_id = p_workspace_id and e.source = 'import:migration'
           and e.external_event_id = it ->> 'stageEvidenceKey' and e.opportunity_id = v_id) end;
      v_id2 := case when it ->> 'lastVerifiedKey' is not null then
        (select e.id from public.activity_events e where e.workspace_id = p_workspace_id and e.source = 'import:migration'
           and e.external_event_id = it ->> 'lastVerifiedKey' and e.opportunity_id = v_id) end;
      update public.opportunities set
        stage = case when it ->> 'stage' is not null and v_event is not null
                      and (stage is null or array_position(v_order, it ->> 'stage') > array_position(v_order, stage::text))
                     then (it ->> 'stage')::public.opportunity_stage else stage end,
        stage_evidence_event_id = case when it ->> 'stage' is not null and v_event is not null
                      and (stage is null or array_position(v_order, it ->> 'stage') > array_position(v_order, stage::text))
                     then v_event else stage_evidence_event_id end,
        disposition = coalesce(disposition, (it ->> 'disposition')::public.opportunity_disposition),
        milestone_key = coalesce(milestone_key, it ->> 'milestone'),
        next_action = coalesce(next_action, it ->> 'nextAction'),
        next_action_due_at = coalesce(next_action_due_at, (it ->> 'nextActionDue')::timestamptz),
        last_verified_at = case when v_id2 is not null and (last_verified_at is null or last_verified_at < (it ->> 'lastVerifiedAt')::timestamptz)
                                then (it ->> 'lastVerifiedAt')::timestamptz else last_verified_at end,
        last_verified_event_id = case when v_id2 is not null and (last_verified_at is null or last_verified_at < (it ->> 'lastVerifiedAt')::timestamptz)
                                then v_id2 else last_verified_event_id end
      where id = v_id;
      v_created := v_created + 1;
    end loop;

  elsif p_kind = 'offers' then
    for it in select * from jsonb_array_elements(p_items) loop
      if private.import_key(p_workspace_id, it ->> 'key') is not null then v_existing := v_existing + 1; continue; end if;
      v_id := private.import_key(p_workspace_id, it ->> 'oppKey');
      if v_id is null then v_skipped := v_skipped + 1; continue; end if;
      insert into public.offers (workspace_id, opportunity_id, kind, terms, amount, currency, is_paid, status, source_row_id)
      values (p_workspace_id, v_id, it ->> 'kind', it ->> 'terms', (it ->> 'amount')::numeric, it ->> 'currency', coalesce((it ->> 'isPaid')::boolean, false),
              (it ->> 'status')::public.offer_status, private.import_source_row(p_workspace_id, p_batch_id, it -> 'source'))
      returning id into v_id2;
      perform private.import_remember(p_workspace_id, it ->> 'key', 'offers', v_id2, p_batch_id);
      v_created := v_created + 1;
    end loop;

  elsif p_kind = 'tasks' then
    for it in select * from jsonb_array_elements(p_items) loop
      select id into v_channel from public.channels where workspace_id = p_workspace_id and kind::text = it ->> 'channel';
      insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, details, idempotency_key, priority)
      values (p_workspace_id, v_channel, private.import_key(p_workspace_id, it ->> 'oppKey'), it ->> 'kind', it ->> 'title',
              coalesce(it -> 'details', '{}'::jsonb), it ->> 'key', 50)
      on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing;
      if found then v_created := v_created + 1; else v_existing := v_existing + 1; end if;
    end loop;

  else
    raise exception 'unknown import kind %', p_kind using errcode = 'invalid_parameter_value';
  end if;

  return jsonb_build_object('kind', p_kind, 'created', v_created, 'existing', v_existing, 'skipped', v_skipped);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.import_begin(uuid, uuid, jsonb)',
    'public.import_finish(uuid, public.import_batch_status, jsonb)',
    'public.import_apply(uuid, uuid, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
grant execute on function private.import_key(uuid, text) to service_role;
grant execute on function private.import_remember(uuid, text, text, uuid, uuid) to service_role;
grant execute on function private.import_source_row(uuid, uuid, jsonb) to service_role;
grant execute on function private.import_link_sources(uuid, uuid, jsonb, text, uuid) to service_role;

-- Today's "What changed" leaves out bulk-imported history.
create or replace function public.ui_daily(p_workspace_id uuid, p_since timestamptz default null)
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
                and event_type <> 'note.added' and actor_kind <> 'import'
              order by recorded_at desc limit 50) e
        left join public.opportunities o on o.id = e.opportunity_id
        left join public.organizations org on org.id = o.organization_id
        left join public.channels c on c.id = o.channel_id
        left join public.worker_identities w on w.id = e.actor_worker_id), '[]'::jsonb)
  );
$$;


create or replace function private.log_opportunity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_worker uuid := nullif(current_setting('app.actor_worker_id', true), '')::uuid;
  v_kind public.actor_kind := case when v_worker is null then 'system' else 'worker' end;
begin
  -- Bulk imports record their own evidence; don't add an audit entry per imported stage.
  if current_setting('app.suppress_audit', true) = 'on' then
    return null;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind, actor_worker_id,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.stage_changed', 'app', v_kind, v_worker, now(), 'exact',
            'Stage: ' || coalesce(private.label(old.stage::text), 'not contacted') || ' → ' || coalesce(private.label(new.stage::text), 'not contacted'),
            jsonb_build_object('from', old.stage, 'to', new.stage, 'evidence_event_id', new.stage_evidence_event_id));
  end if;
  if new.disposition is distinct from old.disposition then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind, actor_worker_id,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.disposition_changed', 'app', v_kind, v_worker, now(), 'exact',
            'Disposition: ' || coalesce(private.label(old.disposition::text), 'none') || ' → ' || coalesce(private.label(new.disposition::text), 'none'),
            jsonb_build_object('from', old.disposition, 'to', new.disposition));
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind, actor_worker_id,
                                        occurred_at, occurred_at_precision, summary, evidence)
    values (new.workspace_id, new.id, new.organization_id, 'opportunity.milestone_changed', 'app', v_kind, v_worker, now(), 'exact',
            'Milestone: ' || coalesce(private.label(old.milestone_key), 'none') || ' → ' || coalesce(private.label(new.milestone_key), 'none'),
            jsonb_build_object('from', old.milestone_key, 'to', new.milestone_key));
  end if;
  return null;
end;
$$;
