-- Materialize the immutable legacy-backup snapshots already retained in
-- audit_events into the collaborative project tables. This is deliberately
-- server-side and idempotent: it does not depend on a browser session or
-- browser local storage, and re-running it updates the same stable records.

do $$
declare
  source record;
  legacy jsonb;
  legacy_key text;
  item jsonb;
  cycle_record jsonb;
  work_record jsonb;
  time_record jsonb;
  cycle_id uuid;
  period_value text;
  actor uuid;
  asset_state text;
begin
  for source in
    select distinct on (event.project_id)
      event.id as source_event_id,
      event.project_id,
      event.organisation_id,
      event.actor_id,
      event.payload
    from public.audit_events event
    where event.event_type = 'legacy.backup_imported'
      and event.project_id is not null
    order by event.project_id, event.occurred_at desc
  loop
    legacy := source.payload -> 'legacy_snapshot';
    if legacy is null or legacy = '{}'::jsonb then
      continue;
    end if;

    actor := source.actor_id;
    if actor is null then
      select membership.user_id into actor
      from public.organisation_memberships membership
      where membership.organisation_id = source.organisation_id
      order by membership.created_at
      limit 1;
    end if;

    for legacy_key, item in select key, value from jsonb_each(coalesce(legacy -> 'assets', '{}'::jsonb)) loop
      asset_state := replace(coalesce(item ->> 'status', 'missing'), '-', '_');
      if asset_state not in ('missing', 'requested', 'received', 'not_required') then
        asset_state := 'missing';
      end if;
      insert into public.project_asset_items (project_id, stable_key, status, internal_note, metadata, updated_by)
      values (source.project_id, legacy_key, asset_state, coalesce(item ->> 'internalNote', ''), item, actor)
      on conflict (project_id, stable_key) do update set
        status = excluded.status,
        internal_note = excluded.internal_note,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = now();
    end loop;

    for legacy_key, item in select key, value from jsonb_each(coalesce(legacy -> 'deliverables', '{}'::jsonb)) loop
      update public.deliverables
      set title = coalesce(item ->> 'name', legacy_key),
          status = case when item ->> 'status' in ('pending', 'delivered', 'approved') then item ->> 'status' else 'pending' end,
          client_visible = coalesce((item ->> 'inScope')::boolean, true),
          metadata = item
      where project_id = source.project_id and stable_key = legacy_key;
      if not found then
        insert into public.deliverables (project_id, stable_key, title, status, client_visible, metadata)
        values (
          source.project_id,
          legacy_key,
          coalesce(item ->> 'name', legacy_key),
          case when item ->> 'status' in ('pending', 'delivered', 'approved') then item ->> 'status' else 'pending' end,
          coalesce((item ->> 'inScope')::boolean, true),
          item
        );
      end if;
    end loop;

    for legacy_key, item in select key, value from jsonb_each(coalesce(legacy -> 'training', '{}'::jsonb)) loop
      insert into public.training_records (project_id, stable_key, status, metadata)
      values (
        source.project_id,
        legacy_key,
        case when jsonb_typeof(item -> 'competencies') = 'object' and jsonb_object_length(item -> 'competencies') > 0 then 'in_progress' else 'pending' end,
        item
      )
      on conflict (project_id, stable_key) do update set status = excluded.status, metadata = excluded.metadata;
    end loop;

    for legacy_key, cycle_record in select key, value from jsonb_each(coalesce(legacy -> 'cycles', '{}'::jsonb)) loop
      period_value := cycle_record ->> 'period';
      if period_value !~ '^[0-9]{4}-[0-9]{2}$' then
        continue;
      end if;
      insert into public.operating_cycles (project_id, period, status, locked_at, metadata)
      values (
        source.project_id,
        (period_value || '-01')::date,
        coalesce(nullif(cycle_record ->> 'status', ''), 'draft'),
        case when coalesce((cycle_record ->> 'locked')::boolean, false) then coalesce(nullif(cycle_record ->> 'closedAt', '')::timestamptz, now()) else null end,
        cycle_record || jsonb_build_object('legacy_cycle_id', legacy_key)
      )
      on conflict (project_id, period) do update set
        status = excluded.status,
        locked_at = excluded.locked_at,
        metadata = excluded.metadata
      returning id into cycle_id;

      for work_record in select value from jsonb_array_elements(coalesce(cycle_record -> 'work', '[]'::jsonb)) loop
        insert into public.cycle_work_items (cycle_id, legacy_id, title, status, estimated_hours, metadata)
        values (
          cycle_id,
          coalesce(nullif(work_record ->> 'id', ''), 'work-' || md5(work_record::text)),
          coalesce(nullif(work_record ->> 'title', ''), nullif(work_record ->> 'initiative', ''), 'Untitled work item'),
          coalesce(nullif(work_record ->> 'status', ''), 'planned'),
          nullif(work_record ->> 'plannedHours', '')::numeric,
          work_record
        )
        on conflict (cycle_id, legacy_id) where legacy_id is not null do update set
          title = excluded.title,
          status = excluded.status,
          estimated_hours = excluded.estimated_hours,
          metadata = excluded.metadata;
      end loop;

      if actor is not null then
        for time_record in select value from jsonb_array_elements(coalesce(cycle_record #> '{capacity,timeEntries}', '[]'::jsonb)) loop
          if coalesce(time_record ->> 'date', period_value || '-01') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            continue;
          end if;
          insert into public.cycle_time_entries (cycle_id, legacy_id, occurred_on, hours, category, note, entered_by, metadata)
          values (
            cycle_id,
            coalesce(nullif(time_record ->> 'id', ''), 'time-' || md5(time_record::text)),
            coalesce(time_record ->> 'date', period_value || '-01')::date,
            greatest(coalesce(nullif(time_record ->> 'hours', '')::numeric, 0.01), 0.01),
            coalesce(nullif(time_record ->> 'category', ''), 'legacy_import'),
            time_record ->> 'description',
            actor,
            time_record
          )
          on conflict (cycle_id, legacy_id) where legacy_id is not null do update set
            occurred_on = excluded.occurred_on,
            hours = excluded.hours,
            category = excluded.category,
            note = excluded.note,
            metadata = excluded.metadata;
        end loop;
      end if;
    end loop;

    update public.projects
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('legacy_materialized_from_audit_event', source.source_event_id)
    where id = source.project_id;

    if not exists (
      select 1 from public.audit_events event
      where event.project_id = source.project_id
        and event.event_type = 'legacy.snapshot_materialized'
        and event.payload ->> 'source_audit_event_id' = source.source_event_id::text
    ) then
      insert into public.audit_events (organisation_id, project_id, actor_id, event_type, entity_type, entity_id, payload)
      values (source.organisation_id, source.project_id, actor, 'legacy.snapshot_materialized', 'project', source.project_id, jsonb_build_object('source_audit_event_id', source.source_event_id));
    end if;
  end loop;
end $$;
