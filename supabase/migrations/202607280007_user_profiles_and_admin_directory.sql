-- Safe browser-visible identity directory. Auth credentials remain in auth.users.
create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_user_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger auth_user_profile_after_insert
after insert on auth.users for each row execute function public.create_user_profile();

insert into public.user_profiles (user_id, display_name)
select id, coalesce(raw_user_meta_data->>'display_name', split_part(email, '@', 1)) from auth.users
on conflict (user_id) do nothing;

alter table public.user_profiles enable row level security;
create policy profile_read_within_org on public.user_profiles for select to authenticated using (
  user_id = (select auth.uid()) or exists (
    select 1 from public.organisation_memberships mine
    join public.organisation_memberships theirs on theirs.organisation_id = mine.organisation_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = user_profiles.user_id
  )
);
create policy profile_manage_self on public.user_profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, update on public.user_profiles to authenticated;
