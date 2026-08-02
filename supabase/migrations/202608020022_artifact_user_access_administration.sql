-- Named-user access grants for restricted artifacts. Only organisation managers
-- can change grants, and each mutation is recorded in the project audit trail.
create or replace function public.set_artifact_user_access(p_artifact uuid, p_user uuid, p_can_view boolean, p_can_upload_version boolean default false, p_can_comment boolean default false, p_can_approve boolean default false, p_can_manage boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare artifact_row public.artifacts%rowtype;
begin
  select * into artifact_row from public.artifacts where id = p_artifact;
  if artifact_row.id is null or not public.can_manage_org(artifact_row.organisation_id) then raise exception 'organisation management access required'; end if;
  if not exists(select 1 from public.organisation_memberships where organisation_id = artifact_row.organisation_id and user_id = p_user) then raise exception 'user is not an organisation member'; end if;
  insert into public.artifact_access_grants(artifact_id, user_id, can_view, can_upload_version, can_comment, can_approve, can_manage, granted_by)
  values(p_artifact, p_user, coalesce(p_can_view, true), coalesce(p_can_upload_version, false), coalesce(p_can_comment, false), coalesce(p_can_approve, false), coalesce(p_can_manage, false), auth.uid())
  on conflict (artifact_id, user_id) where user_id is not null do update set can_view = excluded.can_view, can_upload_version = excluded.can_upload_version, can_comment = excluded.can_comment, can_approve = excluded.can_approve, can_manage = excluded.can_manage, granted_by = auth.uid(), created_at = now();
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(artifact_row.organisation_id, artifact_row.project_id, auth.uid(), 'artifact.access_granted', 'artifact', p_artifact, jsonb_build_object('user_id', p_user, 'can_view', p_can_view, 'can_upload_version', p_can_upload_version, 'can_comment', p_can_comment, 'can_approve', p_can_approve, 'can_manage', p_can_manage));
end $$;

create or replace function public.remove_artifact_user_access(p_artifact uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare artifact_row public.artifacts%rowtype;
begin
  select * into artifact_row from public.artifacts where id = p_artifact;
  if artifact_row.id is null or not public.can_manage_org(artifact_row.organisation_id) then raise exception 'organisation management access required'; end if;
  delete from public.artifact_access_grants where artifact_id = p_artifact and user_id = p_user;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(artifact_row.organisation_id, artifact_row.project_id, auth.uid(), 'artifact.access_removed', 'artifact', p_artifact, jsonb_build_object('user_id', p_user));
end $$;

revoke all on function public.set_artifact_user_access(uuid, uuid, boolean, boolean, boolean, boolean, boolean), public.remove_artifact_user_access(uuid, uuid) from public;
grant execute on function public.set_artifact_user_access(uuid, uuid, boolean, boolean, boolean, boolean, boolean), public.remove_artifact_user_access(uuid, uuid) to authenticated;
