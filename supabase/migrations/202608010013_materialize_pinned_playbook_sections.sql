-- Materialize each project’s pinned standard sections. Legacy state is overlaid
-- when present; an empty state object means the standard row is still created.

with project_source as (
  select project.id as project_id, version.definition,
    coalesce((select event.payload -> 'legacy_snapshot' from public.audit_events event where event.project_id = project.id and event.event_type = 'legacy.backup_imported' order by event.occurred_at desc limit 1), '{}'::jsonb) as legacy
  from public.projects project
  join public.playbook_versions version on version.id = project.playbook_version_id
)
insert into public.project_qualification_items (project_id, stable_key, complete)
select source.project_id, item ->> 'id', coalesce((source.legacy #>> array['qualification', item ->> 'id', 'value'])::boolean, false)
from project_source source
cross join lateral jsonb_array_elements(coalesce(source.definition -> 'qualification', '[]'::jsonb)) item
on conflict (project_id, stable_key) do nothing;

with project_source as (
  select project.id as project_id, version.definition,
    coalesce((select event.payload -> 'legacy_snapshot' from public.audit_events event where event.project_id = project.id and event.event_type = 'legacy.backup_imported' order by event.occurred_at desc limit 1), '{}'::jsonb) as legacy
  from public.projects project
  join public.playbook_versions version on version.id = project.playbook_version_id
), asset_source as (
  select source.project_id, item ->> 'id' as stable_key, item,
    coalesce(source.legacy #> array['assets', item ->> 'id'], '{}'::jsonb) as state
  from project_source source
  cross join lateral jsonb_array_elements(coalesce(source.definition -> 'assets', '[]'::jsonb)) item
)
insert into public.project_asset_items (project_id, stable_key, status, internal_note, metadata)
select project_id, stable_key,
  case when replace(coalesce(state ->> 'status', 'missing'), '-', '_') in ('missing', 'requested', 'received', 'not_required') then replace(coalesce(state ->> 'status', 'missing'), '-', '_') else 'missing' end,
  coalesce(state ->> 'internalNote', ''),
  item || jsonb_build_object('legacy_state', state)
from asset_source
on conflict (project_id, stable_key) do update set
  status = excluded.status,
  internal_note = excluded.internal_note,
  metadata = public.project_asset_items.metadata || excluded.metadata,
  updated_at = now();

with project_source as (
  select project.id as project_id, version.definition,
    coalesce((select event.payload -> 'legacy_snapshot' from public.audit_events event where event.project_id = project.id and event.event_type = 'legacy.backup_imported' order by event.occurred_at desc limit 1), '{}'::jsonb) as legacy
  from public.projects project
  join public.playbook_versions version on version.id = project.playbook_version_id
), deliverable_source as (
  select source.project_id, item ->> 'id' as stable_key, item,
    coalesce(source.legacy #> array['deliverables', item ->> 'id'], '{}'::jsonb) as state
  from project_source source
  cross join lateral jsonb_array_elements(coalesce(source.definition -> 'deliverables', '[]'::jsonb)) item
)
insert into public.deliverables (project_id, stable_key, title, status, client_visible, metadata)
select project_id, stable_key, coalesce(item ->> 'name', stable_key),
  case when state ->> 'status' in ('pending', 'delivered', 'approved') then state ->> 'status' else 'pending' end,
  false,
  item || jsonb_build_object('legacy_state', state)
from deliverable_source
on conflict (project_id, stable_key) where stable_key is not null do update set
  title = excluded.title,
  status = excluded.status,
  metadata = public.deliverables.metadata || excluded.metadata;

with project_source as (
  select project.id as project_id, version.definition,
    coalesce((select event.payload -> 'legacy_snapshot' from public.audit_events event where event.project_id = project.id and event.event_type = 'legacy.backup_imported' order by event.occurred_at desc limit 1), '{}'::jsonb) as legacy
  from public.projects project
  join public.playbook_versions version on version.id = project.playbook_version_id
), training_source as (
  select source.project_id, item ->> 'id' as stable_key, item,
    coalesce(source.legacy #> array['training', item ->> 'id'], '{}'::jsonb) as state
  from project_source source
  cross join lateral jsonb_array_elements(coalesce(source.definition -> 'training', '[]'::jsonb)) item
)
insert into public.training_records (project_id, stable_key, status, metadata)
select project_id, stable_key,
  case when jsonb_typeof(state -> 'competencies') = 'object' and state -> 'competencies' <> '{}'::jsonb then 'in_progress' else 'pending' end,
  item || jsonb_build_object('legacy_state', state)
from training_source
on conflict (project_id, stable_key) do update set
  status = excluded.status,
  metadata = public.training_records.metadata || excluded.metadata;
