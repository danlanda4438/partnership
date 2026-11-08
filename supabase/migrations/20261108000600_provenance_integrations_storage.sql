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
