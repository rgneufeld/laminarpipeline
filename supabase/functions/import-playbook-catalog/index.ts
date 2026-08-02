import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (request) => {
  const cors = { 'Access-Control-Allow-Origin': 'http://localhost:5173', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = request.headers.get('Authorization');
  if (!auth) return Response.json({ error: 'authentication required' }, { status: 401, headers: cors });
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const body = await request.json();
  const { data, error } = await client.rpc('import_playbook_catalog', { p_catalog: body });
  return error ? Response.json({ error: error.message }, { status: 400, headers: cors }) : Response.json({ importedPlaybookVersions: data }, { headers: cors });
});
