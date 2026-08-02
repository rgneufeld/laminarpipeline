-- One-time bootstrap for an empty Laminar Pipeline installation.
-- It can succeed only while no organisation exists and requires an authenticated user.

create function public.bootstrap_first_organisation(p_name text, p_slug text)
returns public.organisations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organisation public.organisations;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication is required';
  end if;

  if exists (select 1 from public.organisations) then
    raise exception 'initial organisation has already been created';
  end if;

  if nullif(trim(p_name), '') is null or p_slug !~ '^[a-z0-9-]{3,80}$' then
    raise exception 'a name and lowercase slug are required';
  end if;

  insert into public.organisations (name, slug)
  values (trim(p_name), p_slug)
  returning * into v_organisation;

  insert into public.organisation_memberships (organisation_id, user_id, role)
  values (v_organisation.id, (select auth.uid()), 'organisation_owner');

  insert into public.platform_admins (user_id)
  values ((select auth.uid()));

  return v_organisation;
end;
$$;

revoke all on function public.bootstrap_first_organisation(text, text) from public;
grant execute on function public.bootstrap_first_organisation(text, text) to authenticated;
