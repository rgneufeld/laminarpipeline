-- Controlled browser mutations for the materialized project sections. Every
-- update verifies project access server-side and creates an immutable audit row.

create or replace function public.update_project_asset_item(p_item uuid, p_status text, p_internal_note text)
returns void language plpgsql security definer set search_path = public as $$
declare row_item public.project_asset_items%rowtype;
begin
  select * into row_item from public.project_asset_items where id = p_item;
  if row_item.id is null or not public.can_write_project(row_item.project_id) or not public.is_internal_project_user(row_item.project_id) then raise exception 'not authorised'; end if;
  if p_status not in ('missing', 'requested', 'received', 'not_required') then raise exception 'invalid asset status'; end if;
  update public.project_asset_items set status = p_status, internal_note = coalesce(p_internal_note, ''), updated_by = auth.uid(), updated_at = now() where id = p_item;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_item.project_id, auth.uid(), 'project_asset.updated', 'project_asset_item', p_item, jsonb_build_object('status', p_status)
  from public.projects where id = row_item.project_id;
end $$;

create or replace function public.update_project_deliverable(p_deliverable uuid, p_status text, p_client_visible boolean)
returns void language plpgsql security definer set search_path = public as $$
declare row_deliverable public.deliverables%rowtype;
begin
  select * into row_deliverable from public.deliverables where id = p_deliverable;
  if row_deliverable.id is null or not public.can_write_project(row_deliverable.project_id) or not public.is_internal_project_user(row_deliverable.project_id) then raise exception 'not authorised'; end if;
  if p_status not in ('pending', 'delivered', 'approved') then raise exception 'invalid deliverable status'; end if;
  update public.deliverables set status = p_status, client_visible = coalesce(p_client_visible, false) where id = p_deliverable;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_deliverable.project_id, auth.uid(), 'deliverable.updated', 'deliverable', p_deliverable, jsonb_build_object('status', p_status, 'client_visible', coalesce(p_client_visible, false))
  from public.projects where id = row_deliverable.project_id;
end $$;

create or replace function public.update_project_qualification(p_item uuid, p_complete boolean)
returns void language plpgsql security definer set search_path = public as $$
declare row_item public.project_qualification_items%rowtype;
begin
  select * into row_item from public.project_qualification_items where id = p_item;
  if row_item.id is null or not public.can_write_project(row_item.project_id) or not public.is_internal_project_user(row_item.project_id) then raise exception 'not authorised'; end if;
  update public.project_qualification_items set complete = coalesce(p_complete, false), completed_at = case when p_complete then now() else null end, completed_by = case when p_complete then auth.uid() else null end where id = p_item;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_item.project_id, auth.uid(), 'qualification.updated', 'project_qualification_item', p_item, jsonb_build_object('complete', coalesce(p_complete, false))
  from public.projects where id = row_item.project_id;
end $$;

create or replace function public.update_training_record(p_record uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare row_record public.training_records%rowtype;
begin
  select * into row_record from public.training_records where id = p_record;
  if row_record.id is null or not public.can_write_project(row_record.project_id) or not public.is_internal_project_user(row_record.project_id) then raise exception 'not authorised'; end if;
  if p_status not in ('pending', 'in_progress', 'complete') then raise exception 'invalid training status'; end if;
  update public.training_records set status = p_status, signed_off_at = case when p_status = 'complete' then now() else null end, signed_off_by = case when p_status = 'complete' then auth.uid() else null end where id = p_record;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, row_record.project_id, auth.uid(), 'training.updated', 'training_record', p_record, jsonb_build_object('status', p_status)
  from public.projects where id = row_record.project_id;
end $$;

revoke all on function public.update_project_asset_item(uuid, text, text) from public;
revoke all on function public.update_project_deliverable(uuid, text, boolean) from public;
revoke all on function public.update_project_qualification(uuid, boolean) from public;
revoke all on function public.update_training_record(uuid, text) from public;
grant execute on function public.update_project_asset_item(uuid, text, text), public.update_project_deliverable(uuid, text, boolean), public.update_project_qualification(uuid, boolean), public.update_training_record(uuid, text) to authenticated;
