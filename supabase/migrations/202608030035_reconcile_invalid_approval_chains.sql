-- A group approval is valid only while each priority item still has a current
-- request linked to that same group. Older experimental requests created an
-- invalid state: a parent remained requested after its priority children had
-- been cancelled. Retain that history, but close the invalid chain so it cannot
-- appear as live work in either workspace.

with invalid_live_groups as (
  select group_row.request_id
  from public.qualification_approval_groups group_row
  join public.client_response_requests parent on parent.id = group_row.request_id
  where parent.status in ('requested', 'responded')
    and exists (
      select 1
      from public.qualification_approval_group_items item
      where item.group_id = group_row.id
        and item.requires_individual_approval
        and not exists (
          select 1
          from public.client_response_requests child
          where child.parent_request_id = parent.id
            and child.qualification_item_id = item.qualification_item_id
            and child.status in ('requested', 'responded', 'completed')
        )
    )
)
update public.client_response_requests request
set status = 'cancelled', closed_at = coalesce(request.closed_at, now())
where (request.id in (select request_id from invalid_live_groups)
       or request.parent_request_id in (select request_id from invalid_live_groups))
  and request.status in ('requested', 'responded');
