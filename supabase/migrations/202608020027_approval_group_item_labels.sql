-- Store a client-safe snapshot label on each group item. Clients must not read
-- internal qualification records merely to understand an approval package.

alter table public.qualification_approval_group_items
  add column if not exists stable_key text;

update public.qualification_approval_group_items gi
set stable_key = q.stable_key
from public.project_qualification_items q
where q.id = gi.qualification_item_id and gi.stable_key is null;

alter table public.qualification_approval_group_items
  alter column stable_key set not null;

create or replace function public.request_qualification_approval_group(
  p_project uuid,
  p_title text,
  p_client_note text,
  p_item_ids uuid[],
  p_due_on date default null,
  p_requires_signed_artifact boolean default false,
  p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.qualification_approval_groups
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype; v_group public.qualification_approval_groups%rowtype; v_item_id uuid; v_position integer := 0; v_stable_key text;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null or not public.can_manage_org(v_project.organisation_id) then raise exception 'project management access required'; end if;
  if coalesce(cardinality(p_item_ids), 0) = 0 then raise exception 'choose at least one qualification item'; end if;
  if exists(select 1 from unnest(p_item_ids) item_id left join public.project_qualification_items q on q.id = item_id where q.id is null or q.project_id <> p_project) then raise exception 'qualification item does not belong to project'; end if;
  select * into v_request from public.create_client_response_request(p_project, null, p_title, p_client_note, 'approval', p_due_on, p_requires_signed_artifact, p_requires_signed_artifact, p_title, null, p_artifact_ids);
  insert into public.qualification_approval_groups(project_id, request_id, created_by) values(p_project, v_request.id, auth.uid()) returning * into v_group;
  foreach v_item_id in array p_item_ids loop
    select stable_key into v_stable_key from public.project_qualification_items where id = v_item_id;
    insert into public.qualification_approval_group_items(group_id, qualification_item_id, stable_key, position) values(v_group.id, v_item_id, v_stable_key, v_position);
    v_position := v_position + 1;
  end loop;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(v_project.organisation_id, p_project, auth.uid(), 'qualification.approval_group_requested', 'qualification_approval_group', v_group.id, jsonb_build_object('title', p_title, 'item_count', cardinality(p_item_ids)));
  return v_group;
end $$;

revoke all on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]) from public;
grant execute on function public.request_qualification_approval_group(uuid, text, text, uuid[], date, boolean, uuid[]) to authenticated;
