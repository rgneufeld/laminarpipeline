-- Materialize a project from one immutable published playbook version.
-- This is the only intended project-creation path for the application.

create function public.create_project_from_playbook(
  p_organisation_id uuid,
  p_playbook_version_id uuid,
  p_name text,
  p_client_name text default null
) returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects;
begin
  if not public.can_manage_org(p_organisation_id) then
    raise exception 'not authorised';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'project name is required';
  end if;

  if not exists (
    select 1 from public.playbook_versions
    where id = p_playbook_version_id and status = 'published'
  ) then
    raise exception 'playbook version must be published';
  end if;

  insert into public.projects (organisation_id, playbook_version_id, name, client_name, created_by)
  values (p_organisation_id, p_playbook_version_id, trim(p_name), nullif(trim(p_client_name), ''), (select auth.uid()))
  returning * into v_project;

  insert into public.project_tasks (project_id, phase_id, task_template_id, stable_key, title, sort_rank)
  select
    v_project.id,
    phase.id,
    template.id,
    template.stable_key,
    template.title,
    phase.position * 10000 + template.position
  from public.playbook_phases phase
  join public.playbook_task_templates template on template.phase_id = phase.id
  where phase.playbook_version_id = p_playbook_version_id
  order by phase.position, template.position;

  insert into public.audit_events (organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values (
    p_organisation_id,
    v_project.id,
    (select auth.uid()),
    'project.created',
    'project',
    v_project.id,
    jsonb_build_object('playbook_version_id', p_playbook_version_id)
  );

  return v_project;
end;
$$;

revoke all on function public.create_project_from_playbook(uuid, uuid, text, text) from public;
grant execute on function public.create_project_from_playbook(uuid, uuid, text, text) to authenticated;
