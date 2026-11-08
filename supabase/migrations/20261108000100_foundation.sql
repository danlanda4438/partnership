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
