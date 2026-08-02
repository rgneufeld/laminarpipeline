-- Laminar Pipeline Phase 1 schema proposal. Review before applying to any Supabase project.
-- All browser access is authenticated and RLS-enforced. Never place a service-role key in Vite.

create extension if not exists pgcrypto;

create type public.app_role as enum ('platform_admin','organisation_owner','delivery_manager','contributor','client_admin','client_collaborator','viewer');
create type public.task_stage as enum ('pending','in_scope','na','active','blocked','client_review','complete','delivered');
create type public.artifact_visibility as enum ('internal','client','client_upload','restricted');
create type public.artifact_status as enum ('pending_scan','available','rejected','superseded');
create type public.note_visibility as enum ('internal','client');
create type public.artifact_origin as enum ('internal_upload','client_upload','system_export','legacy_import','external_evidence');
create type public.acknowledgement_kind as enum ('viewed','acknowledged','signed_off');

create table public.organisations (
  id uuid primary key default gen_random_uuid(), slug text not null unique check (slug ~ '^[a-z0-9-]{3,80}$'), name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organisation_memberships (
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null, created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
create index organisation_memberships_user_idx on public.organisation_memberships(user_id, organisation_id);
-- This table is provisioned only through controlled administration/migrations; it is never client-managed.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.playbooks (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, description text,
  created_at timestamptz not null default now()
);
create table public.playbook_versions (
  id uuid primary key default gen_random_uuid(), playbook_id uuid not null references public.playbooks(id), version_number integer not null check (version_number > 0),
  status text not null check (status in ('draft','published','retired')), definition jsonb not null default '{}'::jsonb,
  published_at timestamptz, created_at timestamptz not null default now(), unique(playbook_id, version_number)
);
create table public.playbook_phases (
  id uuid primary key default gen_random_uuid(), playbook_version_id uuid not null references public.playbook_versions(id) on delete cascade,
  stable_key text not null, position integer not null, label text not null, title text not null, objective text, color text,
  unique(playbook_version_id, stable_key), unique(playbook_version_id, position)
);
create table public.playbook_task_templates (
  id uuid primary key default gen_random_uuid(), phase_id uuid not null references public.playbook_phases(id) on delete cascade,
  stable_key text not null, position integer not null, title text not null, guidance text, client_action boolean not null default false,
  required_evidence jsonb not null default '[]'::jsonb, validation_rules jsonb not null default '{}'::jsonb,
  unique(phase_id, stable_key), unique(phase_id, position)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(), organisation_id uuid not null references public.organisations(id),
  playbook_version_id uuid not null references public.playbook_versions(id), name text not null, client_name text,
  status text not null default 'qualified', created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), archived_at timestamptz
);
create index projects_org_idx on public.projects(organisation_id, updated_at desc);
create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null, created_at timestamptz not null default now(), primary key(project_id, user_id)
);
create index project_members_user_idx on public.project_members(user_id, project_id);
create table public.project_tasks (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
  phase_id uuid not null references public.playbook_phases(id), task_template_id uuid references public.playbook_task_templates(id),
  stable_key text not null, title text not null, stage public.task_stage not null default 'pending', owner_id uuid references auth.users(id),
  due_on date, priority smallint not null default 3 check(priority between 1 and 5), sort_rank numeric not null default 0,
  blocked_reason text, entered_stage_at timestamptz not null default now(), completed_at timestamptz, delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb, unique(project_id, stable_key)
);
create index project_tasks_board_idx on public.project_tasks(project_id, phase_id, stage, sort_rank);
create table public.task_transition_events (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.project_tasks(id) on delete cascade, from_stage public.task_stage not null, to_stage public.task_stage not null,
  blocked_reason text, actor_id uuid not null references auth.users(id), occurred_at timestamptz not null default now(), client_note text
);
create index task_transition_events_task_idx on public.task_transition_events(task_id, occurred_at desc);
create table public.task_notes (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.project_tasks(id) on delete cascade, visibility public.note_visibility not null,
  body text not null, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(), organisation_id uuid not null references public.organisations(id), project_id uuid not null references public.projects(id) on delete cascade,
  visibility public.artifact_visibility not null, origin public.artifact_origin not null default 'internal_upload', source_artifact_id uuid references public.artifacts(id), status public.artifact_status not null default 'pending_scan', title text not null,
  approved_at timestamptz, approved_by uuid references auth.users(id), created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create index artifacts_project_idx on public.artifacts(project_id, visibility, status);
create table public.artifact_versions (
  id uuid primary key default gen_random_uuid(), artifact_id uuid not null references public.artifacts(id) on delete restrict,
  version_number integer not null check(version_number > 0), storage_path text not null unique, file_name text not null, mime_type text,
  byte_size bigint, sha256 text, superseded_at timestamptz, uploaded_by uuid not null references auth.users(id), uploaded_at timestamptz not null default now(),
  unique(artifact_id, version_number)
);
create table public.evidence_records (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.project_tasks(id) on delete cascade, artifact_version_id uuid not null references public.artifact_versions(id),
  tested_url text, provider text, result_summary text not null, collected_at timestamptz not null, uploader_id uuid not null references auth.users(id),
  reviewer_id uuid references auth.users(id), reviewed_at timestamptz, created_at timestamptz not null default now()
);
-- Publication never exposes an internal source by accident. It identifies the exact immutable
-- version delivered to a client; that version may be a separate redacted client artifact.
create table public.artifact_publications (
  id uuid primary key default gen_random_uuid(), organisation_id uuid not null references public.organisations(id), project_id uuid not null references public.projects(id) on delete cascade,
  source_artifact_version_id uuid not null references public.artifact_versions(id) on delete restrict,
  published_artifact_version_id uuid not null references public.artifact_versions(id) on delete restrict,
  published_by uuid not null references auth.users(id), approved_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(), recalled_at timestamptz, recall_reason text,
  message_to_client text, unique(project_id, published_artifact_version_id)
);
create table public.artifact_acknowledgements (
  id uuid primary key default gen_random_uuid(), publication_id uuid not null references public.artifact_publications(id) on delete cascade,
  acknowledged_by uuid not null references auth.users(id), kind public.acknowledgement_kind not null,
  note text, occurred_at timestamptz not null default now(), unique(publication_id, acknowledged_by, kind)
);
create table public.artifact_access_grants (
  id uuid primary key default gen_random_uuid(), artifact_id uuid not null references public.artifacts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade, role public.app_role,
  can_view boolean not null default true, can_upload_version boolean not null default false, can_comment boolean not null default false,
  can_approve boolean not null default false, can_manage boolean not null default false,
  granted_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
  check ((user_id is null) <> (role is null))
);
create unique index artifact_access_grants_user_idx on public.artifact_access_grants(artifact_id, user_id) where user_id is not null;
create unique index artifact_access_grants_role_idx on public.artifact_access_grants(artifact_id, role) where role is not null;
create table public.deliverables (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, title text not null, status text not null default 'pending', client_visible boolean not null default false, approval_requested_at timestamptz, approved_at timestamptz, approved_by uuid references auth.users(id));
create table public.project_qualification_items (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, stable_key text not null, complete boolean not null default false, completed_at timestamptz, completed_by uuid references auth.users(id), unique(project_id, stable_key));
create table public.training_records (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, stable_key text not null, status text not null default 'pending', signed_off_at timestamptz, signed_off_by uuid references auth.users(id), unique(project_id, stable_key));
create table public.operating_cycles (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, period date not null, status text not null default 'draft', locked_at timestamptz, unique(project_id, period));
create table public.cycle_work_items (id uuid primary key default gen_random_uuid(), cycle_id uuid not null references public.operating_cycles(id) on delete cascade, title text not null, status text not null default 'planned', owner_id uuid references auth.users(id), estimated_hours numeric(6,2));
create table public.cycle_time_entries (id uuid primary key default gen_random_uuid(), cycle_id uuid not null references public.operating_cycles(id) on delete cascade, work_item_id uuid references public.cycle_work_items(id), occurred_on date not null, hours numeric(6,2) not null check(hours > 0), category text not null, note text, entered_by uuid not null references auth.users(id));
create table public.audit_events (id uuid primary key default gen_random_uuid(), organisation_id uuid not null references public.organisations(id), project_id uuid references public.projects(id) on delete cascade, actor_id uuid references auth.users(id), event_type text not null, entity_type text not null, entity_id uuid, payload jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default now());
create index audit_events_project_idx on public.audit_events(project_id, occurred_at desc);

-- Prevent a direct browser update from bypassing transition validation/audit logging.
create function public.reject_direct_task_stage_update() returns trigger language plpgsql as $$
begin
  if new.stage is distinct from old.stage and current_setting('app.allow_task_transition', true) is distinct from 'true' then
    raise exception 'task stage must be changed with transition_project_task';
  end if;
  return new;
end $$;
create trigger project_tasks_stage_guard before update on public.project_tasks for each row execute function public.reject_direct_task_stage_update();

-- Authorization helpers are SECURITY DEFINER so policies avoid recursive membership evaluation.
create function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.platform_admins where user_id=(select auth.uid())) $$;
create function public.current_org_role(p_org uuid) returns public.app_role language sql stable security definer set search_path = public as $$ select role from public.organisation_memberships where organisation_id = p_org and user_id = (select auth.uid()) $$;
create function public.can_manage_org(p_org uuid) returns boolean language sql stable security definer set search_path = public as $$ select public.is_platform_admin() or coalesce((select public.current_org_role(p_org) in ('organisation_owner','delivery_manager')), false) $$;
create function public.can_access_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.projects p where p.id=p_project and (public.can_manage_org(p.organisation_id) or exists (select 1 from public.project_members m where m.project_id=p.id and m.user_id=(select auth.uid())))) $$;
create function public.can_write_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.projects p where p.id=p_project and (public.can_manage_org(p.organisation_id) or exists (select 1 from public.project_members m where m.project_id=p.id and m.user_id=(select auth.uid()) and m.role in ('contributor','client_admin','client_collaborator')))) $$;
create function public.is_internal_project_user(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.projects p where p.id=p_project and (public.can_manage_org(p.organisation_id) or exists (select 1 from public.project_members m where m.project_id=p.id and m.user_id=(select auth.uid()) and m.role in ('contributor','viewer')))) $$;
create function public.can_access_restricted_artifact(p_artifact uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.artifacts a
    where a.id=p_artifact and (
      public.is_platform_admin() or
      exists(select 1 from public.organisation_memberships m where m.organisation_id=a.organisation_id and m.user_id=(select auth.uid()) and m.role='organisation_owner') or
      exists(select 1 from public.artifact_access_grants g where g.artifact_id=a.id and g.can_view and (g.user_id=(select auth.uid()) or g.role=(select m.role from public.project_members m where m.project_id=a.project_id and m.user_id=(select auth.uid())) or g.role=(select m.role from public.organisation_memberships m where m.organisation_id=a.organisation_id and m.user_id=(select auth.uid()))))
    )
  ) $$;

-- Transition is the only intended task stage write path; clients receive the same server validation.
create function public.transition_project_task(p_task uuid, p_to public.task_stage, p_blocked_reason text default null, p_client_note text default null) returns public.project_tasks language plpgsql security definer set search_path = public as $$
declare v_task public.project_tasks; v_from public.task_stage; v_ok boolean := false;
begin
  select * into v_task from public.project_tasks where id=p_task for update;
  if not found or not public.can_write_project(v_task.project_id) then raise exception 'not authorised'; end if;
  v_from := v_task.stage;
  v_ok := (v_task.stage='pending' and p_to in ('in_scope','na')) or (v_task.stage='in_scope' and p_to in ('active','na','blocked')) or (v_task.stage='na' and p_to='in_scope') or (v_task.stage='active' and p_to in ('client_review','complete','blocked','in_scope','na')) or (v_task.stage='blocked' and (p_to='na' or p_to::text=coalesce(v_task.metadata->>'blocked_from',''))) or (v_task.stage='client_review' and p_to in ('complete','active','blocked')) or (v_task.stage='complete' and p_to in ('delivered','active','blocked')) or (v_task.stage='delivered' and p_to='complete');
  if not v_ok or (p_to='blocked' and nullif(trim(coalesce(p_blocked_reason,'')),'') is null) then raise exception 'invalid task transition'; end if;
  if p_to='delivered' and not exists(select 1 from public.task_transition_events where task_id=p_task and to_stage='complete') then raise exception 'task must first be complete'; end if;
  perform set_config('app.allow_task_transition', 'true', true);
  update public.project_tasks set stage=p_to, blocked_reason=case when p_to='blocked' then p_blocked_reason else null end, entered_stage_at=now(), completed_at=case when p_to='complete' then now() else completed_at end, delivered_at=case when p_to='delivered' then now() else delivered_at end, metadata=case when p_to='blocked' then jsonb_set(metadata,'{blocked_from}',to_jsonb(v_from::text)) else metadata - 'blocked_from' end where id=p_task returning * into v_task;
  insert into public.task_transition_events(project_id,task_id,from_stage,to_stage,blocked_reason,actor_id,client_note) values(v_task.project_id,p_task,v_from,p_to,p_blocked_reason,(select auth.uid()),p_client_note);
  insert into public.audit_events(organisation_id,project_id,actor_id,event_type,entity_type,entity_id,payload) select organisation_id,v_task.project_id,(select auth.uid()),'task.transition','project_task',p_task,jsonb_build_object('from',v_from,'to',p_to) from public.projects where id=v_task.project_id;
  return v_task;
end $$;

alter table public.organisations enable row level security; alter table public.organisation_memberships enable row level security; alter table public.platform_admins enable row level security; alter table public.projects enable row level security; alter table public.project_members enable row level security;
alter table public.project_tasks enable row level security; alter table public.task_transition_events enable row level security; alter table public.task_notes enable row level security; alter table public.artifacts enable row level security; alter table public.artifact_versions enable row level security; alter table public.evidence_records enable row level security; alter table public.artifact_publications enable row level security; alter table public.artifact_acknowledgements enable row level security; alter table public.artifact_access_grants enable row level security; alter table public.deliverables enable row level security; alter table public.project_qualification_items enable row level security; alter table public.training_records enable row level security; alter table public.operating_cycles enable row level security; alter table public.cycle_work_items enable row level security; alter table public.cycle_time_entries enable row level security; alter table public.audit_events enable row level security;
alter table public.playbooks enable row level security; alter table public.playbook_versions enable row level security; alter table public.playbook_phases enable row level security; alter table public.playbook_task_templates enable row level security;

create policy org_read on public.organisations for select to authenticated using (public.is_platform_admin() or public.current_org_role(id) is not null);
create policy membership_read on public.organisation_memberships for select to authenticated using (user_id=(select auth.uid()) or public.can_manage_org(organisation_id));
create policy project_read on public.projects for select to authenticated using (public.can_access_project(id));
create policy project_manage on public.projects for all to authenticated using (public.can_manage_org(organisation_id)) with check (public.can_manage_org(organisation_id));
create policy project_member_read on public.project_members for select to authenticated using (public.can_access_project(project_id));
create policy project_member_manage on public.project_members for all to authenticated using (exists(select 1 from public.projects p where p.id=project_id and public.can_manage_org(p.organisation_id))) with check (exists(select 1 from public.projects p where p.id=project_id and public.can_manage_org(p.organisation_id)));
create policy task_read on public.project_tasks for select to authenticated using (public.can_access_project(project_id));
create policy task_insert on public.project_tasks for insert to authenticated with check (public.can_manage_org((select organisation_id from public.projects where id=project_id)));
create policy task_update_nonstage on public.project_tasks for update to authenticated using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy transition_read on public.task_transition_events for select to authenticated using (public.can_access_project(project_id));
create policy note_read on public.task_notes for select to authenticated using (public.can_access_project(project_id) and (visibility='client' or public.is_internal_project_user(project_id)));
create policy note_write on public.task_notes for all to authenticated using (public.can_write_project(project_id) and (visibility='client' or public.is_internal_project_user(project_id))) with check (public.can_write_project(project_id) and (visibility='client' or public.is_internal_project_user(project_id)));
create policy artifact_read on public.artifacts for select to authenticated using (public.can_access_project(project_id) and (visibility='restricted' and public.can_access_restricted_artifact(id) or visibility='internal' and public.is_internal_project_user(project_id) or visibility in ('client','client_upload') and status='available' and (approved_at is not null or visibility='client_upload')));
create policy artifact_write on public.artifacts for all to authenticated using (public.can_write_project(project_id) and (visibility not in ('internal','restricted') or public.is_internal_project_user(project_id))) with check (public.can_write_project(project_id) and (visibility not in ('internal','restricted') or public.is_internal_project_user(project_id)));
create policy artifact_version_read on public.artifact_versions for select to authenticated using (exists(select 1 from public.artifacts a where a.id=artifact_id));
create policy evidence_read on public.evidence_records for select to authenticated using (public.can_access_project(project_id));
create policy evidence_insert on public.evidence_records for insert to authenticated with check (public.can_write_project(project_id));
create policy publication_read on public.artifact_publications for select to authenticated using (public.is_internal_project_user(project_id) or (recalled_at is null and exists(select 1 from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.id=published_artifact_version_id)));
create policy publication_write on public.artifact_publications for all to authenticated using (public.can_manage_org(organisation_id)) with check (public.can_manage_org(organisation_id));
create policy acknowledgement_read on public.artifact_acknowledgements for select to authenticated using (exists(select 1 from public.artifact_publications p where p.id=publication_id and public.can_access_project(p.project_id)));
create policy acknowledgement_insert on public.artifact_acknowledgements for insert to authenticated with check (acknowledged_by=(select auth.uid()) and exists(select 1 from public.artifact_publications p where p.id=publication_id and p.recalled_at is null and exists(select 1 from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.id=p.published_artifact_version_id)));
create policy artifact_grant_read on public.artifact_access_grants for select to authenticated using (exists(select 1 from public.artifacts a where a.id=artifact_id and (public.can_access_restricted_artifact(a.id) or public.can_manage_org(a.organisation_id))));
create policy artifact_grant_write on public.artifact_access_grants for all to authenticated using (exists(select 1 from public.artifacts a where a.id=artifact_id and public.can_manage_org(a.organisation_id))) with check (exists(select 1 from public.artifacts a where a.id=artifact_id and public.can_manage_org(a.organisation_id)));
create policy project_data_read on public.deliverables for select to authenticated using (public.can_access_project(project_id));
create policy deliverable_write on public.deliverables for all to authenticated using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy qualification_read on public.project_qualification_items for select to authenticated using (public.is_internal_project_user(project_id));
create policy qualification_write on public.project_qualification_items for all to authenticated using (public.is_internal_project_user(project_id)) with check (public.is_internal_project_user(project_id));
create policy training_read on public.training_records for select to authenticated using (public.can_access_project(project_id));
create policy training_write on public.training_records for all to authenticated using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy cycle_read on public.operating_cycles for select to authenticated using (public.can_access_project(project_id));
create policy cycle_write on public.operating_cycles for all to authenticated using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy cycle_work_read on public.cycle_work_items for select to authenticated using (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_access_project(c.project_id)));
create policy cycle_work_write on public.cycle_work_items for all to authenticated using (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_write_project(c.project_id))) with check (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_write_project(c.project_id)));
create policy cycle_time_read on public.cycle_time_entries for select to authenticated using (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_access_project(c.project_id)));
create policy cycle_time_write on public.cycle_time_entries for all to authenticated using (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_write_project(c.project_id))) with check (exists(select 1 from public.operating_cycles c where c.id=cycle_id and public.can_write_project(c.project_id)));
create policy audit_read on public.audit_events for select to authenticated using (project_id is not null and public.can_access_project(project_id));
-- Published playbook versions are readable to users who can reach a project pinned to them; writes remain privileged migration/admin work.
create policy playbook_read on public.playbooks for select to authenticated using (exists(select 1 from public.organisation_memberships m where m.user_id=(select auth.uid())));
create policy version_read on public.playbook_versions for select to authenticated using (exists(select 1 from public.organisation_memberships m where m.user_id=(select auth.uid())));
create policy phase_read on public.playbook_phases for select to authenticated using (exists(select 1 from public.organisation_memberships m where m.user_id=(select auth.uid())));
create policy template_read on public.playbook_task_templates for select to authenticated using (exists(select 1 from public.organisation_memberships m where m.user_id=(select auth.uid())));

revoke all on function public.transition_project_task(uuid, public.task_stage, text, text) from public;
grant execute on function public.transition_project_task(uuid, public.task_stage, text, text) to authenticated;

-- This project opts out of automatic Data API exposure. Grants are explicit; RLS policies above
-- still decide which rows each authenticated user may access.
grant select on public.organisations, public.organisation_memberships, public.projects, public.project_members, public.project_tasks, public.task_transition_events, public.task_notes, public.artifacts, public.artifact_versions, public.evidence_records, public.artifact_publications, public.artifact_acknowledgements, public.artifact_access_grants, public.deliverables, public.project_qualification_items, public.training_records, public.operating_cycles, public.cycle_work_items, public.cycle_time_entries, public.audit_events, public.playbooks, public.playbook_versions, public.playbook_phases, public.playbook_task_templates to authenticated;
grant insert, update, delete on public.projects, public.project_members, public.project_tasks, public.task_notes, public.artifacts, public.artifact_publications, public.artifact_access_grants, public.deliverables, public.project_qualification_items, public.training_records, public.operating_cycles, public.cycle_work_items, public.cycle_time_entries to authenticated;
grant insert on public.evidence_records, public.artifact_acknowledgements to authenticated;

revoke all on function public.is_platform_admin(), public.current_org_role(uuid), public.can_manage_org(uuid), public.can_access_project(uuid), public.can_write_project(uuid), public.is_internal_project_user(uuid), public.can_access_restricted_artifact(uuid) from public;
grant execute on function public.is_platform_admin(), public.current_org_role(uuid), public.can_manage_org(uuid), public.can_access_project(uuid), public.can_write_project(uuid), public.is_internal_project_user(uuid), public.can_access_restricted_artifact(uuid) to authenticated;

-- Files live in a private bucket. Upload/version creation is performed by a reviewed Edge Function
-- after it authorizes the caller; browser clients receive only a short-lived signed upload URL.
insert into storage.buckets (id, name, public, file_size_limit)
values ('artifacts', 'artifacts', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
create policy artifact_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'artifacts' and exists (
    select 1 from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id
    where v.storage_path = name
  )
);
