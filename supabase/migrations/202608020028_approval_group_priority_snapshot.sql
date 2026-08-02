alter table public.qualification_approval_group_items
  add column if not exists requires_individual_approval boolean not null default false;

update public.qualification_approval_group_items gi
set requires_individual_approval = q.client_approval_priority
from public.project_qualification_items q
where q.id = gi.qualification_item_id;

create or replace function public.request_qualification_approval_group(
  p_project uuid, p_title text, p_client_note text, p_item_ids uuid[], p_due_on date default null,
  p_requires_signed_artifact boolean default false, p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.qualification_approval_groups
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype; v_group public.qualification_approval_groups%rowtype; v_item_id uuid; v_position integer := 0; v_stable_key text; v_priority boolean;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null or not public.can_manage_org(v_project.organisation_id) then raise exception 'project management access required'; end if;
  if coalesce(cardinality(p_item_ids), 0) = 0 then raise exception 'choose at least one qualification item'; end if;
  if exists(select 1 from unnest(p_item_ids) item_id left join public.project_qualification_items q on q.id = item_id where q.id is null or q.project_id <> p_project) then raise exception 'qualification item does not belong to project'; end if;
  select * into v_request from public.create_client_response_request(p_project, null, p_title, p_client_note, 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, p_title, null, p_artifact_ids);
  insert into public.qualification_approval_groups(project_id, request_id, created_by) values(p_project, v_request.id, auth.uid()) returning * into v_group;
  foreach v_item_id in array p_item_ids loop
    select stable_key, client_approval_priority into v_stable_key, v_priority from public.project_qualification_items where id = v_item_id;
    insert into public.qualification_approval_group_items(group_id, qualification_item_id, stable_key, requires_individual_approval, position) values(v_group.id, v_item_id, v_stable_key, v_priority, v_position);
    v_position := v_position + 1;
  end loop;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) values(v_project.organisation_id, p_project, auth.uid(), 'qualification.approval_group_requested', 'qualification_approval_group', v_group.id, jsonb_build_object('title', p_title, 'item_count', cardinality(p_item_ids)));
  return v_group;
end $$;

create or replace function public.complete_client_response_request(p_request uuid, p_approval boolean default false)
returns public.client_response_requests language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_has_artifact boolean;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or v_request.status <> 'open' or not public.is_client_project_user(v_request.project_id) then raise exception 'client response access required'; end if;
  select exists(select 1 from public.client_response_artifacts where request_id = p_request) into v_has_artifact;
  if v_request.requires_artifact and not v_has_artifact then raise exception 'a requested document must be attached before completing this response'; end if;
  if p_approval then
    if v_request.request_type <> 'approval' then raise exception 'this request is not an approval'; end if;
    if not exists(select 1 from public.project_members where project_id = v_request.project_id and user_id = auth.uid() and role = 'client_admin') then raise exception 'client administrator access required for approval'; end if;
    if v_request.requires_signed_artifact and not v_has_artifact then raise exception 'a signed document must be attached before approval'; end if;
    if exists(select 1 from public.qualification_approval_groups g join public.qualification_approval_group_items gi on gi.group_id = g.id where g.request_id = p_request and gi.requires_individual_approval and not exists(select 1 from public.client_response_requests r where r.qualification_item_id = gi.qualification_item_id and r.status = 'approved')) then raise exception 'all priority qualification approvals must be completed before this group can be approved'; end if;
  end if;
  update public.client_response_requests set status = case when p_approval then 'approved' else 'responded' end, completed_by = auth.uid(), completed_at = now() where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), case when p_approval then 'client_request.approved' else 'client_request.response_completed' end, 'client_response_request', p_request, jsonb_build_object('title', v_request.title, 'approval_subject', v_request.approval_subject, 'approval_version', v_request.approval_version) from public.projects where id = v_request.project_id;
  insert into public.user_notifications(recipient_user_id, project_id, request_id, kind, title, body) select m.user_id, v_request.project_id, p_request, case when p_approval then 'client_approval_completed' else 'client_response_completed' end, case when p_approval then 'Client approval received: ' else 'Client response received: ' end || v_request.title, '' from public.project_members m where m.project_id = v_request.project_id and m.role in ('organisation_owner', 'delivery_manager', 'contributor');
  return v_request;
end $$;

revoke all on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]), public.complete_client_response_request(uuid, boolean) from public;
grant execute on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]), public.complete_client_response_request(uuid, boolean) to authenticated;
