-- Qualification is a decision record: retain an internal rationale and link
-- approved project artifacts without weakening the artifact's own RLS rules.
alter table public.project_qualification_items
  add column if not exists internal_note text not null default '';

create table if not exists public.qualification_item_artifacts (
  qualification_item_id uuid not null references public.project_qualification_items(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete restrict,
  attached_by uuid not null references auth.users(id),
  attached_at timestamptz not null default now(),
  primary key (qualification_item_id, artifact_id)
);

alter table public.qualification_item_artifacts enable row level security;
create policy qualification_artifact_read on public.qualification_item_artifacts for select to authenticated
  using (exists(select 1 from public.project_qualification_items q where q.id = qualification_item_id and public.is_internal_project_user(q.project_id)));
create policy qualification_artifact_write on public.qualification_item_artifacts for all to authenticated
  using (exists(select 1 from public.project_qualification_items q where q.id = qualification_item_id and public.is_internal_project_user(q.project_id)))
  with check (exists(select 1 from public.project_qualification_items q where q.id = qualification_item_id and public.is_internal_project_user(q.project_id)));
grant select, insert, delete on public.qualification_item_artifacts to authenticated;

create or replace function public.update_project_qualification(p_item uuid, p_complete boolean, p_internal_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare row_item public.project_qualification_items%rowtype;
begin
  select * into row_item from public.project_qualification_items where id = p_item;
  if row_item.id is null or not public.can_write_project(row_item.project_id) or not public.is_internal_project_user(row_item.project_id) then raise exception 'not authorised'; end if;
  update public.project_qualification_items
  set complete = coalesce(p_complete, false),
      internal_note = coalesce(p_internal_note, internal_note),
      completed_at = case when p_complete then now() else null end,
      completed_by = case when p_complete then auth.uid() else null end
  where id = p_item;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_item.project_id, auth.uid(), 'qualification.updated', 'project_qualification_item', p_item,
    jsonb_build_object('complete', coalesce(p_complete, false), 'note_updated', p_internal_note is not null)
  from public.projects where id = row_item.project_id;
end $$;

create or replace function public.attach_qualification_artifact(p_item uuid, p_artifact uuid)
returns void language plpgsql security definer set search_path = public as $$
declare row_item public.project_qualification_items%rowtype;
declare artifact_project uuid;
begin
  select * into row_item from public.project_qualification_items where id = p_item;
  select project_id into artifact_project from public.artifacts where id = p_artifact;
  if row_item.id is null or artifact_project is distinct from row_item.project_id or not public.can_write_project(row_item.project_id) or not public.is_internal_project_user(row_item.project_id) then raise exception 'not authorised'; end if;
  insert into public.qualification_item_artifacts(qualification_item_id, artifact_id, attached_by)
  values(p_item, p_artifact, auth.uid()) on conflict do nothing;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_item.project_id, auth.uid(), 'qualification.artifact_attached', 'project_qualification_item', p_item, jsonb_build_object('artifact_id', p_artifact)
  from public.projects where id = row_item.project_id;
end $$;

create or replace function public.detach_qualification_artifact(p_item uuid, p_artifact uuid)
returns void language plpgsql security definer set search_path = public as $$
declare row_item public.project_qualification_items%rowtype;
begin
  select * into row_item from public.project_qualification_items where id = p_item;
  if row_item.id is null or not public.can_write_project(row_item.project_id) or not public.is_internal_project_user(row_item.project_id) then raise exception 'not authorised'; end if;
  delete from public.qualification_item_artifacts where qualification_item_id = p_item and artifact_id = p_artifact;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_item.project_id, auth.uid(), 'qualification.artifact_detached', 'project_qualification_item', p_item, jsonb_build_object('artifact_id', p_artifact)
  from public.projects where id = row_item.project_id;
end $$;

revoke all on function public.update_project_qualification(uuid, boolean, text), public.attach_qualification_artifact(uuid, uuid), public.detach_qualification_artifact(uuid, uuid) from public;
grant execute on function public.update_project_qualification(uuid, boolean, text), public.attach_qualification_artifact(uuid, uuid), public.detach_qualification_artifact(uuid, uuid) to authenticated;
