-- Gleeday update: 20261110000200_oauth_connectors.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261110000200') then
    raise exception 'Update 20261110000200 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100')) < 8 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- OAuth 2.1 for MCP clients that can't send a static token (e.g. claude.ai custom connectors
-- used by routines). An owner/admin signs in, chooses WHICH bot the connector acts as, and
-- approves. The client then receives short-lived bot tokens plus a rotating refresh token.
-- Each connector is bound to one bot identity; bots never share authorization.

create table private.oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  created_at timestamptz not null default now()
);

create table private.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references private.oauth_clients(client_id) on delete cascade,
  worker_id uuid not null references public.worker_identities(id) on delete cascade,
  approved_by_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table private.oauth_codes (
  code_hash text primary key,
  grant_id uuid not null references private.oauth_grants(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table private.oauth_refresh_tokens (
  token_hash text primary key,
  grant_id uuid not null references private.oauth_grants(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table private.worker_credentials add column grant_id uuid references private.oauth_grants(id) on delete cascade;

revoke all on private.oauth_clients, private.oauth_grants, private.oauth_codes, private.oauth_refresh_tokens from public, authenticated;
grant select, insert, update on private.oauth_clients, private.oauth_grants, private.oauth_codes, private.oauth_refresh_tokens to service_role;
grant insert on private.worker_credentials to service_role;

create function private.sha256_hex(p text) returns text language sql immutable set search_path = ''
as $$ select encode(pg_catalog.sha256(convert_to(p, 'UTF8')), 'hex') $$;

create function private.random_token(p_prefix text) returns text language sql volatile set search_path = ''
as $$ select p_prefix || encode(extensions.gen_random_bytes(32), 'hex') $$;

-- Dynamic client registration (RFC 7591). Public clients only (PKCE required).
create function public.oauth_register_client(p_client_name text, p_redirect_uris text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id text := private.random_token('gmc_');
  u text;
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) = 0 then
    raise exception 'redirect_uris required' using errcode = 'invalid_parameter_value';
  end if;
  foreach u in array p_redirect_uris loop
    if u !~ '^https://[^\s#]+$' and u !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/[^\s#]*$' then
      raise exception 'redirect_uri must be https (or http on localhost): %', u using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  insert into private.oauth_clients (client_id, client_name, redirect_uris)
  values (v_id, left(coalesce(nullif(trim(p_client_name), ''), 'MCP client'), 100), p_redirect_uris);
  return jsonb_build_object('client_id', v_id, 'client_name', left(coalesce(nullif(trim(p_client_name), ''), 'MCP client'), 100),
                            'redirect_uris', to_jsonb(p_redirect_uris), 'token_endpoint_auth_method', 'none',
                            'grant_types', jsonb_build_array('authorization_code', 'refresh_token'), 'response_types', jsonb_build_array('code'));
end;
$$;

-- For the consent page (signed-in user): client details if the redirect URI is registered.
create function public.oauth_client_info(p_client_id text, p_redirect_uri text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('client_id', c.client_id, 'client_name', c.client_name)
  from private.oauth_clients c
  where c.client_id = p_client_id and p_redirect_uri = any (c.redirect_uris);
$$;

-- The admin approves: binds the client to one bot and returns a one-time code (10 minutes).
create function public.oauth_authorize(p_client_id text, p_redirect_uri text, p_worker_id uuid, p_code_challenge text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_grant uuid;
  v_code text := private.random_token('gmo_');
begin
  if not exists (select 1 from private.oauth_clients where client_id = p_client_id and p_redirect_uri = any (redirect_uris)) then
    raise exception 'unknown client or redirect_uri' using errcode = 'invalid_parameter_value';
  end if;
  if p_code_challenge !~ '^[A-Za-z0-9_-]{43,128}$' then
    raise exception 'a PKCE S256 code_challenge is required' using errcode = 'invalid_parameter_value';
  end if;
  select workspace_id into v_ws from public.worker_identities where id = p_worker_id and status <> 'revoked';
  if v_ws is null or not private.has_workspace_role(v_ws, array['owner','admin']::public.member_role[]) then
    raise exception 'bot not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
  insert into private.oauth_grants (client_id, worker_id, approved_by_user_id)
  values (p_client_id, p_worker_id, (select auth.uid())) returning id into v_grant;
  insert into private.oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
  values (private.sha256_hex(v_code), v_grant, p_redirect_uri, p_code_challenge, now() + interval '10 minutes');
  return v_code;
end;
$$;

create function private.issue_grant_tokens(p_grant_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_access text := private.random_token('gwk_');
  v_refresh text := private.random_token('gmr_');
  v_g private.oauth_grants;
  v_client text;
begin
  select * into v_g from private.oauth_grants where id = p_grant_id;
  select client_name into v_client from private.oauth_clients where client_id = v_g.client_id;
  insert into private.worker_credentials (worker_id, token_hash, label, expires_at, issued_by_user_id, grant_id)
  values (v_g.worker_id, private.sha256_hex(v_access), 'Connector: ' || v_client, now() + interval '1 hour', v_g.approved_by_user_id, v_g.id);
  insert into private.oauth_refresh_tokens (token_hash, grant_id, expires_at)
  values (private.sha256_hex(v_refresh), v_g.id, now() + interval '90 days');
  return jsonb_build_object('access_token', v_access, 'token_type', 'Bearer', 'expires_in', 3600, 'refresh_token', v_refresh, 'scope', 'bot');
end;
$$;

-- Code exchange with PKCE (S256). Codes are single-use; a reused code revokes the grant.
-- Failures RETURN {"error": "invalid_grant"} (not raise) so that revocations are kept.
create function public.oauth_exchange_code(p_client_id text, p_code text, p_redirect_uri text, p_code_verifier text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_c private.oauth_codes;
  v_g private.oauth_grants;
  v_challenge text;
begin
  select * into v_c from private.oauth_codes where code_hash = private.sha256_hex(coalesce(p_code, '')) for update;
  if not found then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  select * into v_g from private.oauth_grants where id = v_c.grant_id;
  if v_c.used_at is not null then
    update private.oauth_grants set revoked_at = coalesce(revoked_at, now()) where id = v_g.id;
    update private.worker_credentials set revoked_at = coalesce(revoked_at, now()) where grant_id = v_g.id;
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  v_challenge := translate(rtrim(encode(pg_catalog.sha256(convert_to(coalesce(p_code_verifier, ''), 'UTF8')), 'base64'), '='), '+/', '-_');
  if v_c.expires_at <= now() or v_g.client_id <> p_client_id or v_c.redirect_uri <> p_redirect_uri
     or v_challenge <> v_c.code_challenge or v_g.revoked_at is not null then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  update private.oauth_codes set used_at = now() where code_hash = v_c.code_hash;
  return private.issue_grant_tokens(v_g.id);
end;
$$;

-- Refresh with rotation. Reusing an old refresh token revokes the whole grant (theft signal).
create function public.oauth_refresh(p_client_id text, p_refresh_token text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_r private.oauth_refresh_tokens;
  v_g private.oauth_grants;
begin
  select * into v_r from private.oauth_refresh_tokens where token_hash = private.sha256_hex(coalesce(p_refresh_token, '')) for update;
  if not found then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  select * into v_g from private.oauth_grants where id = v_r.grant_id;
  if v_r.used_at is not null then
    update private.oauth_grants set revoked_at = coalesce(revoked_at, now()) where id = v_g.id;
    update private.worker_credentials set revoked_at = coalesce(revoked_at, now()) where grant_id = v_g.id;
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  if v_r.expires_at <= now() or v_g.revoked_at is not null or v_g.client_id <> p_client_id
     or not exists (select 1 from public.worker_identities w where w.id = v_g.worker_id and w.status <> 'revoked') then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  update private.oauth_refresh_tokens set used_at = now() where token_hash = v_r.token_hash;
  return private.issue_grant_tokens(v_g.id);
end;
$$;

-- Admin view + revoke of connector grants.
create function public.ui_connector_grants(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'client_name', c.client_name, 'worker_id', g.worker_id,
      'worker', w.name, 'created_at', g.created_at, 'revoked_at', g.revoked_at,
      'last_used_at', (select max(wc.last_used_at) from private.worker_credentials wc where wc.grant_id = g.id))
    order by g.created_at desc), '[]'::jsonb)
  from private.oauth_grants g
  join private.oauth_clients c on c.client_id = g.client_id
  join public.worker_identities w on w.id = g.worker_id
  where w.workspace_id = p_workspace_id
    and private.has_workspace_role(p_workspace_id, array['owner','admin']::public.member_role[]);
$$;

create function public.revoke_connector_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select w.workspace_id into v_ws from private.oauth_grants g join public.worker_identities w on w.id = g.worker_id where g.id = p_grant_id;
  if v_ws is null or not private.has_workspace_role(v_ws, array['owner','admin']::public.member_role[]) then
    raise exception 'connection not found or not authorized' using errcode = 'insufficient_privilege';
  end if;
  update private.oauth_grants set revoked_at = coalesce(revoked_at, now()) where id = p_grant_id;
  update private.worker_credentials set revoked_at = coalesce(revoked_at, now()) where grant_id = p_grant_id;
end;
$$;

-- Bot list for the consent page (admins only).
create function public.ui_connectable_workers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'role', w.role, 'workspace', ws.name) order by ws.name, w.name), '[]'::jsonb)
  from public.worker_identities w
  join public.workspaces ws on ws.id = w.workspace_id
  where w.status <> 'revoked'
    and private.has_workspace_role(w.workspace_id, array['owner','admin']::public.member_role[]);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.oauth_register_client(text, text[])',
    'public.oauth_exchange_code(text, text, text, text)',
    'public.oauth_refresh(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.oauth_client_info(text, text)',
    'public.oauth_authorize(text, text, uuid, text)',
    'public.ui_connector_grants(uuid)',
    'public.revoke_connector_grant(uuid)',
    'public.ui_connectable_workers()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function private.issue_grant_tokens(uuid) from public, authenticated;
grant execute on function private.issue_grant_tokens(uuid) to service_role;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261110000200', 'oauth_connectors') on conflict do nothing;
commit;
select 'Update 20261110000200 applied' as result;
