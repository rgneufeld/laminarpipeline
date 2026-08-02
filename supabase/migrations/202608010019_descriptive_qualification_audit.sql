-- Keep qualification audit records useful outside the UI as well as within it.
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
    jsonb_build_object('stable_key', row_item.stable_key, 'complete', coalesce(p_complete, false), 'note_updated', p_internal_note is not null)
  from public.projects where id = row_item.project_id;
end $$;
