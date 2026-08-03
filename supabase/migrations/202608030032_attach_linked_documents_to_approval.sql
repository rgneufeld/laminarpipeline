-- Laminar can attach only already-approved, client-safe documents to an approval.
-- Documents are linked to the relevant qualification first, preserving their audit trail.

create or replace function public.attach_linked_qualification_documents_to_request(p_request uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_count integer;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or not exists(select 1 from public.projects p where p.id = v_request.project_id and public.can_manage_org(p.organisation_id)) then raise exception 'Laminar project management access required'; end if;
  insert into public.client_response_artifacts(request_id, artifact_id, attached_by)
  select v_request.id, qia.artifact_id, auth.uid()
  from public.qualification_item_artifacts qia
  join public.artifacts a on a.id = qia.artifact_id
  where a.project_id = v_request.project_id
    and a.status = 'available'
    and a.visibility = 'client'
    and a.approved_at is not null
    and (
      qia.qualification_item_id = v_request.qualification_item_id
      or exists(
        select 1 from public.qualification_approval_groups g
        join public.qualification_approval_group_items gi on gi.group_id = g.id
        where g.request_id = v_request.id and gi.qualification_item_id = qia.qualification_item_id
      )
    )
  on conflict do nothing;
  get diagnostics v_count = row_count;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_request.project_id, auth.uid(), 'client_request.documents_attached', 'client_response_request', v_request.id, jsonb_build_object('count', v_count)
  from public.projects where id = v_request.project_id;
  return v_count;
end $$;

revoke all on function public.attach_linked_qualification_documents_to_request(uuid) from public;
grant execute on function public.attach_linked_qualification_documents_to_request(uuid) to authenticated;
