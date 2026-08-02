import { createClient } from 'npm:@supabase/supabase-js@2'

type Json = Record<string, unknown>

const allowedOrigins = new Set([
  'http://localhost:5173',
  'https://rgneufeld.github.io',
])

function cors(request: Request) {
  const origin = request.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://rgneufeld.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function oldStage(value: unknown): string {
  const stage = text(value, 'pending').replaceAll('-', '_')
  return new Set(['pending', 'in_scope', 'na', 'active', 'blocked', 'client_review', 'complete', 'delivered']).has(stage)
    ? stage
    : 'pending'
}

function projectStatus(value: unknown): string {
  const status = text(value, 'qualified')
  return new Set(['lead', 'qualified', 'proposed', 'active', 'blocked', 'client-review', 'ready-launch', 'live', 'completed', 'archived']).has(status)
    ? status
    : 'qualified'
}

async function must<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('expected database record was not returned')
  return data
}

Deno.serve(async (request) => {
  const headers = cors(request)
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers })

  try {
    const token = request.headers.get('Authorization')
    if (!token) return Response.json({ error: 'authentication required' }, { status: 401, headers })

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: token } } },
    )
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return Response.json({ error: 'invalid session' }, { status: 401, headers })
    const userId = userData.user.id

    const { data: isPlatformAdmin, error: platformAdminError } = await userClient.rpc('is_platform_admin')
    if (platformAdminError) throw new Error(platformAdminError.message)
    if (isPlatformAdmin !== true) return Response.json({ error: 'platform administrator access required' }, { status: 403, headers })

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    const body = asRecord(await request.json())
    const backup = asRecord(body.backup)
    const catalog = asRecord(body.catalog)
    const projectEntries = Object.entries(asRecord(backup.projects))
    const catalogPlaybooks = Array.isArray(catalog.playbooks) ? catalog.playbooks : []
    if (backup.schemaVersion !== 2 || projectEntries.length === 0) {
      return Response.json({ error: 'a Laminar Framework schemaVersion 2 backup with at least one project is required' }, { status: 400, headers })
    }
    if (projectEntries.length > 100 || catalogPlaybooks.length === 0) {
      return Response.json({ error: 'invalid import payload' }, { status: 400, headers })
    }

    const organisation = await must(admin
      .from('organisation_memberships')
      .select('organisation_id, organisations!inner(id, name)')
      .eq('user_id', userId)
      .in('role', ['organisation_owner', 'delivery_manager'])
      .limit(1)
      .single())
    const organisationId = organisation.organisation_id as string

    const versionByCode = new Map<string, string>()
    const templatesByCode = new Map<string, Map<string, Json>>()

    for (const rawPlaybook of catalogPlaybooks) {
      const playbook = asRecord(rawPlaybook)
      const code = text(playbook.code)
      if (!code) throw new Error('catalog includes a playbook without a code')

      const { data: storedPlaybook, error: playbookError } = await admin
        .from('playbooks')
        .upsert({ code, name: text(playbook.name, code), description: text(playbook.description) }, { onConflict: 'code' })
        .select('id')
        .single()
      if (playbookError || !storedPlaybook) throw new Error(playbookError?.message ?? 'could not store playbook')

      const versionNumber = Math.max(1, Number.parseInt(text(playbook.version, '1').split('.')[0], 10) || 1)
      let { data: version } = await admin
        .from('playbook_versions')
        .select('id')
        .eq('playbook_id', storedPlaybook.id)
        .eq('version_number', versionNumber)
        .maybeSingle()
      if (!version) {
        const inserted = await must(admin
          .from('playbook_versions')
          .insert({ playbook_id: storedPlaybook.id, version_number: versionNumber, status: 'published', definition: playbook, published_at: new Date().toISOString() })
          .select('id')
          .single())
        version = inserted
      }
      versionByCode.set(code, version.id as string)

      const phaseIds = new Map<string, string>()
      for (const [index, rawPhase] of (Array.isArray(playbook.phases) ? playbook.phases : []).entries()) {
        const phase = asRecord(rawPhase)
        const stableKey = text(phase.stableKey)
        if (!stableKey) throw new Error(`playbook ${code} includes a phase without a stable key`)
        let { data: storedPhase, error: phaseError } = await admin
          .from('playbook_phases')
          .select('id')
          .eq('playbook_version_id', version.id)
          .eq('stable_key', stableKey)
          .maybeSingle()
        if (phaseError) throw new Error(phaseError.message)
        if (!storedPhase) {
          const insertedPhase = await must(admin
            .from('playbook_phases')
            .insert({
              playbook_version_id: version.id,
              stable_key: stableKey,
              position: Number(phase.position) || index + 1,
              label: text(phase.tag, `Phase ${index + 1}`),
              title: text(phase.title, stableKey),
              objective: phase.objective ?? null,
              color: phase.color ?? null,
            })
            .select('id')
            .single())
          storedPhase = insertedPhase
        }
        phaseIds.set(stableKey, storedPhase.id as string)

        const templateMap = templatesByCode.get(code) ?? new Map<string, Json>()
        for (const [taskIndex, rawTask] of (Array.isArray(phase.tasks) ? phase.tasks : []).entries()) {
          const task = asRecord(rawTask)
          const taskKey = text(task.stableKey)
          if (!taskKey) throw new Error(`phase ${stableKey} includes a task without a stable key`)
          let { data: storedTask, error: taskError } = await admin
            .from('playbook_task_templates')
            .select('id, phase_id, stable_key, title')
            .eq('phase_id', storedPhase.id)
            .eq('stable_key', taskKey)
            .maybeSingle()
          if (taskError) throw new Error(taskError.message)
          if (!storedTask) {
            const insertedTask = await must(admin
              .from('playbook_task_templates')
              .insert({
                phase_id: storedPhase.id,
                stable_key: taskKey,
                position: Number(task.position) || taskIndex + 1,
                title: text(task.title, taskKey),
                guidance: task.guidance ?? null,
                client_action: task.clientAction === true,
                required_evidence: Array.isArray(task.requiredEvidence) ? task.requiredEvidence : [],
                validation_rules: asRecord(task.validationRules),
              })
              .select('id, phase_id, stable_key, title')
              .single())
            storedTask = insertedTask
          }
          templateMap.set(taskKey, { ...storedTask, phaseId: phaseIds.get(stableKey) })
        }
        templatesByCode.set(code, templateMap)
      }
    }

    const imported: Array<{ legacyProjectId: string; projectId: string; name: string }> = []
    for (const [legacyProjectId, rawProject] of projectEntries) {
      const legacy = asRecord(rawProject)
      const playbookCode = text(legacy.playbookId)
      const playbookVersionId = versionByCode.get(playbookCode)
      const templates = templatesByCode.get(playbookCode)
      if (!playbookVersionId || !templates) throw new Error(`no catalog playbook matches ${playbookCode}`)

      const name = text(legacy.clientName, 'Imported Laminar project').trim() || 'Imported Laminar project'
      const project = await must(admin
        .from('projects')
        .insert({
          organisation_id: organisationId,
          playbook_version_id: playbookVersionId,
          name,
          client_name: name,
          status: projectStatus(legacy.status),
          created_by: userId,
          created_at: text(legacy.createdAt, new Date().toISOString()),
          updated_at: text(legacy.updatedAt, new Date().toISOString()),
        })
        .select('id')
        .single())
      await admin.from('project_members').upsert({ project_id: project.id, user_id: userId, role: 'delivery_manager' })

      const tasks = asRecord(legacy.tasks)
      const projectTasks: Json[] = []
      for (const [stableKey, template] of templates.entries()) {
        const task = asRecord(tasks[stableKey])
        projectTasks.push({
          project_id: project.id,
          phase_id: template.phaseId,
          task_template_id: template.id,
          stable_key: stableKey,
          title: template.title,
          stage: oldStage(task.stage),
          sort_rank: 0,
          blocked_reason: oldStage(task.stage) === 'blocked' ? text(task.blockedReason, 'Imported as blocked') : null,
          completed_at: ['complete', 'delivered'].includes(oldStage(task.stage)) ? text(task.updatedAt, new Date().toISOString()) : null,
          delivered_at: oldStage(task.stage) === 'delivered' ? text(task.updatedAt, new Date().toISOString()) : null,
          metadata: { legacy_log: Array.isArray(task.log) ? task.log : [], legacy_blocked_from: task.blockedFrom ?? null },
        })
      }
      if (projectTasks.length) {
        const { error } = await admin.from('project_tasks').insert(projectTasks)
        if (error) throw new Error(error.message)
      }

      const { data: insertedTasks, error: insertedTaskError } = await admin
        .from('project_tasks')
        .select('id, stable_key')
        .eq('project_id', project.id)
      if (insertedTaskError) throw new Error(insertedTaskError.message)
      const taskIdByKey = new Map((insertedTasks ?? []).map((task) => [task.stable_key, task.id]))
      const notes: Json[] = []
      for (const [stableKey, rawTask] of Object.entries(tasks)) {
        const taskId = taskIdByKey.get(stableKey)
        const note = asRecord(asRecord(rawTask).note)
        if (!taskId) continue
        for (const visibility of ['internal', 'client'] as const) {
          const body = text(note[visibility]).trim()
          if (body) notes.push({ project_id: project.id, task_id: taskId, visibility, body, created_by: userId })
        }
      }
      if (notes.length) {
        const { error } = await admin.from('task_notes').insert(notes)
        if (error) throw new Error(error.message)
      }

      const qualification = asRecord(legacy.qualification)
      const qualificationRows = Object.entries(qualification).map(([stableKey, rawValue]) => {
        const value = asRecord(rawValue)
        return { project_id: project.id, stable_key: stableKey, complete: value.value === true, completed_at: value.value === true ? text(value.updatedAt, new Date().toISOString()) : null, completed_by: value.value === true ? userId : null }
      })
      if (qualificationRows.length) await admin.from('project_qualification_items').insert(qualificationRows)

      await admin.from('audit_events').insert({
        organisation_id: organisationId,
        project_id: project.id,
        actor_id: userId,
        event_type: 'legacy.backup_imported',
        entity_type: 'project',
        entity_id: project.id,
        payload: {
          legacy_project_id: legacyProjectId,
          legacy_schema_version: backup.schemaVersion,
          imported_task_count: projectTasks.length,
          legacy_snapshot: legacy,
        },
      })
      imported.push({ legacyProjectId, projectId: project.id as string, name })
    }

    return Response.json({ organisationId, imported, importedProjectCount: imported.length }, { headers })
  } catch (error) {
    console.error(error)
    return Response.json({ error: error instanceof Error ? error.message : 'import failed' }, { status: 400, headers })
  }
})
