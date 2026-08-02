import { createClient } from 'npm:@supabase/supabase-js@2'

const allowedOrigins = new Set(['https://rgneufeld.github.io', 'http://localhost:5173'])
const internalVisibilities = new Set(['internal', 'client', 'restricted'])
const clientVisibility = 'client_upload'
const maxBytes = 52_428_800

function cors(request: Request) {
  const origin = request.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://rgneufeld.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'document'
}

Deno.serve(async (request) => {
  const headers = cors(request)
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers })

  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization) return Response.json({ error: 'authentication required' }, { status: 401, headers })
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return Response.json({ error: 'invalid session' }, { status: 401, headers })

    const body = await request.json()
    const action = text(body.action)
    const projectId = text(body.projectId)
    if (!projectId) return Response.json({ error: 'project is required' }, { status: 400, headers })
    const { data: access, error: accessError } = await userClient.rpc('can_write_project', { p_project: projectId })
    if (accessError) throw new Error(accessError.message)
    if (access !== true) return Response.json({ error: 'project write access required' }, { status: 403, headers })
    const { data: internal, error: internalError } = await userClient.rpc('is_internal_project_user', { p_project: projectId })
    if (internalError) throw new Error(internalError.message)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })

    if (action === 'prepare') {
      const title = text(body.title)
      const fileName = safeFileName(text(body.fileName))
      const mimeType = text(body.mimeType) || 'application/octet-stream'
      const byteSize = Number(body.byteSize)
      const visibility = text(body.visibility)
      const artifactId = text(body.artifactId)
      if (!title || !fileName || !Number.isFinite(byteSize) || byteSize <= 0 || byteSize > maxBytes) return Response.json({ error: 'title and a file up to 50 MB are required' }, { status: 400, headers })
      if (![...internalVisibilities, clientVisibility].includes(visibility)) return Response.json({ error: 'invalid visibility' }, { status: 400, headers })
      if (!internal && visibility !== clientVisibility) return Response.json({ error: 'clients may only upload client-provided documents' }, { status: 403, headers })

      const { data: project, error: projectError } = await admin.from('projects').select('organisation_id').eq('id', projectId).single()
      if (projectError || !project) throw new Error(projectError?.message ?? 'project not found')
      let targetArtifactId = artifactId
      if (targetArtifactId) {
        const { data: existing, error: existingError } = await admin.from('artifacts').select('id,project_id,visibility').eq('id', targetArtifactId).maybeSingle()
        if (existingError || !existing || existing.project_id !== projectId) return Response.json({ error: 'artifact is not available for this project' }, { status: 404, headers })
        if (!internal && existing.visibility !== clientVisibility) return Response.json({ error: 'clients may only add a version to a client-provided document' }, { status: 403, headers })
      } else {
        const { data: created, error: createError } = await admin.from('artifacts').insert({ organisation_id: project.organisation_id, project_id: projectId, title, visibility, origin: internal ? 'internal_upload' : 'client_upload', status: 'pending_scan', created_by: userData.user.id }).select('id').single()
        if (createError || !created) throw new Error(createError?.message ?? 'could not create artifact')
        targetArtifactId = created.id
      }
      const { data: versions, error: versionError } = await admin.from('artifact_versions').select('version_number').eq('artifact_id', targetArtifactId).order('version_number', { ascending: false }).limit(1)
      if (versionError) throw new Error(versionError.message)
      const versionNumber = Number(versions?.[0]?.version_number || 0) + 1
      const storagePath = `${projectId}/${targetArtifactId}/v${versionNumber}-${crypto.randomUUID()}-${fileName}`
      const { data: signed, error: signedError } = await admin.storage.from('artifacts').createSignedUploadUrl(storagePath)
      if (signedError || !signed) throw new Error(signedError?.message ?? 'could not prepare upload')
      const { data: version, error: insertError } = await admin.from('artifact_versions').insert({ artifact_id: targetArtifactId, version_number: versionNumber, storage_path: storagePath, file_name: fileName, mime_type: mimeType, byte_size: byteSize, uploaded_by: userData.user.id }).select('id').single()
      if (insertError || !version) throw new Error(insertError?.message ?? 'could not create artifact version')
      await admin.from('audit_events').insert({ organisation_id: project.organisation_id, project_id: projectId, actor_id: userData.user.id, event_type: 'artifact.upload_prepared', entity_type: 'artifact_version', entity_id: version.id, payload: { artifact_id: targetArtifactId, version_number: versionNumber, visibility } })
      return Response.json({ artifactId: targetArtifactId, versionId: version.id, storagePath, token: signed.token }, { headers })
    }

    if (action === 'complete') {
      const versionId = text(body.versionId)
      if (!versionId) return Response.json({ error: 'version is required' }, { status: 400, headers })
      const { data: version, error: versionError } = await admin.from('artifact_versions').select('id,artifact_id,storage_path,version_number,artifacts!inner(id,project_id,organisation_id)').eq('id', versionId).maybeSingle()
      const artifact = Array.isArray(version?.artifacts) ? version?.artifacts[0] : version?.artifacts
      if (versionError || !version || !artifact || artifact.project_id !== projectId) return Response.json({ error: 'version is not available for this project' }, { status: 404, headers })
      const { error: downloadError } = await admin.storage.from('artifacts').download(version.storage_path)
      if (downloadError) return Response.json({ error: 'uploaded file was not found' }, { status: 400, headers })
      await admin.from('artifact_versions').update({ superseded_at: new Date().toISOString() }).eq('artifact_id', version.artifact_id).lt('version_number', version.version_number).is('superseded_at', null)
      const { error: artifactError } = await admin.from('artifacts').update({ status: 'available' }).eq('id', version.artifact_id)
      if (artifactError) throw new Error(artifactError.message)
      await admin.from('audit_events').insert({ organisation_id: artifact.organisation_id, project_id: projectId, actor_id: userData.user.id, event_type: 'artifact.uploaded', entity_type: 'artifact_version', entity_id: versionId, payload: { artifact_id: version.artifact_id, version_number: version.version_number } })
      return Response.json({ artifactId: version.artifact_id, versionId }, { headers })
    }

    if (action === 'download') {
      const artifactId = text(body.artifactId)
      const { data: permitted, error: permittedError } = await userClient.from('artifacts').select('id').eq('id', artifactId).eq('project_id', projectId).maybeSingle()
      if (permittedError || !permitted) return Response.json({ error: 'document is not available to your account' }, { status: 403, headers })
      const { data: version, error: versionError } = await admin.from('artifact_versions').select('storage_path,file_name').eq('artifact_id', artifactId).is('superseded_at', null).order('version_number', { ascending: false }).limit(1).maybeSingle()
      if (versionError || !version) return Response.json({ error: 'document has no available version' }, { status: 404, headers })
      const { data: signed, error: signedError } = await admin.storage.from('artifacts').createSignedUrl(version.storage_path, 60)
      if (signedError || !signed) throw new Error(signedError?.message ?? 'could not create download link')
      return Response.json({ url: signed.signedUrl, fileName: version.file_name }, { headers })
    }

    if (action === 'publish-client-copy') {
      const artifactId = text(body.artifactId)
      if (!internal) return Response.json({ error: 'internal delivery access required' }, { status: 403, headers })
      const { data: source, error: sourceError } = await admin.from('artifacts').select('id,organisation_id,project_id,title,visibility').eq('id', artifactId).eq('project_id', projectId).maybeSingle()
      if (sourceError || !source) return Response.json({ error: 'source document was not found' }, { status: 404, headers })
      const { data: sourceVersion, error: sourceVersionError } = await admin.from('artifact_versions').select('id,storage_path,file_name,mime_type,byte_size').eq('artifact_id', artifactId).is('superseded_at', null).order('version_number', { ascending: false }).limit(1).maybeSingle()
      if (sourceVersionError || !sourceVersion) return Response.json({ error: 'source document has no available version' }, { status: 404, headers })
      const { data: publishedArtifact, error: publishedArtifactError } = await admin.from('artifacts').insert({ organisation_id: source.organisation_id, project_id: projectId, title: `${source.title} — client delivery`, visibility: 'client', origin: 'system_export', source_artifact_id: source.id, status: 'pending_scan', approved_at: new Date().toISOString(), approved_by: userData.user.id, created_by: userData.user.id }).select('id').single()
      if (publishedArtifactError || !publishedArtifact) throw new Error(publishedArtifactError?.message ?? 'could not create client document')
      const destinationPath = `${projectId}/${publishedArtifact.id}/v1-${crypto.randomUUID()}-${safeFileName(sourceVersion.file_name)}`
      const { error: copyError } = await admin.storage.from('artifacts').copy(sourceVersion.storage_path, destinationPath)
      if (copyError) throw new Error(copyError.message)
      const { data: publishedVersion, error: publishedVersionError } = await admin.from('artifact_versions').insert({ artifact_id: publishedArtifact.id, version_number: 1, storage_path: destinationPath, file_name: sourceVersion.file_name, mime_type: sourceVersion.mime_type, byte_size: sourceVersion.byte_size, uploaded_by: userData.user.id }).select('id').single()
      if (publishedVersionError || !publishedVersion) throw new Error(publishedVersionError?.message ?? 'could not create client document version')
      await admin.from('artifacts').update({ status: 'available' }).eq('id', publishedArtifact.id)
      await admin.from('artifact_publications').insert({ organisation_id: source.organisation_id, project_id: projectId, source_artifact_version_id: sourceVersion.id, published_artifact_version_id: publishedVersion.id, published_by: userData.user.id, approved_by: userData.user.id })
      await admin.from('audit_events').insert({ organisation_id: source.organisation_id, project_id: projectId, actor_id: userData.user.id, event_type: 'artifact.client_copy_published', entity_type: 'artifact', entity_id: publishedArtifact.id, payload: { source_artifact_id: source.id, source_version_id: sourceVersion.id } })
      return Response.json({ artifactId: publishedArtifact.id }, { headers })
    }
    return Response.json({ error: 'unknown action' }, { status: 400, headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'artifact upload failed' }, { status: 400, headers })
  }
})
