-- Materialized home for Laminar's legacy project sections. The original JSON
-- import snapshot remains immutable audit evidence; these tables make the same
-- data available to the collaborative application without treating browser
-- storage as the source of truth.

alter table public.projects
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.project_asset_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stable_key text not null,
  status text not null default 'missing' check (status in ('missing', 'requested', 'received', 'not_required')),
  internal_note text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique(project_id, stable_key)
);

alter table public.deliverables
  add column if not exists stable_key text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists deliverables_project_stable_key
  on public.deliverables(project_id, stable_key) where stable_key is not null;

alter table public.training_records
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.operating_cycles
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.cycle_work_items
  add column if not exists legacy_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists cycle_work_items_cycle_legacy_key
  on public.cycle_work_items(cycle_id, legacy_id) where legacy_id is not null;

alter table public.cycle_time_entries
  add column if not exists legacy_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists cycle_time_entries_cycle_legacy_key
  on public.cycle_time_entries(cycle_id, legacy_id) where legacy_id is not null;

alter table public.project_asset_items enable row level security;
create policy project_asset_item_read on public.project_asset_items for select to authenticated
  using (public.is_internal_project_user(project_id));
create policy project_asset_item_write on public.project_asset_items for all to authenticated
  using (public.is_internal_project_user(project_id))
  with check (public.is_internal_project_user(project_id));
grant select, insert, update, delete on public.project_asset_items to authenticated;
