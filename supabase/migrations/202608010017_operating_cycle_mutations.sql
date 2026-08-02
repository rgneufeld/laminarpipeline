-- Controlled recurring-cycle workflow. Cycles are opened and closed only by an
-- organisation owner, delivery manager, or platform admin; all mutations audit.
create or replace function public.open_operating_cycle(p_project uuid, p_period date)
returns public.operating_cycles language plpgsql security definer set search_path = public as $$
declare project_row public.projects%rowtype;
declare cycle_row public.operating_cycles%rowtype;
declare playbook_code text;
declare normalized_period date;
begin
  select * into project_row from public.projects where id = p_project;
  if project_row.id is null or not public.can_manage_org(project_row.organisation_id) then raise exception 'not authorised'; end if;
  select p.code into playbook_code from public.playbook_versions v join public.playbooks p on p.id = v.playbook_id where v.id = project_row.playbook_version_id;
  if playbook_code not in ('operating-partnership', 'business-operations', 'digital-presence-operations') then raise exception 'operating cycles are only available to operational playbooks'; end if;
  normalized_period := date_trunc('month', p_period)::date;
  insert into public.operating_cycles(project_id, period, status)
  values (p_project, normalized_period, 'active')
  on conflict (project_id, period) do update set status = case when public.operating_cycles.status = 'draft' then 'active' else public.operating_cycles.status end
  returning * into cycle_row;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, p_project, auth.uid(), 'operating_cycle.opened', 'operating_cycle', cycle_row.id, jsonb_build_object('period', normalized_period, 'status', cycle_row.status));
  return cycle_row;
end $$;

create or replace function public.close_operating_cycle(p_cycle uuid)
returns public.operating_cycles language plpgsql security definer set search_path = public as $$
declare cycle_row public.operating_cycles%rowtype;
declare project_row public.projects%rowtype;
begin
  select * into cycle_row from public.operating_cycles where id = p_cycle for update;
  select * into project_row from public.projects where id = cycle_row.project_id;
  if cycle_row.id is null or not public.can_manage_org(project_row.organisation_id) then raise exception 'not authorised'; end if;
  update public.operating_cycles set status = 'closed', locked_at = now() where id = p_cycle returning * into cycle_row;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, cycle_row.project_id, auth.uid(), 'operating_cycle.closed', 'operating_cycle', p_cycle, jsonb_build_object('period', cycle_row.period));
  return cycle_row;
end $$;

create or replace function public.add_cycle_work_item(p_cycle uuid, p_title text, p_estimated_hours numeric default null)
returns public.cycle_work_items language plpgsql security definer set search_path = public as $$
declare cycle_row public.operating_cycles%rowtype;
declare project_row public.projects%rowtype;
declare work_row public.cycle_work_items%rowtype;
begin
  select * into cycle_row from public.operating_cycles where id = p_cycle;
  select * into project_row from public.projects where id = cycle_row.project_id;
  if cycle_row.id is null or cycle_row.status = 'closed' or not public.can_manage_org(project_row.organisation_id) then raise exception 'not authorised'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'work item title is required'; end if;
  if p_estimated_hours is not null and p_estimated_hours < 0 then raise exception 'estimated hours must be positive'; end if;
  insert into public.cycle_work_items(cycle_id, title, status, estimated_hours)
  values(p_cycle, trim(p_title), 'planned', p_estimated_hours) returning * into work_row;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, cycle_row.project_id, auth.uid(), 'cycle_work_item.created', 'cycle_work_item', work_row.id, jsonb_build_object('cycle_id', p_cycle, 'title', work_row.title));
  return work_row;
end $$;

create or replace function public.add_cycle_time_entry(p_cycle uuid, p_hours numeric, p_category text, p_note text default null, p_occurred_on date default current_date)
returns public.cycle_time_entries language plpgsql security definer set search_path = public as $$
declare cycle_row public.operating_cycles%rowtype;
declare project_row public.projects%rowtype;
declare entry_row public.cycle_time_entries%rowtype;
begin
  select * into cycle_row from public.operating_cycles where id = p_cycle;
  select * into project_row from public.projects where id = cycle_row.project_id;
  if cycle_row.id is null or cycle_row.status = 'closed' or not public.can_write_project(cycle_row.project_id) or not public.is_internal_project_user(cycle_row.project_id) then raise exception 'not authorised'; end if;
  if p_hours is null or p_hours <= 0 or nullif(trim(p_category), '') is null then raise exception 'hours and category are required'; end if;
  insert into public.cycle_time_entries(cycle_id, occurred_on, hours, category, note, entered_by)
  values(p_cycle, coalesce(p_occurred_on, current_date), p_hours, trim(p_category), nullif(trim(coalesce(p_note, '')), ''), auth.uid()) returning * into entry_row;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, cycle_row.project_id, auth.uid(), 'cycle_time_entry.created', 'cycle_time_entry', entry_row.id, jsonb_build_object('cycle_id', p_cycle, 'hours', entry_row.hours, 'category', entry_row.category));
  return entry_row;
end $$;

revoke all on function public.open_operating_cycle(uuid, date), public.close_operating_cycle(uuid), public.add_cycle_work_item(uuid, text, numeric), public.add_cycle_time_entry(uuid, numeric, text, text, date) from public;
grant execute on function public.open_operating_cycle(uuid, date), public.close_operating_cycle(uuid), public.add_cycle_work_item(uuid, text, numeric), public.add_cycle_time_entry(uuid, numeric, text, text, date) to authenticated;
