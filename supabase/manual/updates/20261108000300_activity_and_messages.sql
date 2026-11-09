-- Gleeday update: 20261108000300_activity_and_messages.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261108000300') then
    raise exception 'Update 20261108000300 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200')) < 2 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Append-only facts: activity events, messages, reply assessments.

create type public.message_direction as enum ('outbound', 'inbound');
-- Attempts, delivery, bounces and uncertain failures are kept distinct.
create type public.message_status as enum
  ('draft', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'uncertain', 'received');
create type public.actor_kind as enum ('user', 'worker', 'system', 'import', 'provider');

-- ---------------------------------------------------------------------------
-- Messages: real correspondence records. Gmail/Instantly own the originals; we store
-- provider IDs + bodies as evidence. Drafts never establish contact.
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid,
  contact_id uuid,
  provider text not null,                      -- 'gmail','instantly','linkedin','facebook','manual','import'
  provider_message_id text,
  provider_thread_id text,
  direction public.message_direction not null,
  status public.message_status not null,
  is_automatic boolean,                        -- auto-reply / OOO; NULL = not yet assessed
  from_address text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text,
  body_text text,
  body_html text,
  occurred_at timestamptz,                     -- NULL when the source has no date (never invented)
  occurred_at_precision public.timestamp_precision not null default 'unknown',
  source_timezone text,
  source_row_id uuid,                          -- provenance for imported history (FK added later)
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id),
  check (occurred_at is not null or occurred_at_precision = 'unknown')
);
create unique index messages_provider_unique
  on public.messages (workspace_id, provider, provider_message_id) where provider_message_id is not null;
create index messages_ws_opp_idx on public.messages (workspace_id, opportunity_id, occurred_at);
create index messages_thread_idx on public.messages (workspace_id, provider, provider_thread_id);

-- ---------------------------------------------------------------------------
-- Activity events: the evidence timeline. Idempotent on (workspace, source, external_event_id).
-- ---------------------------------------------------------------------------
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid,
  organization_id uuid,
  contact_id uuid,
  message_id uuid,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  source text not null,                        -- e.g. 'gmail','instantly','manual','import:<file>','worker:<id>'
  external_event_id text,
  occurred_at timestamptz,
  occurred_at_precision public.timestamp_precision not null default 'unknown',
  source_timezone text,
  recorded_at timestamptz not null default now(),
  actor_kind public.actor_kind not null,
  actor_user_id uuid references auth.users(id),
  actor_worker_id uuid,
  source_row_id uuid,
  summary text,
  evidence jsonb not null default '{}'::jsonb,  -- raw provider/source evidence (untrusted data)
  unique (workspace_id, id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, organization_id) references public.organizations (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id),
  foreign key (workspace_id, message_id) references public.messages (workspace_id, id),
  foreign key (workspace_id, actor_worker_id) references public.worker_identities (workspace_id, id),
  check (occurred_at is not null or occurred_at_precision = 'unknown'),
  check (actor_kind <> 'user' or actor_user_id is not null),
  check (actor_kind <> 'worker' or actor_worker_id is not null)
);
create unique index activity_events_idempotency
  on public.activity_events (workspace_id, source, external_event_id) where external_event_id is not null;
create index activity_events_ws_opp_idx on public.activity_events (workspace_id, opportunity_id, occurred_at);

-- Users may only record events as themselves.
create function private.stamp_activity_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.role()) = 'authenticated' then
    new.actor_kind := 'user';
    new.actor_user_id := (select auth.uid());
    new.actor_worker_id := null;
  end if;
  return new;
end;
$$;
create trigger activity_events_stamp_actor before insert on public.activity_events
  for each row execute function private.stamp_activity_actor();

-- Now that events exist, wire opportunity evidence pointers.
alter table public.opportunities
  add constraint opportunities_stage_evidence_fk
    foreign key (workspace_id, stage_evidence_event_id) references public.activity_events (workspace_id, id),
  add constraint opportunities_last_verified_fk
    foreign key (workspace_id, last_verified_event_id) references public.activity_events (workspace_id, id);

-- ---------------------------------------------------------------------------
-- Reply assessments: human vs automatic classification, platform labels kept verbatim.
-- A new assessment supersedes older ones; nothing is overwritten.
-- ---------------------------------------------------------------------------
create type public.assessment_source as enum ('human', 'automatic', 'platform');

create table public.reply_assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  message_id uuid not null,
  source public.assessment_source not null,
  -- content assessment, e.g. 'positive','negative','question','paid_only','automatic','unclear'
  classification text,
  is_human_reply boolean,
  -- platform label exactly as the provider shows it, e.g. Instantly 'Interested'
  platform_label text,
  conditions text,                             -- e.g. "only interested in paid placement"
  rationale text,
  evidence jsonb not null default '{}'::jsonb,
  assessed_by_user_id uuid references auth.users(id),
  assessed_by_worker_id uuid,
  assessed_at timestamptz not null default now(),
  foreign key (workspace_id, message_id) references public.messages (workspace_id, id),
  foreign key (workspace_id, assessed_by_worker_id) references public.worker_identities (workspace_id, id),
  check (source <> 'platform' or platform_label is not null)
);
create index reply_assessments_msg_idx on public.reply_assessments (workspace_id, message_id, assessed_at desc);

create function private.stamp_assessment_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.role()) = 'authenticated' then
    new.source := 'human';
    new.assessed_by_user_id := (select auth.uid());
    new.assessed_by_worker_id := null;
  end if;
  return new;
end;
$$;
create trigger reply_assessments_stamp_actor before insert on public.reply_assessments
  for each row execute function private.stamp_assessment_actor();

-- Append-only enforcement
create trigger activity_events_append_only before update or delete on public.activity_events
  for each row execute function private.forbid_mutation();
create trigger reply_assessments_append_only before update or delete on public.reply_assessments
  for each row execute function private.forbid_mutation();
-- Messages: identity/body columns are immutable; only status/is_automatic may progress.
create function private.guard_message_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.workspace_id, new.provider, new.provider_message_id, new.direction, new.from_address,
      new.to_addresses, new.subject, new.body_text, new.body_html, new.occurred_at)
     is distinct from
     (old.workspace_id, old.provider, old.provider_message_id, old.direction, old.from_address,
      old.to_addresses, old.subject, old.body_text, old.body_html, old.occurred_at) then
    raise exception 'message content is immutable' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger messages_guard_update before update on public.messages
  for each row execute function private.guard_message_update();
create trigger messages_no_delete before delete on public.messages
  for each row execute function private.forbid_mutation();

select private.apply_workspace_rls('public.messages', 'read');
select private.apply_workspace_rls('public.activity_events', 'append');
select private.apply_workspace_rls('public.reply_assessments', 'append');

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000300', 'activity_and_messages') on conflict do nothing;
commit;
select 'Update 20261108000300 applied' as result;
