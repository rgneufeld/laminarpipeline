import { createClient } from 'npm:@supabase/supabase-js@2'

type Json = Record<string, unknown>

const allowedOrigins = new Set(['http://localhost:5173', 'https://rgneufeld.github.io'])

function headers(request: Request) {
  const origin = request.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://rgneufeld.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function assetStatus(value: unknown): string {
  const status = text(value).replaceAll('-', '_')
  return new Set(['missing', 'requested', 'received', 'not_required']).has(status) ? status : 'missing'
}

function deliverableStatus(value: unknown): string {
  const status = text(value)
  return new Set(['pending', 'delivered', 'approved']).has(status) ? status : 'pending'
}

function cycleStatus(value: unknown): string {
  const status = text(value)
  return status || 'draft'
}

async function must<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('expected database record was not returned')
  return data
}

Deno.serve(async request => {
  const cors = headers(request)
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers: cors })

  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization) return Response.json({ error: 'authentication required' }, { status: 401, headers: cors })
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return Response.json({ error: 'invalid session' }, { status: 401, headers: cors })
    const { data: isPlatformAdmin, error: roleError } = await userClient.rpc('is_platform_admin')
    if (roleError) throw new Error(roleError.message)
    if (isPlatformAdmin !== true) return Response.json({ error: 'platform administrator access required' }, { status: 403, headers: cors })

    const body = record(await request.json())
    const projectId = text(body.projectId)
    if (!projectId) return Response.json({ error: 'projectId is required' }, { status: 400, headers: cors })

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
    const project = await must(admin.from('projects').select('id,organisation_id,metadata').eq('id', projectId).single())
    const sourceEvent = await must(admin
      .from('audit_events')
      .select('id,payload')
      .eq('project_id', projectId)
      .eq('event_type', 'legacy.backup_imported')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .single())
    const legacy = record(record(sourceEvent.payload).legacy_snapshot)
    if (!Object.keys(legacy).length) throw new Error('legacy import snapshot is unavailable')

    const assets = record(legacy.assets)
    for (const [stableKey, rawAsset] of Object.entries(assets)) {
      const asset = record(rawAsset)
      const { error } = await admin.from('project_asset_items').upsert({
        project_id: projectId,
        stable_key: stableKey,
        status: assetStatus(asset.status),
        internal_note: text(asset.internalNote),
        metadata: asset,
        updated_by: userData.user.id,
      }, { onConflict: 'project_id,stable_key' })
      if (error) throw new Error(error.message)
    }

    const deliverables = record(legacy.deliverables)
    for (const [stableKey, rawDeliverable] of Object.entries(deliverables)) {
      const deliverable = record(rawDeliverable)
      const { data: existing, error: findError } = await admin.from('deliverables').select('id').eq('project_id', projectId).eq('stable_key', stableKey).maybeSingle()
      if (findError) throw new Error(findError.message)
      const row = {
        project_id: projectId,
        stable_key: stableKey,
        title: text(deliverable.name, stableKey),
        status: deliverableStatus(deliverable.status),
        client_visible: deliverable.inScope !== false,
        metadata: deliverable,
      }
      const { error } = existing
        ? await admin.from('deliverables').update(row).eq('id', existing.id)
        : await admin.from('deliverables').insert(row)
      if (error) throw new Error(error.message)
    }

    const training = record(legacy.training)
    for (const [stableKey, rawTraining] of Object.entries(training)) {
      const trainingRecord = record(rawTraining)
      const complete = Object.keys(record(trainingRecord.competencies)).length > 0
      const { error } = await admin.from('training_records').upsert({
        project_id: projectId,
        stable_key: stableKey,
        status: complete ? 'in_progress' : 'pending',
        metadata: trainingRecord,
      }, { onConflict: 'project_id,stable_key' })
      if (error) throw new Error(error.message)
    }

    const cycles = record(legacy.cycles)
    for (const [legacyCycleId, rawCycle] of Object.entries(cycles)) {
      const cycle = record(rawCycle)
      const period = text(cycle.period)
      if (!/^\d{4}-\d{2}$/.test(period)) continue
      const storedCycle = await must(admin.from('operating_cycles').upsert({
        project_id: projectId,
        period: `${period}-01`,
        status: cycleStatus(cycle.status),
        locked_at: cycle.locked === true ? text(cycle.closedAt, new Date().toISOString()) : null,
        metadata: { ...cycle, legacy_cycle_id: legacyCycleId },
      }, { onConflict: 'project_id,period' }).select('id').single())

      for (const [index, rawWork] of (Array.isArray(cycle.work) ? cycle.work : []).entries()) {
        const work = record(rawWork)
        const legacyId = text(work.id, `work-${index}`)
        const { data: existing } = await admin.from('cycle_work_items').select('id').eq('cycle_id', storedCycle.id).eq('legacy_id', legacyId).maybeSingle()
        const row = { cycle_id: storedCycle.id, legacy_id: legacyId, title: text(work.title, text(work.initiative, 'Untitled work item')), status: text(work.status, 'planned'), estimated_hours: Number(work.plannedHours) || null, metadata: work }
        const { error } = existing ? await admin.from('cycle_work_items').update(row).eq('id', existing.id) : await admin.from('cycle_work_items').insert(row)
        if (error) throw new Error(error.message)
      }

      const capacity = record(cycle.capacity)
      for (const [index, rawEntry] of (Array.isArray(capacity.timeEntries) ? capacity.timeEntries : []).entries()) {
        const entry = record(rawEntry)
        const legacyId = text(entry.id, `time-${index}`)
        const occurredOn = text(entry.date, `${period}-01`)
        const { data: existing } = await admin.from('cycle_time_entries').select('id').eq('cycle_id', storedCycle.id).eq('legacy_id', legacyId).maybeSingle()
        const row = { cycle_id: storedCycle.id, legacy_id: legacyId, occurred_on: occurredOn, hours: Number(entry.hours) || 0.01, category: text(entry.category, 'legacy_import'), note: text(entry.description), entered_by: userData.user.id, metadata: entry }
        const { error } = existing ? await admin.from('cycle_time_entries').update(row).eq('id', existing.id) : await admin.from('cycle_time_entries').insert(row)
        if (error) throw new Error(error.message)
      }
    }

    const { error: projectError } = await admin.from('projects').update({ metadata: { ...record(project.metadata), legacy_materialized_from_audit_event: sourceEvent.id } }).eq('id', projectId)
    if (projectError) throw new Error(projectError.message)
    const { error: auditError } = await admin.from('audit_events').insert({ organisation_id: project.organisation_id, project_id: projectId, actor_id: userData.user.id, event_type: 'legacy.snapshot_materialized', entity_type: 'project', entity_id: projectId, payload: { source_audit_event_id: sourceEvent.id } })
    if (auditError) throw new Error(auditError.message)

    return Response.json({ projectId, sourceAuditEventId: sourceEvent.id, materialized: { assets: Object.keys(assets).length, deliverables: Object.keys(deliverables).length, training: Object.keys(training).length, cycles: Object.keys(cycles).length } }, { headers: cors })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'materialization failed' }, { status: 400, headers: cors })
  }
})
