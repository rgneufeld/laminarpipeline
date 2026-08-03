-- The reviewed artifact-upload Edge Function uses the server-only service role
-- to create artifact records and immutable versions after authorizing the
-- signed-in caller. Browser users receive no additional table privileges.

grant select, insert, update on public.artifacts, public.artifact_versions to service_role;
grant insert on public.artifact_publications to service_role;
