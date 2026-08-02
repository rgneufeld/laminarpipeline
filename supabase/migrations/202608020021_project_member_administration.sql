-- Project membership is a subset of organisation membership. The project role
-- always mirrors the organisation role so it cannot elevate a user.
create or replace function public.assign_project_member(p_project uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare project_row public.projects%rowtype;
declare member_role public.app_role;
begin
  select * into project_row from public.projects where id = p_project;
  if project_row.id is null or not public.can_manage_org(project_row.organisation_id) then raise exception 'project management access required'; end if;
  select role into member_role from public.organisation_memberships where organisation_id = project_row.organisation_id and user_id = p_user;
  if member_role is null or member_role = 'platform_admin' then raise exception 'user is not an organisation member'; end if;
  insert into public.project_members(project_id, user_id, role) values(p_project, p_user, member_role)
  on conflict (project_id, user_id) do update set role = excluded.role;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, p_project, auth.uid(), 'project_member.assigned', 'project_member', p_user, jsonb_build_object('role', member_role));
end $$;

create or replace function public.remove_project_member(p_project uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare project_row public.projects%rowtype;
begin
  select * into project_row from public.projects where id = p_project;
  if project_row.id is null or not public.can_manage_org(project_row.organisation_id) then raise exception 'project management access required'; end if;
  delete from public.project_members where project_id = p_project and user_id = p_user;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(project_row.organisation_id, p_project, auth.uid(), 'project_member.removed', 'project_member', p_user, '{}'::jsonb);
end $$;

revoke all on function public.assign_project_member(uuid, uuid), public.remove_project_member(uuid, uuid) from public;
grant execute on function public.assign_project_member(uuid, uuid), public.remove_project_member(uuid, uuid) to authenticated;
