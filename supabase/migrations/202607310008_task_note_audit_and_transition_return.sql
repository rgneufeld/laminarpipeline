-- Align the production transition contract with the Laminar workflow and make
-- task-note writes auditable. The browser continues to use only authenticated
-- RPC calls; it cannot bypass transition validation or assign its own audit actor.

update public.project_tasks
set metadata = jsonb_set(metadata, '{blocked_from}', metadata->'legacy_blocked_from', true)
where stage = 'blocked'
  and metadata ? 'legacy_blocked_from'
  and not metadata ? 'blocked_from';

create unique index if not exists task_notes_task_visibility_key
  on public.task_notes(task_id, visibility);

create or replace function public.upsert_task_note(
  p_task uuid,
  p_visibility public.note_visibility,
  p_body text
) returns public.task_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.project_tasks;
  v_note public.task_notes;
begin
  select * into v_task from public.project_tasks where id = p_task;
  if not found or not public.can_write_project(v_task.project_id) then
    raise exception 'not authorised';
  end if;
  if p_visibility = 'internal' and not public.is_internal_project_user(v_task.project_id) then
    raise exception 'not authorised for internal notes';
  end if;

  insert into public.task_notes(project_id, task_id, visibility, body, created_by, updated_at)
  values(v_task.project_id, p_task, p_visibility, coalesce(p_body, ''), (select auth.uid()), now())
  on conflict(task_id, visibility) do update
    set body = excluded.body,
        updated_at = now(),
        created_by = (select auth.uid())
  returning * into v_note;

  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_task.project_id, (select auth.uid()), 'task.note_updated', 'task_note', v_note.id,
         jsonb_build_object('task_id', p_task, 'visibility', p_visibility)
  from public.projects where id = v_task.project_id;

  return v_note;
end;
$$;

revoke all on function public.upsert_task_note(uuid, public.note_visibility, text) from public;
grant execute on function public.upsert_task_note(uuid, public.note_visibility, text) to authenticated;
revoke insert, update, delete on public.task_notes from authenticated;

create or replace function public.transition_project_task(
  p_task uuid,
  p_to public.task_stage,
  p_blocked_reason text default null,
  p_client_note text default null
) returns public.project_tasks
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.project_tasks; v_from public.task_stage; v_ok boolean := false;
begin
  select * into v_task from public.project_tasks where id=p_task for update;
  if not found or not public.can_write_project(v_task.project_id) then raise exception 'not authorised'; end if;
  v_from := v_task.stage;
  v_ok := (v_task.stage='pending' and p_to in ('in_scope','na'))
    or (v_task.stage='in_scope' and p_to in ('pending','active','na','blocked'))
    or (v_task.stage='na' and p_to='in_scope')
    or (v_task.stage='active' and p_to in ('client_review','complete','blocked','in_scope','na'))
    or (v_task.stage='blocked' and (p_to='na' or p_to::text=coalesce(v_task.metadata->>'blocked_from','')))
    or (v_task.stage='client_review' and p_to in ('complete','active','blocked'))
    or (v_task.stage='complete' and p_to in ('delivered','active','blocked'))
    or (v_task.stage='delivered' and p_to='complete');
  if not v_ok or (p_to='blocked' and nullif(trim(coalesce(p_blocked_reason,'')),'') is null) then raise exception 'invalid task transition'; end if;
  if p_to='delivered' and not exists(select 1 from public.task_transition_events where task_id=p_task and to_stage='complete') then raise exception 'task must first be complete'; end if;
  perform set_config('app.allow_task_transition', 'true', true);
  update public.project_tasks set stage=p_to, blocked_reason=case when p_to='blocked' then p_blocked_reason else null end, entered_stage_at=now(), completed_at=case when p_to='complete' then now() else completed_at end, delivered_at=case when p_to='delivered' then now() else delivered_at end, metadata=case when p_to='blocked' then jsonb_set(metadata,'{blocked_from}',to_jsonb(v_from::text)) else metadata - 'blocked_from' end where id=p_task returning * into v_task;
  insert into public.task_transition_events(project_id,task_id,from_stage,to_stage,blocked_reason,actor_id,client_note) values(v_task.project_id,p_task,v_from,p_to,p_blocked_reason,(select auth.uid()),p_client_note);
  insert into public.audit_events(organisation_id,project_id,actor_id,event_type,entity_type,entity_id,payload) select organisation_id,v_task.project_id,(select auth.uid()),'task.transition','project_task',p_task,jsonb_build_object('from',v_from,'to',p_to) from public.projects where id=v_task.project_id;
  return v_task;
end;
$$;

revoke all on function public.transition_project_task(uuid, public.task_stage, text, text) from public;
grant execute on function public.transition_project_task(uuid, public.task_stage, text, text) to authenticated;
