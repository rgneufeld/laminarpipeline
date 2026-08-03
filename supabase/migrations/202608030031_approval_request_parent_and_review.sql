-- Link automatic priority approvals to their package and keep client response
-- separate from Laminar's review/completion decision.

update public.client_response_requests child
set parent_request_id = g.request_id
from public.qualification_approval_groups g
join public.qualification_approval_group_items gi on gi.group_id = g.id
where child.parent_request_id is null
  and child.project_id = g.project_id
  and child.qualification_item_id = gi.qualification_item_id
  and gi.requires_individual_approval
  and child.title like 'Priority approval required — %'
  and child.created_at >= g.created_at;

create or replace function public.request_qualification_approval_group(
  p_project uuid, p_title text, p_client_note text, p_item_ids uuid[], p_due_on date default null,
  p_requires_signed_artifact boolean default false, p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.qualification_approval_groups
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype; v_group public.qualification_approval_groups%rowtype; v_item_id uuid; v_position integer := 0; v_stable_key text; v_priority boolean; v_priority_request public.client_response_requests%rowtype;
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
    if v_priority then
      select * into v_priority_request from public.create_client_response_request(p_project, null, 'Priority approval required — ' || initcap(replace(v_stable_key, '_', ' ')), 'Please review and approve this priority item before completing the group approval package.', 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, initcap(replace(v_stable_key, '_', ' ')), null, p_artifact_ids);
      update public.client_response_requests set qualification_item_id = v_item_id, parent_request_id = v_request.id where id = v_priority_request.id;
    end if;
    v_position := v_position + 1;
  end loop;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) values(v_project.organisation_id, p_project, auth.uid(), 'qualification.approval_group_requested', 'qualification_approval_group', v_group.id, jsonb_build_object('title', p_title, 'item_count', cardinality(p_item_ids)));
  return v_group;
end $$;

create or replace function public.submit_client_response_request(p_request uuid, p_note text default 'Accepted', p_signing_name text default null)
returns public.client_response_requests language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_has_artifact boolean; v_note text;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or v_request.status <> 'requested' or not public.is_client_project_user(v_request.project_id) then raise exception 'client response access required'; end if;
  select exists(select 1 from public.client_response_artifacts where request_id = p_request) into v_has_artifact;
  if v_request.requires_artifact and not v_has_artifact then raise exception 'a requested document must be attached before responding'; end if;
  if v_request.requires_signed_artifact and not v_has_artifact then raise exception 'a signed document must be attached before responding'; end if;
  if v_request.request_type = 'approval' and nullif(trim(coalesce(p_signing_name, '')), '') is null then raise exception 'signing name is required for an approval response'; end if;
  if exists(select 1 from public.qualification_approval_groups g join public.qualification_approval_group_items gi on gi.group_id = g.id where g.request_id = p_request and gi.requires_individual_approval and not exists(select 1 from public.client_response_requests r where r.qualification_item_id = gi.qualification_item_id and r.status in ('responded', 'completed'))) then raise exception 'submit every required priority approval before responding to this package'; end if;
  v_note := coalesce(nullif(trim(p_note), ''), 'Accepted');
  insert into public.client_response_messages(request_id, body, created_by) values(p_request, v_note || case when nullif(trim(coalesce(p_signing_name, '')), '') is not null then E'\nSigned by: ' || trim(p_signing_name) else '' end, auth.uid());
  update public.client_response_requests set status = 'responded', responded_by = auth.uid(), responded_at = now(), response_signing_name = nullif(trim(p_signing_name), '') where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), 'client_request.responded', 'client_response_request', p_request, jsonb_build_object('title', v_request.title, 'signing_name', v_request.response_signing_name) from public.projects where id = v_request.project_id;
  insert into public.user_notifications(recipient_user_id, project_id, request_id, kind, title, body) select m.user_id, v_request.project_id, p_request, 'client_response_completed', 'Client response ready for review: ' || v_request.title, 'Review the response and complete or cancel the request.' from public.project_members m where m.project_id = v_request.project_id and m.role in ('organisation_owner', 'delivery_manager', 'contributor');
  return v_request;
end $$;

revoke all on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]), public.submit_client_response_request(uuid, text, text) from public;
grant execute on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]), public.submit_client_response_request(uuid, text, text) to authenticated;
