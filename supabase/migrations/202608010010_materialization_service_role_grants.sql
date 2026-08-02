-- The privileged materialization Edge Function writes the live, collaborative
-- representation of preserved legacy project data. These grants are explicit:
-- the browser still receives only the publishable key and RLS remains in force
-- for browser-originated requests.

grant select, insert, update on public.project_asset_items to service_role;
grant select, insert, update on public.deliverables to service_role;
grant select, insert, update on public.training_records to service_role;
grant select, insert, update on public.operating_cycles to service_role;
grant select, insert, update on public.cycle_work_items to service_role;
grant select, insert, update on public.cycle_time_entries to service_role;
grant select, update on public.projects to service_role;
grant select on public.audit_events to service_role;
