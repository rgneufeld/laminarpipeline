-- Organisation administration is intentionally server-controlled. Membership
-- changes cannot be made by merely changing browser UI state.
alter table public.user_profiles add column if not exists email text;
update public.user_profiles profile
set email = users.email
from auth.users users
where users.id = profile.user_id and profile.email is distinct from users.email;

create or replace function public.create_user_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (user_id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)), new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function public.set_organisation_member_role(p_organisation uuid, p_user uuid, p_role public.app_role)
returns void language plpgsql security definer set search_path = public as $$
declare caller_role public.app_role;
declare current_role public.app_role;
begin
  caller_role := public.current_org_role(p_organisation);
  if not public.is_platform_admin() and caller_role is distinct from 'organisation_owner' then raise exception 'organisation owner access required'; end if;
  if p_role = 'platform_admin' then raise exception 'platform administrator role cannot be assigned here'; end if;
  select role into current_role from public.organisation_memberships where organisation_id = p_organisation and user_id = p_user for update;
  if current_role is null then raise exception 'member not found'; end if;
  if current_role = 'organisation_owner' and p_role <> 'organisation_owner' and not exists(select 1 from public.organisation_memberships where organisation_id = p_organisation and role = 'organisation_owner' and user_id <> p_user) then raise exception 'an organisation must retain at least one owner'; end if;
  update public.organisation_memberships set role = p_role where organisation_id = p_organisation and user_id = p_user;
  insert into public.audit_events(organisation_id, actor_id, event_type, entity_type, entity_id, payload)
  values(p_organisation, auth.uid(), 'organisation_member.role_changed', 'organisation_membership', p_user, jsonb_build_object('from', current_role, 'to', p_role));
end $$;

create or replace function public.remove_organisation_member(p_organisation uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare current_role public.app_role;
begin
  if not public.is_platform_admin() and public.current_org_role(p_organisation) is distinct from 'organisation_owner' then raise exception 'organisation owner access required'; end if;
  select role into current_role from public.organisation_memberships where organisation_id = p_organisation and user_id = p_user for update;
  if current_role is null then raise exception 'member not found'; end if;
  if current_role = 'organisation_owner' and not exists(select 1 from public.organisation_memberships where organisation_id = p_organisation and role = 'organisation_owner' and user_id <> p_user) then raise exception 'an organisation must retain at least one owner'; end if;
  delete from public.organisation_memberships where organisation_id = p_organisation and user_id = p_user;
  insert into public.audit_events(organisation_id, actor_id, event_type, entity_type, entity_id, payload)
  values(p_organisation, auth.uid(), 'organisation_member.removed', 'organisation_membership', p_user, jsonb_build_object('previous_role', current_role));
end $$;

revoke all on function public.set_organisation_member_role(uuid, uuid, public.app_role), public.remove_organisation_member(uuid, uuid) from public;
grant execute on function public.set_organisation_member_role(uuid, uuid, public.app_role), public.remove_organisation_member(uuid, uuid) to authenticated;
