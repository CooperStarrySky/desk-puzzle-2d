// node supabase/tests/ui/run_all.mjs
// Starts pg_server.mjs (PGlite with every migration + seed), runs the
// Category database (S2), Planner/Calendar/Activity/Archive (S3) + Planner
// layout A (rails, Database filters, previews, pills, phone), category cards
// B2 (cards, school pill color, compact view, folding filters, detail rows), Studio,
// Admin console + Settings, orphan-upload (S4) and live syncing + presence (B6,
// through pg_server.mjs's Realtime stand-in) browser suites one after another,
// then stops the server.
// Needs Google Chrome and PGlite (PGLITE_MODULE, see ../db_harness.mjs).
// SHOTS=<dir> also saves screenshots from the layout suite.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '4820';
const SUITES = ['catdb_admin.e2e.mjs', 'catdb_roles.e2e.mjs', 'catdb_layout.e2e.mjs', 'plan_admin.e2e.mjs', 'plan_roles.e2e.mjs', 'plan_layout.e2e.mjs', 'plan_layout_a.e2e.mjs',
  'cards_b2.e2e.mjs', 'studio.e2e.mjs', 'admin_owner.e2e.mjs', 'admin_roles.e2e.mjs', 'orphans.e2e.mjs', 'live_sync.e2e.mjs'];
const env = Object.assign({}, process.env, { BASE: 'http://127.0.0.1:' + PORT });

const server = spawn(process.execPath, [path.join(HERE, 'pg_server.mjs'), PORT], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const stop = () => { try { server.kill('SIGKILL'); } catch (e) { /* gone */ } };
process.on('exit', stop);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start in 60 s')), 60000);
  server.stdout.on('data', (d) => { if (/ready on/.test(String(d))) { clearTimeout(t); res(); } });
  server.on('exit', (c) => { clearTimeout(t); rej(new Error('server exited ' + c)); });
});
let bad = 0;
for (const s of SUITES) {
  const code = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(HERE, s)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let last = '';
    p.stdout.on('data', (d) => { const t = String(d); process.stdout.write(t.split('\n').filter((l) => !/^PASS /.test(l)).join('\n')); last += t; });
    p.on('exit', (c) => { const m = /(\d+) passed, (\d+) failed/.exec(last); console.log(s + ': ' + (m ? m[0] : 'no summary') + ' (exit ' + c + ')'); res(c); });
  });
  if (code) bad++;
}
stop();
process.exit(bad ? 1 : 0);
