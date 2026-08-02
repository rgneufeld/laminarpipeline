import { createClient } from 'npm:@supabase/supabase-js@2'

const allowedRoles = new Set(['organisation_owner', 'delivery_manager', 'contributor', 'client_admin', 'client_collaborator', 'viewer'])

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin') ?? ''
  const headers = {
    'Access-Control-Allow-Origin': origin === 'https://rgneufeld.github.io' || origin === 'http://localhost:5173' ? origin : 'https://rgneufeld.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers })
  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization) return Response.json({ error: 'authentication required' }, { status: 401, headers })
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return Response.json({ error: 'invalid session' }, { status: 401, headers })
    const payload = await request.json()
    const organisationId = typeof payload.organisationId === 'string' ? payload.organisationId : ''
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    const role = typeof payload.role === 'string' ? payload.role : ''
    if (!organisationId || !email || !allowedRoles.has(role)) return Response.json({ error: 'organisation, email, and a valid role are required' }, { status: 400, headers })
    const [{ data: canManage, error: permissionError }, { data: callerRole, error: roleError }, { data: isPlatformAdmin, error: platformError }] = await Promise.all([
      userClient.rpc('can_manage_org', { p_org: organisationId }),
      userClient.rpc('current_org_role', { p_org: organisationId }),
      userClient.rpc('is_platform_admin'),
    ])
    if (permissionError || roleError || platformError) throw new Error(permissionError?.message || roleError?.message || platformError?.message)
    if (canManage !== true) return Response.json({ error: 'organisation management access required' }, { status: 403, headers })
    if (role === 'organisation_owner' && callerRole !== 'organisation_owner' && isPlatformAdmin !== true) return Response.json({ error: 'only an organisation owner can invite another owner' }, { status: 403, headers })
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email)
    if (inviteError && !/already.*registered|already.*exists/i.test(inviteError.message)) throw new Error(inviteError.message)
    let userId = invited.user?.id
    if (!userId) {
      const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      if (listError) throw new Error(listError.message)
      userId = listed.users.find(user => user.email?.toLowerCase() === email)?.id
      if (!userId) throw new Error('The existing user could not be found.')
    }
    const { error: membershipError } = await admin.from('organisation_memberships').upsert({ organisation_id: organisationId, user_id: userId, role }, { onConflict: 'organisation_id,user_id' })
    if (membershipError) throw new Error(membershipError.message)
    return Response.json({ userId, email, role }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'invitation failed' }, { status: 400, headers })
  }
})
