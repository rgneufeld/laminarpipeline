-- The invitation Edge Function is privileged but still needs explicit table
-- privileges in this locked-down schema to create/update organisation membership.
grant insert, update on public.organisation_memberships to service_role;
