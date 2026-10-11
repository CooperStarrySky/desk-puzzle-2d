#!/usr/bin/env node
// tools/leak_test.mjs — the safety check for the submissions inbox.
//
// Run it after setting up Supabase, and again after ANY database change:
//     node tools/leak_test.mjs                 # read/write checks with the public key
//     node tools/leak_test.mjs --send-sample   # also sends one test category
//
// It acts like a stranger who copied the public key out of studio/config.js
// (anyone can) and tries to read, change, or add submissions, admins, the rate
// log, and the private images. Every line must say PASS. Any FAIL means
// answers or emails could leak: stop and fix it before students use the inbox.
//
// Settings come from studio/config.js, or from the environment instead:
//     SUPABASE_URL=https://xxxx.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... node tools/leak_test.mjs
// Needs only node 18+ (built-in fetch). No packages.
//
// --send-sample posts a tiny valid category ("TEST: things that cause
// clubbing") through the real submit function and expects a receipt code.
// Decline it in the inbox afterwards. Run it before turning on Turnstile, or
// it is refused (correctly) for missing the "are you human" check.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SEND = args.includes('--send-sample');
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

// ── Optional: send one sample through the real function ──
if (SEND) {
  const { goodSample } = await import(pathToFileURL(path.join(ROOT, 'supabase', 'tests', 'samples.mjs')).href);
  const res = await call('POST', '/functions/v1/submit', { submission: goodSample(), turnstileToken: '', website: '' }, { Origin: ORIGIN });
  const okReceipt = res.status === 200 && res.json && res.json.ok === true && /^DP-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(res.json.receipt || '');
  result(okReceipt, `sample category accepted by the submit function (${res.status}${res.json ? ': ' + (res.json.receipt || res.json.error || '') : ', ' + res.text.slice(0, 120)})`);
  if (res.status === 404) console.log('     The function is not deployed yet: supabase functions deploy submit --no-verify-jwt');
  const after = await call('GET', '/rest/v1/submissions?select=*&limit=5');
  result(nothing(after), `the sample is still invisible to the public key (${how(after)})`);
  const bad = await call('POST', '/functions/v1/submit', { submission: goodSample() }, { Origin: 'https://not-our-site.example' });
  result(bad.status === 403, `function refuses other websites (${bad.status})`);
  if (okReceipt) console.log(`     Receipt ${res.json.receipt}: find "TEST: things that cause clubbing" in the inbox and Decline it.`);
}

console.log(fails ? `\n${fails} FAIL. Do not open the inbox to students until every line passes.` : '\nAll PASS. The public key can submit but cannot read a single row or image.');
process.exit(fails ? 1 : 0);
