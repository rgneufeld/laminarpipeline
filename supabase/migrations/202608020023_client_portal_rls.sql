-- Client portal boundary: client roles see only explicitly client-facing work.
-- Internal delivery, audit, qualification, evidence, and operating data stay
-- unavailable even if someone calls the Data API directly.

create or replace function public.is_client_project_user(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.project_members m
    where m.project_id = p_project
      and m.user_id = (select auth.uid())
      and m.role in ('client_admin', 'client_collaborator')
  )
$$;

revoke all on function public.is_client_project_user(uuid) from public;
grant execute on function public.is_client_project_user(uuid) to authenticated;

drop policy if exists project_member_read on public.project_members;
create policy project_member_read on public.project_members
  for select to authenticated
  using (public.is_internal_project_user(project_id) or user_id = (select auth.uid()));

drop policy if exists task_read on public.project_tasks;
create policy task_read on public.project_tasks
  for select to authenticated
  using (
    public.is_internal_project_user(project_id)
    or (
      public.is_client_project_user(project_id)
      and exists (
        select 1 from public.playbook_task_templates t
        where t.id = task_template_id and t.client_action
      )
    )
  );

drop policy if exists transition_read on public.task_transition_events;
create policy transition_read on public.task_transition_events
  for select to authenticated
  using (public.is_internal_project_user(project_id));

drop policy if exists evidence_read on public.evidence_records;
create policy evidence_read on public.evidence_records
  for select to authenticated
  using (public.is_internal_project_user(project_id));

drop policy if exists evidence_insert on public.evidence_records;
create policy evidence_insert on public.evidence_records
  for insert to authenticated
  with check (public.is_internal_project_user(project_id));

drop policy if exists project_data_read on public.deliverables;
drop policy if exists deliverable_read on public.deliverables;
create policy deliverable_read on public.deliverables
  for select to authenticated
  using (
    public.is_internal_project_user(project_id)
    or (
      public.is_client_project_user(project_id)
      and client_visible
      and status in ('delivered', 'approved')
    )
  );

drop policy if exists deliverable_write on public.deliverables;
create policy deliverable_write on public.deliverables
  for all to authenticated
  using (public.is_internal_project_user(project_id))
  with check (public.is_internal_project_user(project_id));

drop policy if exists training_read on public.training_records;
create policy training_read on public.training_records
  for select to authenticated
  using (
    public.is_internal_project_user(project_id)
    or (public.is_client_project_user(project_id) and status = 'complete')
  );

drop policy if exists training_write on public.training_records;
create policy training_write on public.training_records
  for all to authenticated
  using (public.is_internal_project_user(project_id))
  with check (public.is_internal_project_user(project_id));

drop policy if exists cycle_read on public.operating_cycles;
create policy cycle_read on public.operating_cycles
  for select to authenticated
  using (public.is_internal_project_user(project_id));

drop policy if exists cycle_write on public.operating_cycles;
create policy cycle_write on public.operating_cycles
  for all to authenticated
  using (public.is_internal_project_user(project_id))
  with check (public.is_internal_project_user(project_id));

drop policy if exists cycle_work_read on public.cycle_work_items;
create policy cycle_work_read on public.cycle_work_items
  for select to authenticated
  using (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)));

drop policy if exists cycle_work_write on public.cycle_work_items;
create policy cycle_work_write on public.cycle_work_items
  for all to authenticated
  using (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)))
  with check (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)));

drop policy if exists cycle_time_read on public.cycle_time_entries;
create policy cycle_time_read on public.cycle_time_entries
  for select to authenticated
  using (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)));

drop policy if exists cycle_time_write on public.cycle_time_entries;
create policy cycle_time_write on public.cycle_time_entries
  for all to authenticated
  using (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)))
  with check (exists(select 1 from public.operating_cycles c where c.id = cycle_id and public.is_internal_project_user(c.project_id)));

drop policy if exists audit_read on public.audit_events;
create policy audit_read on public.audit_events
  for select to authenticated
  using (project_id is not null and public.is_internal_project_user(project_id));

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
  select * into v_task from public.project_tasks where id = p_task for update;
  if not found or not public.can_write_project(v_task.project_id) then raise exception 'not authorised'; end if;
  if not public.is_internal_project_user(v_task.project_id) and not exists (
    select 1 from public.playbook_task_templates where id = v_task.task_template_id and client_action
  ) then
    raise exception 'client action access required';
  end if;
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

create or replace function public.approve_client_deliverable(p_deliverable uuid)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare v_deliverable public.deliverables;
begin
  select * into v_deliverable from public.deliverables where id = p_deliverable for update;
  if not found
    or not v_deliverable.client_visible
    or v_deliverable.status <> 'delivered'
    or not exists(select 1 from public.project_members where project_id = v_deliverable.project_id and user_id = (select auth.uid()) and role = 'client_admin')
  then raise exception 'not authorised to approve this deliverable'; end if;
  update public.deliverables set status = 'approved', approved_at = now(), approved_by = (select auth.uid()) where id = p_deliverable returning * into v_deliverable;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_deliverable.project_id, (select auth.uid()), 'deliverable.client_approved', 'deliverable', p_deliverable, jsonb_build_object('title', v_deliverable.title)
  from public.projects where id = v_deliverable.project_id;
  return v_deliverable;
end;
$$;

revoke all on function public.transition_project_task(uuid, public.task_stage, text, text) from public;
grant execute on function public.transition_project_task(uuid, public.task_stage, text, text) to authenticated;
revoke all on function public.approve_client_deliverable(uuid) from public;
grant execute on function public.approve_client_deliverable(uuid) to authenticated;
