-- In-app alerts for client response/approval requests. Email delivery can later
-- consume these durable records from a privileged Edge Function.

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  request_id uuid references public.client_response_requests(id) on delete cascade,
  kind text not null check (kind in ('client_response_required', 'client_approval_required', 'client_response_completed', 'client_approval_completed')),
  title text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index user_notifications_recipient_idx on public.user_notifications(recipient_user_id, read_at, created_at desc);

alter table public.user_notifications enable row level security;
create policy notification_read on public.user_notifications for select to authenticated using (recipient_user_id = auth.uid());

drop function public.create_client_response_request(uuid, uuid, text, text, text, date, boolean, boolean, text, text);
create function public.create_client_response_request(
  p_project uuid,
  p_task uuid default null,
  p_title text default '',
  p_instructions text default '',
  p_request_type text default 'information',
  p_due_on date default null,
  p_requires_artifact boolean default false,
  p_requires_signed_artifact boolean default false,
  p_approval_subject text default null,
  p_approval_version text default null,
  p_artifact_ids uuid[] default '{}'::uuid[]
) returns public.client_response_requests
language plpgsql security definer set search_path = public as $$
declare v_project public.projects%rowtype; v_request public.client_response_requests%rowtype; v_artifact_id uuid; v_artifact public.artifacts%rowtype;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null or not public.can_manage_org(v_project.organisation_id) then raise exception 'project management access required'; end if;
  if p_task is not null and not exists(select 1 from public.project_tasks where id = p_task and project_id = p_project) then raise exception 'task does not belong to project'; end if;
  if p_request_type not in ('information', 'materials', 'review', 'approval') then raise exception 'invalid client request type'; end if;
  if p_request_type = 'approval' and nullif(trim(coalesce(p_approval_subject, '')), '') is null then raise exception 'approval subject is required'; end if;
  insert into public.client_response_requests(project_id, task_id, title, instructions, request_type, due_on, requires_artifact, requires_signed_artifact, approval_subject, approval_version, created_by)
  values(p_project, p_task, trim(p_title), coalesce(p_instructions, ''), p_request_type, p_due_on, coalesce(p_requires_artifact, false), coalesce(p_requires_signed_artifact, false), nullif(trim(p_approval_subject), ''), nullif(trim(p_approval_version), ''), auth.uid())
  returning * into v_request;
  foreach v_artifact_id in array coalesce(p_artifact_ids, '{}'::uuid[]) loop
    select * into v_artifact from public.artifacts where id = v_artifact_id;
    if v_artifact.id is null or v_artifact.project_id <> p_project or v_artifact.visibility not in ('client', 'client_upload') or v_artifact.status <> 'available' or (v_artifact.visibility = 'client' and v_artifact.approved_at is null) then
      raise exception 'only approved client-visible documents can be attached to a client request';
    end if;
    insert into public.client_response_artifacts(request_id, artifact_id, attached_by) values(v_request.id, v_artifact_id, auth.uid()) on conflict do nothing;
  end loop;
  insert into public.audit_events(organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
  values(v_project.organisation_id, p_project, auth.uid(), 'client_request.opened', 'client_response_request', v_request.id, jsonb_build_object('title', v_request.title, 'type', v_request.request_type, 'task_id', p_task, 'approval_subject', v_request.approval_subject, 'approval_version', v_request.approval_version));
  insert into public.user_notifications(recipient_user_id, project_id, request_id, kind, title, body)
  select m.user_id, p_project, v_request.id,
    case when v_request.request_type = 'approval' then 'client_approval_required' else 'client_response_required' end,
    case when v_request.request_type = 'approval' then 'Approval requested: ' else 'Client response required: ' end || v_request.title,
    v_request.instructions
  from public.project_members m
  where m.project_id = p_project and m.role in ('client_admin', 'client_collaborator');
  return v_request;
end $$;

create or replace function public.mark_notification_read(p_notification uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.user_notifications set read_at = coalesce(read_at, now()) where id = p_notification and recipient_user_id = auth.uid();
  if not found then raise exception 'notification not available'; end if;
end $$;

revoke all on function public.create_client_response_request(uuid, uuid, text, text, text, date, boolean, boolean, text, text, uuid[]), public.mark_notification_read(uuid) from public;
grant execute on function public.create_client_response_request(uuid, uuid, text, text, text, date, boolean, boolean, text, text, uuid[]), public.mark_notification_read(uuid) to authenticated;
grant select on public.user_notifications to authenticated;
