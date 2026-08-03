-- A client submits a response; Laminar reviews and completes/cancels the request.
-- This prevents a client-facing button from silently completing internal work.

alter table public.client_response_requests
  add column if not exists responded_by uuid references auth.users(id),
  add column if not exists responded_at timestamptz,
  add column if not exists response_signing_name text,
  add column if not exists parent_request_id uuid references public.client_response_requests(id) on delete set null;

alter table public.client_response_requests drop constraint if exists client_response_requests_status_check;
update public.client_response_requests set status = case status when 'open' then 'requested' when 'approved' then 'responded' when 'closed' then 'completed' else status end;
alter table public.client_response_requests alter column status set default 'requested';
alter table public.client_response_requests add constraint client_response_requests_status_check check (status in ('requested', 'responded', 'completed', 'cancelled'));

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
  update public.client_response_requests set status = 'responded', responded_by = auth.uid(), responded_at = now(), response_signing_name = nullif(trim(p_signing_name), ''), completed_by = auth.uid(), completed_at = now() where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), 'client_request.responded', 'client_response_request', p_request, jsonb_build_object('title', v_request.title, 'signing_name', v_request.response_signing_name) from public.projects where id = v_request.project_id;
  insert into public.user_notifications(recipient_user_id, project_id, request_id, kind, title, body) select m.user_id, v_request.project_id, p_request, 'client_response_completed', 'Client response ready for review: ' || v_request.title, 'Review the response and complete or cancel the request.' from public.project_members m where m.project_id = v_request.project_id and m.role in ('organisation_owner', 'delivery_manager', 'contributor');
  return v_request;
end $$;

create or replace function public.complete_client_response_request(p_request uuid)
returns public.client_response_requests language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or v_request.status <> 'responded' or not exists(select 1 from public.projects where id = v_request.project_id and public.can_manage_org(organisation_id)) then raise exception 'Laminar review access required'; end if;
  update public.client_response_requests set status = 'completed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), 'client_request.completed', 'client_response_request', p_request, jsonb_build_object('title', v_request.title) from public.projects where id = v_request.project_id;
  return v_request;
end $$;

create or replace function public.cancel_client_response_request(p_request uuid)
returns public.client_response_requests language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or v_request.status = 'completed' or not exists(select 1 from public.projects where id = v_request.project_id and public.can_manage_org(organisation_id)) then raise exception 'Laminar review access required'; end if;
  update public.client_response_requests set status = 'cancelled', closed_by = auth.uid(), closed_at = now() where id = p_request or parent_request_id = p_request;
  select * into v_request from public.client_response_requests where id = p_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), 'client_request.cancelled', 'client_response_request', p_request, jsonb_build_object('title', v_request.title) from public.projects where id = v_request.project_id;
  return v_request;
end $$;

create or replace function public.add_client_response_message(p_request uuid, p_body text)
returns public.client_response_messages language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_message public.client_response_messages%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request;
  if v_request.id is null or v_request.status not in ('requested', 'responded') or not (public.is_internal_project_user(v_request.project_id) or public.is_client_project_user(v_request.project_id)) then raise exception 'request is not available'; end if;
  insert into public.client_response_messages(request_id, body, created_by) values(p_request, trim(p_body), auth.uid()) returning * into v_message;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload) select organisation_id, v_request.project_id, auth.uid(), 'client_request.message_added', 'client_response_request', p_request, jsonb_build_object('message_id', v_message.id) from public.projects where id = v_request.project_id;
  return v_message;
end $$;

revoke all on function public.submit_client_response_request(uuid, text, text), public.complete_client_response_request(uuid), public.cancel_client_response_request(uuid), public.add_client_response_message(uuid, text) from public;
grant execute on function public.submit_client_response_request(uuid, text, text), public.complete_client_response_request(uuid), public.cancel_client_response_request(uuid), public.add_client_response_message(uuid, text) to authenticated;
