// Supabase Edge Function "submit": receives one category from the Studio and
// files it in the private inbox. All the logic is in handler.js (tested in
// node by supabase/tests/handler.test.mjs); this file only wires it up.
//
// Settings it reads (Supabase provides the first two automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   secret service key; never in the website
//   ALLOWED_ORIGINS   optional, comma list; default: the GitHub Pages site + localhost:4607
//   TURNSTILE_SECRET  optional; when set, the "are you human" check is required
//   RATE_SALT         optional; mixes into the IP hash used for the hourly limit
//
// Deploy: supabase functions deploy submit --no-verify-jwt   (see supabase/SETUP.md)

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { createHandler } from './handler.js';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const handle = createHandler({
  env: (name: string) => Deno.env.get(name),
  supabase,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
});

Deno.serve(handle);
