-- The legacy-backup importer runs only in a server-side Edge Function after it
-- verifies the caller with public.is_platform_admin(). The service role never
-- reaches browser code, but it still needs explicit object privileges because
-- this project intentionally does not rely on implicit Data API grants.

grant usage on schema public to service_role;

grant select on public.organisation_memberships to service_role;
grant select, insert, update on public.playbooks to service_role;
grant select, insert on public.playbook_versions, public.playbook_phases, public.playbook_task_templates to service_role;
grant select, insert on public.projects, public.project_tasks to service_role;
grant insert on public.project_members, public.task_notes, public.project_qualification_items, public.audit_events to service_role;
