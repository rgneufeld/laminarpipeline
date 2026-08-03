-- One live approval package per project and one live individual approval per
-- qualification item. Older accidental duplicates are cancelled, retained for audit.

with ranked as (
  select id, row_number() over (partition by qualification_item_id order by created_at desc) as position
  from public.client_response_requests
  where qualification_item_id is not null and status in ('requested', 'responded')
)
update public.client_response_requests request
set status = 'cancelled', closed_at = now()
from ranked
where request.id = ranked.id and ranked.position > 1;

create unique index if not exists client_response_requests_live_qualification_item_idx
  on public.client_response_requests(qualification_item_id)
  where qualification_item_id is not null and status in ('requested', 'responded');

create or replace function public.prevent_duplicate_live_qualification_group()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists(
    select 1
    from public.qualification_approval_groups g
    join public.client_response_requests request on request.id = g.request_id
    where g.project_id = new.project_id
      and request.status in ('requested', 'responded')
  ) then
    raise exception 'an active qualification approval package already exists for this project';
  end if;
  return new;
end $$;

drop trigger if exists qualification_approval_group_single_live_request on public.qualification_approval_groups;
create trigger qualification_approval_group_single_live_request
before insert on public.qualification_approval_groups
for each row execute function public.prevent_duplicate_live_qualification_group();
