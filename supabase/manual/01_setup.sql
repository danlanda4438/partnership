-- Gleeday Operations Center: one-shot setup for the Supabase SQL Editor.
-- Generated from supabase/migrations by tools/build-manual-setup.sh. Do not edit by hand.
-- Paste the whole file into Dashboard -> SQL Editor -> New query, then click Run.
begin;

-- ===== 20261108000100_foundation.sql =====
-- Gleeday Operations Center — foundation
-- Private helper schema, shared enums, utility triggers, tenancy tables.
--
-- Conventions used in every migration:
--   * Every table carries workspace_id (except workspaces itself) and has RLS enabled.
--   * Default grants are revoked from anon/authenticated; only explicit grants are added back.
--   * Authorization reads live membership rows (never JWT metadata), so revocation is immediate.
--   * Timestamps are timestamptz (stored UTC). Display timezone is Asia/Jerusalem (UI concern).

create schema if not exists private;
revoke all on schema private from public;
-- authenticated needs USAGE so RLS policies can call helper functions.
-- The private schema is NOT exposed through the Data API.
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.member_status as enum ('active', 'revoked');
create type public.worker_status as enum ('active', 'paused', 'revoked');
create type public.channel_kind as enum ('affiliates', 'co_marketing', 'media_pr', 'listings');

-- ---------------------------------------------------------------------------
-- Utility triggers
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Blocks UPDATE and DELETE on append-only fact tables, for every role.
create function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_timezone text not null default 'Asia/Jerusalem',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  status public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, user_id),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index workspace_members_user_idx on public.workspace_members (user_id, workspace_id) where status = 'active';

-- Bots are "workers". They never receive database credentials; they authenticate to the
-- application's MCP server with an app-issued token whose hash lives in private.worker_credentials.
create table public.worker_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- e.g. 'coordinator' for Soled, 'affiliates', 'media_pr' ... mapped manually during onboarding
  role text not null,
  description text,
  capabilities text[] not null default '{}',
  status public.worker_status not null default 'active',
  -- Administrative limits (enforced by the application backend, Phase 4)
  max_concurrent_tasks integer not null default 1 check (max_concurrent_tasks between 1 and 50),
  daily_action_budget integer check (daily_action_budget is null or daily_action_budget >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name),
  unique (workspace_id, id)
);

create table private.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.worker_identities(id) on delete cascade,
  token_hash text not null unique,      -- sha256 of the token; the token itself is never stored
  label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
revoke all on private.worker_credentials from public, authenticated;

create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();
create trigger workspace_members_updated_at before update on public.workspace_members
  for each row execute function private.set_updated_at();
create trigger worker_identities_updated_at before update on public.worker_identities
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER, private schema, empty search_path).
-- They read live membership rows, so a revoked or downgraded member loses access
-- on the very next query regardless of what their JWT still says.
-- Return sets so policies can use `workspace_id in (select ...)` (evaluated once per statement).
-- ---------------------------------------------------------------------------
create function private.member_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.status = 'active';
$$;

create function private.writer_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and m.role in ('owner', 'admin', 'member');
$$;

create function private.admin_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and m.role in ('owner', 'admin');
$$;

create function private.has_workspace_role(p_workspace_id uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (p_roles)
  );
$$;

revoke all on function private.member_workspace_ids() from public;
revoke all on function private.writer_workspace_ids() from public;
revoke all on function private.admin_workspace_ids() from public;
revoke all on function private.has_workspace_role(uuid, public.member_role[]) from public;
grant execute on function private.member_workspace_ids() to authenticated;
grant execute on function private.writer_workspace_ids() to authenticated;
grant execute on function private.admin_workspace_ids() to authenticated;
grant execute on function private.has_workspace_role(uuid, public.member_role[]) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS + grants: tenancy
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.worker_identities enable row level security;

revoke all on public.workspaces, public.workspace_members, public.worker_identities from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.worker_identities to authenticated;
grant update (name, display_timezone) on public.workspaces to authenticated;
grant update (status, max_concurrent_tasks, daily_action_budget, description) on public.worker_identities to authenticated;

create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select private.member_workspace_ids()));
create policy workspaces_update on public.workspaces for update to authenticated
  using (id in (select private.admin_workspace_ids()))
  with check (id in (select private.admin_workspace_ids()));

create policy workspace_members_select on public.workspace_members for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));

create policy worker_identities_select on public.worker_identities for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
-- Admins can pause/resume workers and change limits (administrative pause).
create policy worker_identities_update on public.worker_identities for update to authenticated
  using (workspace_id in (select private.admin_workspace_ids()))
  with check (workspace_id in (select private.admin_workspace_ids()));

-- Membership changes go through a privileged function so the rules
-- (last-owner protection, no self-escalation) are enforced in one place.
create function public.set_member_role(p_member_id uuid, p_role public.member_role, p_status public.member_status)
returns public.workspace_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.workspace_members;
  v_result public.workspace_members;
  v_remaining_owners integer;
begin
  select * into v_target from public.workspace_members where id = p_member_id for update;
  if not found then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;

  if not private.has_workspace_role(v_target.workspace_id, array['owner','admin']::public.member_role[]) then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;
  -- Only owners can grant or remove owner.
  if (p_role = 'owner' or v_target.role = 'owner')
     and not private.has_workspace_role(v_target.workspace_id, array['owner']::public.member_role[]) then
    raise exception 'only owners can change owner membership' using errcode = 'insufficient_privilege';
  end if;

  if v_target.role = 'owner' and (p_role <> 'owner' or p_status = 'revoked') then
    select count(*) into v_remaining_owners from public.workspace_members
      where workspace_id = v_target.workspace_id and role = 'owner' and status = 'active' and id <> v_target.id;
    if v_remaining_owners = 0 then
      raise exception 'cannot remove the last owner' using errcode = 'check_violation';
    end if;
  end if;

  update public.workspace_members
     set role = p_role,
         status = p_status,
         revoked_at = case when p_status = 'revoked' then coalesce(revoked_at, now()) else null end
   where id = p_member_id
  returning * into v_result;
  return v_result;
end;
$$;
revoke all on function public.set_member_role(uuid, public.member_role, public.member_status) from public, anon;
grant execute on function public.set_member_role(uuid, public.member_role, public.member_status) to authenticated;

-- ===== 20261108000200_core_relationships.sql =====
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

-- ===== 20261108000300_activity_and_messages.sql =====
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

-- ===== 20261108000400_offers_and_approvals.sql =====
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

-- ===== 20261108000500_tasks.sql =====
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

-- ===== 20261108000600_provenance_integrations_storage.sql =====
-- Source provenance (spreadsheet archive), integration connections, sync cursors,
-- private attachments, and security-invoker views.

-- ---------------------------------------------------------------------------
-- Source provenance
-- ---------------------------------------------------------------------------
create type public.import_batch_kind as enum ('snapshot', 'dry_run', 'upsert', 'replay');
create type public.import_batch_status as enum ('running', 'completed', 'failed', 'approved', 'rolled_back');

create table public.source_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'google_sheets',
  external_file_id text not null,
  title text not null,
  url text,
  owner_label text,
  channel_id uuid,
  registry_notes text,
  is_included boolean not null default true,
  exclusion_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, external_file_id),
  foreign key (workspace_id, channel_id) references public.channels (workspace_id, id),
  check (is_included or exclusion_reason is not null)
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind public.import_batch_kind not null,
  status public.import_batch_status not null default 'running',
  mapping_version text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  report jsonb,
  approved_by_user_id uuid references auth.users(id),
  approved_at timestamptz,
  unique (workspace_id, id)
);

-- One immutable raw row per snapshot: original values, formulas (archived, never executed),
-- notes, plus a checksum so later snapshots can be diffed.
create table public.source_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_batch_id uuid not null,
  source_file_id uuid not null,
  tab_name text not null,
  row_number integer not null check (row_number > 0),
  header jsonb,
  raw_values jsonb not null,                   -- column -> displayed value, verbatim
  formulas jsonb,                              -- column -> formula expression, archived as text
  cell_notes jsonb,
  checksum text not null,
  captured_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (import_batch_id, source_file_id, tab_name, row_number),
  foreign key (workspace_id, import_batch_id) references public.import_batches (workspace_id, id),
  foreign key (workspace_id, source_file_id) references public.source_files (workspace_id, id)
);
create index source_rows_lookup_idx on public.source_rows (workspace_id, source_file_id, tab_name, row_number);

-- Rich-text hyperlinks inside cells (destination preserved separately from display text).
create table public.source_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_row_id uuid not null,
  column_key text not null,
  link_text text,
  url text not null,
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id)
);

-- Which normalized records each source row produced (transformation mapping).
create table public.source_row_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_row_id uuid not null,
  target_table text not null,
  target_id uuid not null,
  mapping_version text not null,
  created_at timestamptz not null default now(),
  unique (source_row_id, target_table, target_id),
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id)
);

create trigger source_rows_append_only before update or delete on public.source_rows
  for each row execute function private.forbid_mutation();
create trigger source_links_append_only before update or delete on public.source_links
  for each row execute function private.forbid_mutation();
create trigger source_files_updated_at before update on public.source_files for each row execute function private.set_updated_at();

alter table public.messages add constraint messages_source_row_fk
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id);
alter table public.activity_events add constraint activity_events_source_row_fk
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id);
alter table public.offers add constraint offers_source_row_fk
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id);

-- ---------------------------------------------------------------------------
-- Integrations: references + health only. Secrets live in server-side secret storage;
-- secret_ref names the secret, it never contains it.
-- ---------------------------------------------------------------------------
create type public.connection_status as enum ('not_configured', 'configured', 'healthy', 'degraded', 'blocked', 'revoked');

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,                      -- 'google_sheets','gmail','instantly','command_center','routine_webhook'
  display_name text not null,
  status public.connection_status not null default 'not_configured',
  account_identity text,                       -- verified account, e.g. the Gmail address actually connected
  scopes text[] not null default '{}',
  secret_ref text check (secret_ref is null or secret_ref ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  blocked_reason text,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, display_name)
);
create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function private.set_updated_at();

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  stream text not null,
  cursor_value text,
  last_synced_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (connection_id, stream),
  foreign key (workspace_id, connection_id) references public.integration_connections (workspace_id, id) on delete cascade
);
create trigger sync_cursors_updated_at before update on public.sync_cursors for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Attachments: metadata row + object in the private 'attachments' bucket.
-- Object path convention: <workspace_id>/<attachment_id>/<file name>
-- ---------------------------------------------------------------------------
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid,
  message_id uuid,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text,
  source_row_id uuid,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  foreign key (workspace_id, message_id) references public.messages (workspace_id, id),
  foreign key (workspace_id, source_row_id) references public.source_rows (workspace_id, id),
  check (split_part(storage_path, '/', 1) = workspace_id::text)
);

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set public = false;

create policy attachments_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments'
         and (storage.foldername(name))[1] in (select w::text from private.member_workspace_ids() w));
create policy attachments_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments'
              and (storage.foldername(name))[1] in (select w::text from private.writer_workspace_ids() w));

select private.apply_workspace_rls('public.source_files', 'read');
select private.apply_workspace_rls('public.import_batches', 'read');
select private.apply_workspace_rls('public.source_rows', 'read');
select private.apply_workspace_rls('public.source_links', 'read');
select private.apply_workspace_rls('public.source_row_targets', 'read');
select private.apply_workspace_rls('public.integration_connections', 'read');
select private.apply_workspace_rls('public.sync_cursors', 'read');
select private.apply_workspace_rls('public.attachments', 'append');

-- ---------------------------------------------------------------------------
-- Views (security_invoker: they obey the caller's RLS)
-- ---------------------------------------------------------------------------
create view public.opportunity_pipeline
with (security_invoker = true)
as
select
  o.id,
  o.workspace_id,
  c.kind as channel_kind,
  c.name as channel_name,
  o.organization_id,
  org.name as organization_name,
  o.primary_contact_id,
  pc.full_name as primary_contact_name,
  o.stage,
  o.disposition,
  o.milestone_key,
  o.owner_user_id,
  o.owner_worker_id,
  w.name as owner_worker_name,
  o.next_action,
  o.next_action_due_at,
  o.last_verified_at,
  o.updated_at
from public.opportunities o
join public.channels c on c.id = o.channel_id
join public.organizations org on org.id = o.organization_id
left join public.contacts pc on pc.id = o.primary_contact_id
left join public.worker_identities w on w.id = o.owner_worker_id;

-- Funnel counts per channel, distinguishing opportunities from organizations.
create view public.channel_stage_counts
with (security_invoker = true)
as
select
  o.workspace_id,
  c.kind as channel_kind,
  o.stage,
  count(*) as opportunity_count,
  count(distinct o.organization_id) as organization_count
from public.opportunities o
join public.channels c on c.id = o.channel_id
group by o.workspace_id, c.kind, o.stage;

revoke all on public.opportunity_pipeline, public.channel_stage_counts from anon, authenticated;
grant select on public.opportunity_pipeline, public.channel_stage_counts to authenticated;

-- Record the migrations so the Supabase CLI knows they are applied.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000100', 'foundation') on conflict do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000200', 'core_relationships') on conflict do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000300', 'activity_and_messages') on conflict do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000400', 'offers_and_approvals') on conflict do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000500', 'tasks') on conflict do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261108000600', 'provenance_integrations_storage') on conflict do nothing;
commit;
select 'Gleeday setup complete' as result;
