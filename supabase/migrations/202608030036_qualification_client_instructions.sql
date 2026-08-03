-- Client-facing instructions are intentionally distinct from Laminar's private
-- qualification rationale. A saved instruction is reused for a priority item
-- whenever it is included in a group approval request.

alter table public.project_qualification_items
  add column if not exists client_instruction text not null default '';

create or replace function public.save_qualification_client_instruction(p_item uuid, p_instruction text)
returns void language plpgsql security definer set search_path = public as $$
declare v_item public.project_qualification_items%rowtype;
begin
  select * into v_item from public.project_qualification_items where id = p_item;
  if v_item.id is null or not exists(select 1 from public.projects where id = v_item.project_id and public.can_manage_org(organisation_id)) then
    raise exception 'project management access required';
  end if;
  update public.project_qualification_items set client_instruction = trim(coalesce(p_instruction, '')) where id = p_item;
  update public.client_response_requests set instructions = trim(coalesce(p_instruction, '')) where qualification_item_id = p_item and status in ('requested', 'responded');
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_item.project_id, auth.uid(), 'qualification.client_instruction_saved', 'project_qualification_item', p_item, jsonb_build_object('has_instruction', char_length(trim(coalesce(p_instruction, ''))) > 0) from public.projects where id = v_item.project_id;
end $$;

create or replace function public.request_qualification_approval(
  p_item uuid, p_title text, p_client_note text default '', p_due_on date default null,
  p_requires_signed_artifact boolean default false, p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.client_response_requests
language plpgsql security definer set search_path = public as $$
declare v_item public.project_qualification_items%rowtype; v_request public.client_response_requests%rowtype;
begin
  select * into v_item from public.project_qualification_items where id = p_item;
  if v_item.id is null or not exists(select 1 from public.projects where id = v_item.project_id and public.can_manage_org(organisation_id)) then raise exception 'project management access required'; end if;
  update public.project_qualification_items set client_instruction = trim(coalesce(p_client_note, '')) where id = p_item;
  select * into v_request from public.create_client_response_request(v_item.project_id, null, p_title, p_client_note, 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, p_title, null, p_artifact_ids);
  update public.client_response_requests set qualification_item_id = p_item where id = v_request.id returning * into v_request;
  return v_request;
end $$;

create or replace function public.request_qualification_approval_group(
  p_project uuid, p_title text, p_client_note text, p_item_ids uuid[], p_due_on date default null,
  p_requires_signed_artifact boolean default false, p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.qualification_approval_groups
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype; v_group public.qualification_approval_groups%rowtype; v_item_id uuid; v_position integer := 0; v_stable_key text; v_priority boolean; v_client_instruction text; v_priority_request public.client_response_requests%rowtype;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null or not public.can_manage_org(v_project.organisation_id) then raise exception 'project management access required'; end if;
  if coalesce(cardinality(p_item_ids), 0) = 0 then raise exception 'choose at least one qualification item'; end if;
  if exists(select 1 from unnest(p_item_ids) item_id left join public.project_qualification_items q on q.id = item_id where q.id is null or q.project_id <> p_project) then raise exception 'qualification item does not belong to project'; end if;
  select * into v_request from public.create_client_response_request(p_project, null, p_title, p_client_note, 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, p_title, null, p_artifact_ids);
  insert into public.qualification_approval_groups(project_id, request_id, created_by) values(p_project, v_request.id, auth.uid()) returning * into v_group;
  foreach v_item_id in array p_item_ids loop
    select stable_key, client_approval_priority, client_instruction into v_stable_key, v_priority, v_client_instruction from public.project_qualification_items where id = v_item_id;
    insert into public.qualification_approval_group_items(group_id, qualification_item_id, stable_key, requires_individual_approval, position) values(v_group.id, v_item_id, v_stable_key, v_priority, v_position);
    if v_priority then
      select * into v_priority_request from public.create_client_response_request(p_project, null, 'Priority approval required — ' || initcap(replace(v_stable_key, '_', ' ')), coalesce(nullif(trim(v_client_instruction), ''), 'Please review and approve this priority item before completing the group approval package.'), 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, initcap(replace(v_stable_key, '_', ' ')), null, p_artifact_ids);
      update public.client_response_requests set qualification_item_id = v_item_id, parent_request_id = v_request.id where id = v_priority_request.id;
    end if;
    v_position := v_position + 1;
  end loop;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) values(v_project.organisation_id, p_project, auth.uid(), 'qualification.approval_group_requested', 'qualification_approval_group', v_group.id, jsonb_build_object('title', p_title, 'item_count', cardinality(p_item_ids)));
  return v_group;
end $$;

revoke all on function public.save_qualification_client_instruction(uuid, text) from public;
grant execute on function public.save_qualification_client_instruction(uuid, text) to authenticated;
