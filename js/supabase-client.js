import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';

export const supabase = createClient(
  'https://nhiqblznignfyxycdmsd.supabase.co',
  'sb_publishable_avD7yip20sKJDCwsU0IRAw_3TA-J5hS',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
