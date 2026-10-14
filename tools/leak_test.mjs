#!/usr/bin/env node
// tools/leak_test.mjs — the safety check for the submissions inbox.
//
// Run it after setting up Supabase, and again after ANY database change:
//     node tools/leak_test.mjs                 # read/write checks with the public key
//     node tools/leak_test.mjs --send-sample   # also sends one test category
//     node tools/leak_test.mjs --send-sample=puzzle  # ...and checks full puzzles are refused
//     node tools/leak_test.mjs --send-sample=stats   # sends one test finish to the "record" function
//
// It acts like a stranger who copied the public key out of studio/config.js
// (anyone can) and tries to read, change, or add submissions, admins, the rate
// log, the private images, and the puzzle group's workspace (history, comments,
// votes, drafts, slots, publish jobs). Every line must say PASS. Any FAIL means
// answers or emails could leak: stop and fix it before students use the inbox.
//
// Settings come from studio/config.js, or from the environment instead:
//     SUPABASE_URL=https://xxxx.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... node tools/leak_test.mjs
// Needs only node 18+ (built-in fetch). No packages.
//
// --send-sample posts a tiny valid category ("TEST: things that cause
// clubbing") through the real submit function and expects a receipt code.
// --send-sample=puzzle also checks that a full puzzle and a category with no
// school are refused (full puzzles ended with the multischool release).
// Move the sample to the Trash in the inbox afterwards. Run it before turning on Turnstile, or
// it is refused (correctly) for missing the "are you human" check.
//
// Play stats: the public key may read puzzle_stats (totals only) and nothing
// else. --send-sample=stats posts one finish for a dummy puzzle
// "leak-test-<tomorrow>" with a random browser id and checks that it shows up
// in the totals but not as a readable row. Clean it up afterwards in the SQL
// editor (supabase/SETUP.md, "Play stats").

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SEND_PUZZLE = args.includes('--send-sample=puzzle');
const SEND = SEND_PUZZLE || args.includes('--send-sample');
const SEND_STATS = args.includes('--send-sample=stats');
const ORIGIN = process.env.LEAK_TEST_ORIGIN || 'https://cooperstarrysky.github.io';

function readConfig() {
  const cfgPath = path.join(ROOT, 'studio', 'config.js');
  const box = { window: {} };
  try { vm.runInNewContext(fs.readFileSync(cfgPath, 'utf8'), box, { timeout: 1000 }); } catch (e) { /* fall back to env */ }
  return box.window.DESK_PUZZLE_CONFIG || {};
}
const cfg = readConfig();
const URL_ = String(process.env.SUPABASE_URL || cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || cfg.supabasePublishableKey || cfg.supabaseAnonKey || '').trim();
if (!URL_ || !KEY) {
  console.log('Fill in supabaseUrl and supabasePublishableKey in studio/config.js first (or set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY).');
  process.exit(2);
}
if (/service_role|sb_secret_/.test(KEY) || roleOf(KEY) === 'service_role') {
  console.log('FAIL The key in studio/config.js is a SECRET key. Remove it now, roll (replace) it in Supabase, and use the publishable key.');
  process.exit(1);
}

let fails = 0;
const result = (pass, msg) => { console.log((pass ? 'PASS ' : 'FAIL ') + msg); if (!pass) fails++; };
// Same headers the Studio sends: apikey always; Bearer only for a legacy anon JWT
// (publishable keys are not JWTs and must not be sent as Bearer tokens).
const IS_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(KEY);
const H = Object.assign({ apikey: KEY }, IS_JWT ? { Authorization: 'Bearer ' + KEY } : {});

function roleOf(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).role || ''; } catch (e) { return ''; }
}
async function call(method, p, body, extra) {
  try {
    const r = await fetch(URL_ + p, { method, headers: Object.assign({}, H, body !== undefined ? { 'Content-Type': 'application/json' } : {}, extra || {}),
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, json: null, text: String(e && e.message) }; }
}
// "Nothing came back": refused (4xx) or an empty list. A network error is a FAIL (we learned nothing).
const nothing = (r) => r.status >= 400 || (r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length === 0);
const refused = (r) => r.status >= 400;
const how = (r) => (r.status === 0 ? 'no answer: ' + r.text : r.status + (Array.isArray(r.json) ? ', ' + r.json.length + ' rows' : ''));

console.log(`Leak test against ${URL_} with the public ${IS_JWT ? 'anon (legacy)' : 'publishable'} key only\n`);
const reachable = await call('GET', '/rest/v1/');
if (reachable.status === 0) { console.log('FAIL Could not reach Supabase: ' + reachable.text + '\n(Is the project paused? Open the dashboard and restore it.)'); process.exit(1); }

// ── Tables: read ──
for (const t of ['submissions', 'admins', 'submit_rate']) {
  const r = await call('GET', `/rest/v1/${t}?select=*&limit=5`);
  result(nothing(r), `can't read table ${t} (${how(r)})`);
}
// ── Tables: write ──
let r = await call('POST', '/rest/v1/submissions', { group_name: 'leak test', payload: {}, credit_mode: 'anonymous', consent: true, receipt_code: 'LEAK-' + Date.now() }, { Prefer: 'return=minimal' });
result(refused(r), `can't add a submission directly (${how(r)})`);
r = await call('POST', '/rest/v1/admins', { email: 'leak-test@example.com' }, { Prefer: 'return=minimal' });
result(refused(r), `can't add itself to the admins list (${how(r)})`);
r = await call('PATCH', '/rest/v1/submissions?id=not.is.null', { status: 'used' }, { Prefer: 'return=representation' });
result(nothing(r), `can't change submissions (${how(r)})`);
r = await call('DELETE', '/rest/v1/submissions?id=not.is.null', undefined, { Prefer: 'return=representation' });
result(nothing(r), `can't delete submissions (${how(r)})`);
r = await call('POST', '/rest/v1/submit_rate', { ip_hash: 'leak-test' }, { Prefer: 'return=minimal' });
result(refused(r), `can't write the rate-limit log (${how(r)})`);

// ── Private image bucket ──
r = await call('POST', '/storage/v1/object/list/submissions', { prefix: '', limit: 10 });
result(nothing(r), `can't list images in the submissions bucket (${how(r)})`);
r = await call('GET', '/storage/v1/bucket/submissions');
result(!(r.json && r.json.public === true), `bucket is not public (${r.status}${r.json && 'public' in r.json ? ', public=' + r.json.public : ''})`);
r = await call('GET', '/storage/v1/object/public/submissions/leak-test-probe.webp');
result(refused(r), `no public links into the bucket (${how(r)})`);
r = await call('GET', '/storage/v1/object/submissions/leak-test-probe.webp');
result(refused(r), `can't download from the bucket (${how(r)})`);
r = await fetch(URL_ + `/storage/v1/object/submissions/leak-test-${Date.now()}.webp`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'image/webp' }, H), body: new Uint8Array([82, 73, 70, 70]) })
  .then(async (x) => ({ status: x.status, text: await x.text(), json: null }), (e) => ({ status: 0, text: String(e.message), json: null }));
result(refused(r), `can't upload into the bucket (${how(r)})`);

// ── Play stats: rows private, totals public ──
for (const t of ['plays', 'record_rate']) {
  r = await call('GET', `/rest/v1/${t}?select=*&limit=5`);
  result(nothing(r), `can't read table ${t} (${how(r)})`);
}
r = await call('POST', '/rest/v1/plays', { puzzle_id: 'leak-test-2099-01-01', anon_id: '00000000-0000-4000-8000-000000000000', outcome: 'won', mistakes: 0, guesses: 4 }, { Prefer: 'return=minimal' });
result(refused(r), `can't add a play directly (${how(r)})`);
r = await call('POST', '/rest/v1/record_rate', { ip_hash: 'leak-test' }, { Prefer: 'return=minimal' });
result(refused(r), `can't write the stats rate-limit log (${how(r)})`);
r = await call('POST', '/rest/v1/puzzle_stats', { puzzle_id: 'leak-test-2099-01-01', plays: 999 }, { Prefer: 'return=minimal' });
result(refused(r), `can't add totals directly (${how(r)})`);
r = await call('PATCH', '/rest/v1/puzzle_stats?puzzle_id=not.is.null', { plays: 999 }, { Prefer: 'return=representation' });
result(nothing(r), `can't change totals (${how(r)})`);
r = await call('DELETE', '/rest/v1/puzzle_stats?puzzle_id=not.is.null', undefined, { Prefer: 'return=representation' });
result(nothing(r), `can't delete totals (${how(r)})`);
const totals = await call('GET', '/rest/v1/puzzle_stats?select=*&limit=50');
result(totals.status === 200 && Array.isArray(totals.json), `totals table puzzle_stats is readable (${how(totals)})`);
if (totals.status === 404) console.log('     puzzle_stats is missing: run npx supabase db push first.');
const cols = new Set((totals.json || []).flatMap((row) => Object.keys(row)));
result(!cols.has('anon_id'), `totals hold no browser ids (columns: ${cols.size ? [...cols].join(', ') : 'no rows yet'})`);
r = await call('GET', '/rest/v1/puzzle_stats?select=anon_id&limit=1');
result(r.status >= 400, `asking puzzle_stats for anon_id is refused (${how(r)})`);

// ── Workspace (history, comments, votes, drafts, publish jobs): admins only ──
const NOID = '00000000-0000-4000-8000-000000000000';
const WS_ROWS = {
  review_events: { submission_id: NOID, action: 'trash' },
  comments: { target_type: 'submission', target_id: NOID, body: 'leak test' },
  votes: { submission_id: NOID },
  drafts: { title: 'leak test' },
  draft_slots: { draft_id: NOID, tier: 1, custom_group: { name: 'leak test' } },
  draft_events: { draft_id: NOID, draft_title: 'leak test', action: 'create' },
  publish_jobs: { draft_id: NOID, kind: 'now' },
  activity: { action: 'vote' },
};
for (const [t, row] of Object.entries(WS_ROWS)) {
  r = await call('GET', `/rest/v1/${t}?select=*&limit=5`);
  result(nothing(r), `can't read ${t} (${how(r)})`);
  if (r.status === 404) console.log(`     ${t} is missing: the workspace migration is not applied yet.`);
  r = await call('POST', `/rest/v1/${t}`, row, { Prefer: 'return=minimal' });
  result(refused(r), `can't add to ${t} (${how(r)})`);
}
r = await call('PATCH', '/rest/v1/drafts?id=not.is.null', { status: 'published' }, { Prefer: 'return=representation' });
result(nothing(r), `can't change drafts (${how(r)})`);
r = await call('PATCH', '/rest/v1/publish_jobs?id=not.is.null', { state: 'done' }, { Prefer: 'return=representation' });
result(nothing(r), `can't move publish jobs along (${how(r)})`);
r = await call('PATCH', '/rest/v1/admins?email=not.is.null', { display_name: 'leak test' }, { Prefer: 'return=representation' });
result(nothing(r), `can't rename admins (${how(r)})`);
r = await call('POST', '/rest/v1/rpc/swap_draft_slots', { p_draft_id: NOID, p_tier_a: 1, p_tier_b: 2 });
result(refused(r), `can't call swap_draft_slots (${how(r)})`);

// ── Multiple schools (20261013120000_multischool.sql): members only ──
const MS_ROWS = {
  schools: { slug: 'leak-test', name: 'Leak test' },
  site_owners: { email: 'leak@test.example' },
  members: { email: 'leak@test.example', school: 'cmsru', role: 'lead' },
  member_events: { school: 'cmsru', target_email: 'leak@test.example', action: 'member_add' },
  submission_edits: { submission_id: NOID, editor_email: 'leak@test.example', path: 'name' },
  category_uses: { submission_id: NOID, school: 'cmsru', puzzle_id: 'leak-test-2099-01-01' },
  school_settings: { school: 'leak-test' },
  site_settings: { trash_retention_days: 1 },
  category_usage: { submission_id: NOID },
  admins_pre_multischool: { email: 'leak@test.example' },
};
for (const [t, row] of Object.entries(MS_ROWS)) {
  r = await call('GET', `/rest/v1/${t}?select=*&limit=5`);
  result(nothing(r), `can't read ${t} (${how(r)})`);
  if (r.status === 404 && t !== 'admins_pre_multischool') console.log(`     ${t} is missing: the multischool migration is not applied yet.`);
  r = await call('POST', `/rest/v1/${t}`, row, { Prefer: 'return=minimal' });
  result(refused(r), `can't add to ${t} (${how(r)})`);
}
r = await call('PATCH', '/rest/v1/site_settings?id=not.is.null', { trash_retention_days: 1 }, { Prefer: 'return=representation' });
result(nothing(r), `can't change site settings (${how(r)})`);
const MS_RPCS = {
  add_member: { p_email: 'leak@test.example', p_school: 'cmsru', p_role: 'lead' },
  change_role: { p_email: 'leak@test.example', p_school: 'cmsru', p_role: 'lead' },
  move_school: { p_email: 'leak@test.example', p_from: 'cmsru', p_to: 'cmsru' },
  set_member_active: { p_email: 'leak@test.example', p_school: 'cmsru', p_active: true },
  set_my_profile: { p_display_name: 'leak', p_color: null },
  trash_submission: { p_id: NOID, p_reason: 'leak test' },
  restore_submission: { p_id: NOID },
  edit_submission: { p_id: NOID, p_patch: { name: 'leak test' } },
  undo_submission_edit: { p_edit_id: NOID },
  approve_draft: { p_draft_id: NOID },
  unapprove_draft: { p_draft_id: NOID },
  other_school_releases: { p_from: '2026-01-01', p_to: '2026-12-31' },
  member_names: {},
  add_school: { p_slug: 'leak-test', p_name: 'Leak test', p_lead_email: 'leak@test.example' },
  people_sign_ins: {},
};
for (const [fn, body] of Object.entries(MS_RPCS)) {
  r = await call('POST', `/rest/v1/rpc/${fn}`, body);
  result(r.status >= 400 || nothing(r), `can't call ${fn} (${how(r)})`);
}

// The Studio's "Your school" list is public on purpose: active schools' short
// code and name, nothing more.
r = await call('POST', '/rest/v1/rpc/active_schools', {});
{
  const rows = Array.isArray(r.json) ? r.json : null;
  const shapeOk = !!rows && rows.every((x) => Object.keys(x).sort().join(',') === 'name,slug');
  result(r.status === 200 && shapeOk, `active_schools gives only slug + name (${r.status === 200 && rows ? rows.length + ' school(s): ' + rows.map((x) => x.slug).join(', ') : how(r)})`);
  if (r.status === 404) console.log('     active_schools is missing: the multischool migration is not applied yet.');
}

// ── Optional: send one sample through the real function ──
if (SEND) {
  const { goodSample, goodPuzzleSample } = await import(pathToFileURL(path.join(ROOT, 'supabase', 'tests', 'samples.mjs')).href);
  const res = await call('POST', '/functions/v1/submit', { submission: Object.assign(goodSample(), { school: 'cmsru' }), turnstileToken: '', website: '' }, { Origin: ORIGIN });
  const okReceipt = res.status === 200 && res.json && res.json.ok === true && /^DP-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(res.json.receipt || '');
  result(okReceipt, `sample category accepted by the submit function (${res.status}${res.json ? ': ' + (res.json.receipt || res.json.error || '') : ', ' + res.text.slice(0, 120)})`);
  if (res.status === 404) console.log('     The function is not deployed yet: npx supabase functions deploy submit --no-verify-jwt --use-api');
  if (SEND_PUZZLE) {
    // Full puzzles are no longer accepted (categories only): expect a clear refusal.
    const pzRes = await call('POST', '/functions/v1/submit', { submission: Object.assign(goodPuzzleSample(), { school: 'cmsru' }), turnstileToken: '', website: '' }, { Origin: ORIGIN });
    const refusedPz = pzRes.status === 400 && pzRes.json && pzRes.json.ok === false && /one category/i.test(pzRes.json.error || '');
    result(refusedPz, `full puzzle refused with a plain message (${pzRes.status}${pzRes.json ? ': ' + (pzRes.json.error || pzRes.json.receipt || '') : ''})`);
    const noSchool = await call('POST', '/functions/v1/submit', { submission: goodSample(), turnstileToken: '', website: '' }, { Origin: ORIGIN });
    result(noSchool.status === 400 && noSchool.json && /school/i.test(noSchool.json.error || ''), `category without a school refused (${noSchool.status})`);
  }
  const after = await call('GET', '/rest/v1/submissions?select=*&limit=5');
  result(nothing(after), `the sample is still invisible to the public key (${how(after)})`);
  const bad = await call('POST', '/functions/v1/submit', { submission: goodSample() }, { Origin: 'https://not-our-site.example' });
  result(bad.status === 403, `function refuses other websites (${bad.status})`);
  if (okReceipt) console.log(`     Receipt ${res.json.receipt}: find "TEST: things that cause clubbing" in the Category database and move it to the Trash.`);
}

if (SEND_STATS) {
  const day = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const pid = 'leak-test-' + day;
  const anon = crypto.randomUUID();
  const fin = { event: 'finish', puzzleId: pid, anonId: anon, outcome: 'won', mistakes: 1, guesses: 5, hints: { labels: false, seeds: false, category: false }, casual: false };
  let res = await call('POST', '/functions/v1/record', fin, { Origin: ORIGIN });
  result(res.status === 200 && res.json && res.json.ok === true, `sample finish accepted by the record function (${res.status}${res.json ? ': ' + (res.json.error || 'ok') : ', ' + res.text.slice(0, 120)})`);
  if (res.status === 404) console.log('     The function is not deployed yet: npx supabase functions deploy record --no-verify-jwt --use-api');
  res = await call('POST', '/functions/v1/record', { event: 'rate', puzzleId: pid, anonId: anon, rating: 3 }, { Origin: ORIGIN });
  result(res.status === 200 && res.json && res.json.ok === true, `sample rating accepted (${res.status})`);
  res = await call('GET', `/rest/v1/puzzle_stats?select=*&puzzle_id=eq.${pid}`);
  const row = Array.isArray(res.json) ? res.json[0] : null;
  result(!!row && row.plays >= 1 && row.rating_n >= 1, `the sample shows up in the totals (${row ? 'plays=' + row.plays + ', rating_n=' + row.rating_n : how(res)})`);
  res = await call('GET', `/rest/v1/plays?select=*&puzzle_id=eq.${pid}`);
  result(nothing(res), `the sample row itself stays private (${how(res)})`);
  res = await call('POST', '/functions/v1/record', Object.assign({}, fin, { puzzleId: 'leak-test-2026-10-11' }), { Origin: ORIGIN });
  result(res.status === 400, `puzzles released on or before Oct 11, 2026 are refused (${res.status})`);
  res = await call('POST', '/functions/v1/record', fin, { Origin: 'https://not-our-site.example' });
  result(res.status === 403, `record refuses other websites (${res.status})`);
  console.log(`     Clean-up (SQL editor): delete from public.plays where puzzle_id like 'leak-test-%'; delete from public.puzzle_stats where puzzle_id like 'leak-test-%';`);
}

console.log(fails ? `\n${fails} FAIL. Do not open the inbox to students until every line passes.` : '\nAll PASS. The public key can submit and read play totals, but cannot read a single submission, play row, or image.');
process.exit(fails ? 1 : 0);
