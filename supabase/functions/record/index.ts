// Supabase Edge Function "record": anonymous play stats from the game (a
// finished puzzle, or a difficulty rating). All the logic is in handler.js
// (tested in node by supabase/tests/record.test.mjs); this file only wires it up.
//
// Settings it reads (the same ones as "submit"):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided by Supabase)
//   DP_SECRET_KEY     the new secret key (sb_secret_...); used instead of the
//                     legacy key when present (pickServerKey in ../submit/handler.js)
//   ALLOWED_ORIGINS   optional, comma list; default: the GitHub Pages site + localhost:4607
//   RATE_SALT         optional; mixes into the IP hash used for the hourly limit
//
// Deploy: npx supabase functions deploy record --no-verify-jwt --use-api   (see supabase/SETUP.md)

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { createHandler, pickServerKey } from './handler.js';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  pickServerKey((name: string) => Deno.env.get(name)),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const handle = createHandler({
  env: (name: string) => Deno.env.get(name),
  supabase,
});

Deno.serve(handle);
