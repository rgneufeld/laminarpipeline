-- Client responses are a separate, auditable collaboration loop. They never
-- let a client rewrite Laminar's internal delivery stage or mark work N/A.

create table public.client_response_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid references public.project_tasks(id) on delete set null,
  title text not null check (char_length(trim(title)) > 0),
  instructions text not null default '',
  request_type text not null default 'information' check (request_type in ('information', 'materials', 'review', 'approval')),
  status text not null default 'open' check (status in ('open', 'responded', 'approved', 'closed', 'cancelled')),
  due_on date,
  requires_artifact boolean not null default false,
  requires_signed_artifact boolean not null default false,
  approval_subject text,
  approval_version text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  check (not requires_signed_artifact or requires_artifact),
  check (request_type <> 'approval' or approval_subject is not null)
);
create index client_response_requests_project_idx on public.client_response_requests(project_id, status, due_on);

create table public.client_response_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.client_response_requests(id) on delete cascade,
  body text not null check (char_length(trim(body)) > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index client_response_messages_request_idx on public.client_response_messages(request_id, created_at);

create table public.client_response_artifacts (
  request_id uuid not null references public.client_response_requests(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete restrict,
  attached_by uuid not null references auth.users(id),
  attached_at timestamptz not null default now(),
  primary key(request_id, artifact_id)
);

alter table public.client_response_requests enable row level security;
alter table public.client_response_messages enable row level security;
alter table public.client_response_artifacts enable row level security;

create policy client_request_read on public.client_response_requests for select to authenticated using (
  public.is_internal_project_user(project_id) or public.is_client_project_user(project_id)
);
create policy client_request_message_read on public.client_response_messages for select to authenticated using (
  exists(select 1 from public.client_response_requests r where r.id = request_id and (public.is_internal_project_user(r.project_id) or public.is_client_project_user(r.project_id)))
);
create policy client_request_artifact_read on public.client_response_artifacts for select to authenticated using (
  exists(select 1 from public.client_response_requests r where r.id = request_id and (public.is_internal_project_user(r.project_id) or public.is_client_project_user(r.project_id)))
);

create or replace function public.create_client_response_request(
  p_project uuid,
  p_task uuid default null,
  p_title text default '',
  p_instructions text default '',
  p_request_type text default 'information',
  p_due_on date default null,
  p_requires_artifact boolean default false,
  p_requires_signed_artifact boolean default false,
  p_approval_subject text default null,
  p_approval_version text default null
) returns public.client_response_requests
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null or not public.can_manage_org(v_project.organisation_id) then raise exception 'project management access required'; end if;
  if p_task is not null and not exists(select 1 from public.project_tasks where id = p_task and project_id = p_project) then raise exception 'task does not belong to project'; end if;
  if p_request_type not in ('information', 'materials', 'review', 'approval') then raise exception 'invalid client request type'; end if;
  if p_request_type = 'approval' and nullif(trim(coalesce(p_approval_subject, '')), '') is null then raise exception 'approval subject is required'; end if;
  insert into public.client_response_requests(project_id, task_id, title, instructions, request_type, due_on, requires_artifact, requires_signed_artifact, approval_subject, approval_version, created_by)
  values(p_project, p_task, trim(p_title), coalesce(p_instructions, ''), p_request_type, p_due_on, coalesce(p_requires_artifact, false), coalesce(p_requires_signed_artifact, false), nullif(trim(p_approval_subject), ''), nullif(trim(p_approval_version), ''), auth.uid())
  returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(v_project.organisation_id, p_project, auth.uid(), 'client_request.opened', 'client_response_request', v_request.id, jsonb_build_object('title', v_request.title, 'type', v_request.request_type, 'task_id', p_task));
  return v_request;
end $$;

create or replace function public.add_client_response_message(p_request uuid, p_body text)
returns public.client_response_messages
language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_message public.client_response_messages%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request;
  if v_request.id is null or v_request.status not in ('open', 'responded') or not (public.is_internal_project_user(v_request.project_id) or public.is_client_project_user(v_request.project_id)) then raise exception 'request is not available'; end if;
  insert into public.client_response_messages(request_id, body, created_by) values(p_request, trim(p_body), auth.uid()) returning * into v_message;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_request.project_id, auth.uid(), 'client_request.message_added', 'client_response_request', p_request, jsonb_build_object('message_id', v_message.id) from public.projects where id = v_request.project_id;
  return v_message;
end $$;

create or replace function public.attach_client_response_artifact(p_request uuid, p_artifact uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype; v_artifact public.artifacts%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request;
  select * into v_artifact from public.artifacts where id = p_artifact;
  if v_request.id is null or v_artifact.id is null or v_artifact.project_id <> v_request.project_id or not (public.is_internal_project_user(v_request.project_id) or public.is_client_project_user(v_request.project_id)) then raise exception 'request artifact is not available'; end if;
  if public.is_client_project_user(v_request.project_id) and v_artifact.visibility <> 'client_upload' then raise exception 'clients can attach only client-provided documents'; end if;
  insert into public.client_response_artifacts(request_id, artifact_id, attached_by) values(p_request, p_artifact, auth.uid()) on conflict do nothing;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_request.project_id, auth.uid(), 'client_request.document_attached', 'client_response_request', p_request, jsonb_build_object('artifact_id', p_artifact) from public.projects where id = v_request.project_id;
end $$;

create or replace function public.complete_client_response_request(p_request uuid, p_approval boolean default false)
returns public.client_response_requests
language plpgsql security definer set search_path = public as $$
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
  end if;
  update public.client_response_requests set status = case when p_approval then 'approved' else 'responded' end, completed_by = auth.uid(), completed_at = now() where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_request.project_id, auth.uid(), case when p_approval then 'client_request.approved' else 'client_request.response_completed' end, 'client_response_request', p_request, jsonb_build_object('title', v_request.title, 'approval_subject', v_request.approval_subject, 'approval_version', v_request.approval_version) from public.projects where id = v_request.project_id;
  return v_request;
end $$;

create or replace function public.close_client_response_request(p_request uuid)
returns public.client_response_requests
language plpgsql security definer set search_path = public as $$
declare v_request public.client_response_requests%rowtype;
begin
  select * into v_request from public.client_response_requests where id = p_request for update;
  if v_request.id is null or not exists(select 1 from public.projects where id = v_request.project_id and public.can_manage_org(organisation_id)) then raise exception 'project management access required'; end if;
  update public.client_response_requests set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into v_request;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  select organisation_id, v_request.project_id, auth.uid(), 'client_request.closed', 'client_response_request', p_request, jsonb_build_object('title', v_request.title) from public.projects where id = v_request.project_id;
  return v_request;
end $$;

create or replace function public.transition_project_task(p_task uuid, p_to public.task_stage, p_blocked_reason text default null, p_client_note text default null)
returns public.project_tasks language plpgsql security definer set search_path = public as $$
declare v_task public.project_tasks; v_from public.task_stage; v_ok boolean := false;
begin
  select * into v_task from public.project_tasks where id=p_task for update;
  if not found or not public.can_write_project(v_task.project_id) then raise exception 'not authorised'; end if;
  if not public.is_internal_project_user(v_task.project_id) then raise exception 'clients cannot change Laminar delivery stages'; end if;
  v_from := v_task.stage;
  v_ok := (v_task.stage='pending' and p_to in ('in_scope','na')) or (v_task.stage='in_scope' and p_to in ('pending','active','na','blocked')) or (v_task.stage='na' and p_to='in_scope') or (v_task.stage='active' and p_to in ('client_review','complete','blocked','in_scope','na')) or (v_task.stage='blocked' and (p_to='na' or p_to::text=coalesce(v_task.metadata->>'blocked_from',''))) or (v_task.stage='client_review' and p_to in ('complete','active','blocked')) or (v_task.stage='complete' and p_to in ('delivered','active','blocked')) or (v_task.stage='delivered' and p_to='complete');
  if not v_ok or (p_to='blocked' and nullif(trim(coalesce(p_blocked_reason,'')),'') is null) then raise exception 'invalid task transition'; end if;
  if p_to='delivered' and not exists(select 1 from public.task_transition_events where task_id=p_task and to_stage='complete') then raise exception 'task must first be complete'; end if;
  perform set_config('app.allow_task_transition', 'true', true);
  update public.project_tasks set stage=p_to, blocked_reason=case when p_to='blocked' then p_blocked_reason else null end, entered_stage_at=now(), completed_at=case when p_to='complete' then now() else completed_at end, delivered_at=case when p_to='delivered' then now() else delivered_at end, metadata=case when p_to='blocked' then jsonb_set(metadata,'{blocked_from}',to_jsonb(v_from::text)) else metadata - 'blocked_from' end where id=p_task returning * into v_task;
  insert into public.task_transition_events(project_id,task_id,from_stage,to_stage,blocked_reason,actor_id,client_note) values(v_task.project_id,p_task,v_from,p_to,p_blocked_reason,auth.uid(),p_client_note);
  insert into public.audit_events(organisation_id,project_id,actor_id,event_type,entity_type,entity_id,payload) select organisation_id,v_task.project_id,auth.uid(),'task.transition','project_task',p_task,jsonb_build_object('from',v_from,'to',p_to) from public.projects where id=v_task.project_id;
  return v_task;
end $$;

revoke all on function public.create_client_response_request(uuid, uuid, text, text, text, date, boolean, boolean, text, text), public.add_client_response_message(uuid, text), public.attach_client_response_artifact(uuid, uuid), public.complete_client_response_request(uuid, boolean), public.close_client_response_request(uuid) from public;
grant execute on function public.create_client_response_request(uuid, uuid, text, text, text, date, boolean, boolean, text, text), public.add_client_response_message(uuid, text), public.attach_client_response_artifact(uuid, uuid), public.complete_client_response_request(uuid, boolean), public.close_client_response_request(uuid) to authenticated;
grant select on public.client_response_requests, public.client_response_messages, public.client_response_artifacts to authenticated;
