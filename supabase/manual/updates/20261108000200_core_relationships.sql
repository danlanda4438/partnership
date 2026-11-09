-- Gleeday update: 20261108000200_core_relationships.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261108000200') then
    raise exception 'Update 20261108000200 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100')) < 1 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Core relationship model: channels, organizations, contacts, identities,
-- opportunities, campaigns, stage/disposition/milestone vocabulary.

-- ---------------------------------------------------------------------------
-- Standard RLS helper. Applied by migrations only (not callable by API roles).
--   'read'   : members SELECT; no direct writes (writes via backend/functions)
--   'write'  : members SELECT; owner/admin/member INSERT + UPDATE (no DELETE)
--   'append' : members SELECT; owner/admin/member INSERT only (facts are immutable)
-- ---------------------------------------------------------------------------
create function private.apply_workspace_rls(p_table regclass, p_mode text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
begin
  if p_mode not in ('read', 'write', 'append') then
    raise exception 'unknown rls mode %', p_mode;
  end if;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from anon, authenticated', p_table);
  execute format('grant select on %s to authenticated', p_table);
  execute format(
    'create policy %I on %s for select to authenticated using (workspace_id in (select private.member_workspace_ids()))',
    v_name || '_select', p_table);

  if p_mode in ('write', 'append') then
    execute format('grant insert on %s to authenticated', p_table);
    execute format(
      'create policy %I on %s for insert to authenticated with check (workspace_id in (select private.writer_workspace_ids()))',
      v_name || '_insert', p_table);
  end if;

  if p_mode = 'write' then
    execute format('grant update on %s to authenticated', p_table);
    execute format(
      'create policy %I on %s for update to authenticated using (workspace_id in (select private.writer_workspace_ids())) with check (workspace_id in (select private.writer_workspace_ids()))',
      v_name || '_update', p_table);
  end if;
end;
$$;
revoke all on function private.apply_workspace_rls(regclass, text) from public, authenticated;

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------
-- Funnel stages. There is deliberately NO "research" stage: uncontacted inventory has stage NULL.
create type public.opportunity_stage as enum
  ('contacted', 'replied', 'interested', 'discussion_proposal', 'agreed', 'live');

-- Dispositions are kept separate from stage (an opportunity can be "replied" + "declined").
create type public.opportunity_disposition as enum
  ('declined', 'on_hold', 'bounced', 'automatic_only', 'blocked', 'needs_verification');

create type public.identity_kind as enum ('email', 'linkedin', 'facebook', 'instagram', 'website', 'phone', 'other');
create type public.timestamp_precision as enum ('exact', 'minute', 'day', 'month', 'year', 'unknown');

-- Channel-specific milestones (reference data, same for every workspace).
create table public.channel_milestones (
  channel_kind public.channel_kind not null,
  key text not null,
  label text not null,
  ordinal smallint not null,
  primary key (channel_kind, key),
  unique (channel_kind, ordinal)
);
insert into public.channel_milestones (channel_kind, key, label, ordinal) values
  ('affiliates',   'agreed',             'Agreed',                    1),
  ('affiliates',   'manually_onboarded', 'Manually onboarded',        2),
  ('affiliates',   'promoting',          'Promoting',                 3),
  ('co_marketing', 'agreed',             'Agreed',                    1),
  ('co_marketing', 'implementation',     'Implementation',            2),
  ('co_marketing', 'pilot',              'Pilot',                     3),
  ('co_marketing', 'launched',           'Launched',                  4),
  ('media_pr',     'proposal',           'Proposal',                  1),
  ('media_pr',     'approved_buy',       'Approved buy',              2),
  ('media_pr',     'signed_io',          'Signed IO',                 3),
  ('media_pr',     'placement_live',     'Placement live',            4),
  ('listings',     'submitted',          'Submitted',                 1),
  ('listings',     'pending_review',     'Pending review',            2),
  ('listings',     'approved_scheduled', 'Approved or scheduled',     3),
  ('listings',     'publicly_live',      'Publicly live',             4);
alter table public.channel_milestones enable row level security;
revoke all on public.channel_milestones from anon, authenticated;
grant select on public.channel_milestones to authenticated;
create policy channel_milestones_select on public.channel_milestones for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Channels (the four workstreams, per workspace)
-- ---------------------------------------------------------------------------
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind public.channel_kind not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, kind),
  unique (workspace_id, id)
);

-- Every new workspace automatically gets its four channels.
create function private.create_default_channels()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.channels (workspace_id, kind, name) values
    (new.id, 'affiliates', 'Affiliates'),
    (new.id, 'co_marketing', 'Co-Marketing'),
    (new.id, 'media_pr', 'Media & PR'),
    (new.id, 'listings', 'Listings');
  return new;
end;
$$;
create trigger workspaces_default_channels after insert on public.workspaces
  for each row execute function private.create_default_channels();

-- Which channels a worker may operate in (worker scope).
create table public.worker_channel_scopes (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  worker_id uuid not null,
  channel_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (worker_id, channel_id),
  foreign key (workspace_id, worker_id) references public.worker_identities (workspace_id, id) on delete cascade,
  foreign key (workspace_id, channel_id) references public.channels (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Organizations & contacts
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  website text,
  primary_domain text,
  -- Venue chains: each location is its own organization row linked to its parent.
  parent_organization_id uuid,
  location_label text,
  country text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, parent_organization_id) references public.organizations (workspace_id, id),
  check (parent_organization_id is distinct from id)
);
create index organizations_ws_name_idx on public.organizations (workspace_id, lower(name));
create index organizations_ws_domain_idx on public.organizations (workspace_id, lower(primary_domain));

-- Organization aliases need a justification; names alone never merge records.
create table public.organization_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid not null,
  alias text not null,
  justification text not null check (length(trim(justification)) > 0),
  created_at timestamptz not null default now(),
  unique (workspace_id, organization_id, alias),
  foreign key (workspace_id, organization_id) references public.organizations (workspace_id, id) on delete cascade
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid,
  full_name text,
  job_title text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, organization_id) references public.organizations (workspace_id, id)
);
create index contacts_ws_org_idx on public.contacts (workspace_id, organization_id);

-- Verified email/profile identities. A verified identity value maps to exactly one contact
-- in a workspace; that is the only automatic dedupe key for people.
create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  kind public.identity_kind not null,
  value text not null,
  normalized_value text not null,
  is_verified boolean not null default false,
  verified_at timestamptz,
  verification_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  check (is_verified = (verified_at is not null)),
  check (kind <> 'email' or normalized_value = lower(trim(normalized_value)))
);
create unique index contact_identities_verified_unique
  on public.contact_identities (workspace_id, kind, normalized_value) where is_verified;
create index contact_identities_lookup_idx on public.contact_identities (workspace_id, kind, normalized_value);

-- ---------------------------------------------------------------------------
-- Opportunities: one relationship per organization per channel engagement.
-- ---------------------------------------------------------------------------
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id uuid not null,
  organization_id uuid not null,
  primary_contact_id uuid,
  title text,
  stage public.opportunity_stage,                 -- NULL = uncontacted inventory
  stage_changed_at timestamptz,
  stage_evidence_event_id uuid,                   -- FK added after activity_events exists
  disposition public.opportunity_disposition,
  milestone_key text,
  milestone_changed_at timestamptz,
  -- Ownership & next action (visible on every record)
  owner_user_id uuid references auth.users(id),
  owner_worker_id uuid,
  next_action text,
  next_action_due_at timestamptz,
  last_verified_at timestamptz,
  last_verified_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, channel_id) references public.channels (workspace_id, id),
  foreign key (workspace_id, organization_id) references public.organizations (workspace_id, id),
  foreign key (workspace_id, primary_contact_id) references public.contacts (workspace_id, id),
  foreign key (workspace_id, owner_worker_id) references public.worker_identities (workspace_id, id),
  -- A funnel stage must be backed by evidence.
  check (stage is null or stage_evidence_event_id is not null),
  check (not (owner_user_id is not null and owner_worker_id is not null))
);
create index opportunities_ws_channel_stage_idx on public.opportunities (workspace_id, channel_id, stage);
create index opportunities_ws_org_idx on public.opportunities (workspace_id, organization_id);
create index opportunities_due_idx on public.opportunities (workspace_id, next_action_due_at) where next_action_due_at is not null;

-- Milestone must belong to the opportunity's channel.
create function private.check_opportunity_milestone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.channel_kind;
begin
  if new.milestone_key is null then
    return new;
  end if;
  select c.kind into v_kind from public.channels c where c.id = new.channel_id;
  if not exists (
    select 1 from public.channel_milestones m where m.channel_kind = v_kind and m.key = new.milestone_key
  ) then
    raise exception 'milestone % is not valid for channel %', new.milestone_key, v_kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger opportunities_milestone_check before insert or update of milestone_key, channel_id
  on public.opportunities for each row execute function private.check_opportunity_milestone();

-- Additional people involved in an opportunity (distinct people are never merged).
create table public.opportunity_contacts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null,
  contact_id uuid not null,
  role text,
  created_at timestamptz not null default now(),
  primary key (opportunity_id, contact_id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Campaigns (external campaign mappings; health is separate from partner progress)
-- ---------------------------------------------------------------------------
create type public.campaign_status as enum ('draft', 'active', 'paused', 'error', 'completed', 'unknown');

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id uuid,
  provider text not null,                 -- 'instantly', 'manual', ...
  external_campaign_id text,
  name text not null,
  status public.campaign_status not null default 'unknown',
  status_checked_at timestamptz,
  health_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, channel_id) references public.channels (workspace_id, id),
  unique (workspace_id, provider, external_campaign_id)
);

-- ---------------------------------------------------------------------------
-- Triggers + RLS
-- ---------------------------------------------------------------------------
create trigger channels_updated_at before update on public.channels for each row execute function private.set_updated_at();
create trigger organizations_updated_at before update on public.organizations for each row execute function private.set_updated_at();
create trigger contacts_updated_at before update on public.contacts for each row execute function private.set_updated_at();
create trigger contact_identities_updated_at before update on public.contact_identities for each row execute function private.set_updated_at();
create trigger opportunities_updated_at before update on public.opportunities for each row execute function private.set_updated_at();
create trigger campaigns_updated_at before update on public.campaigns for each row execute function private.set_updated_at();

select private.apply_workspace_rls('public.channels', 'read');
select private.apply_workspace_rls('public.worker_channel_scopes', 'read');
select private.apply_workspace_rls('public.organizations', 'write');
select private.apply_workspace_rls('public.organization_aliases', 'write');
select private.apply_workspace_rls('public.contacts', 'write');
select private.apply_workspace_rls('public.contact_identities', 'write');
select private.apply_workspace_rls('public.opportunities', 'write');
select private.apply_workspace_rls('public.opportunity_contacts', 'write');
select private.apply_workspace_rls('public.campaigns', 'read');

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000200', 'core_relationships') on conflict do nothing;
commit;
select 'Update 20261108000200 applied' as result;
