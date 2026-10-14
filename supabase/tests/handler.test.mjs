// node supabase/tests/handler.test.mjs
// Drives supabase/functions/submit/handler.js with a fake Supabase client and a
// fake fetch (for Turnstile). No network. Exit 1 on any failure.
import { createHandler, RATE_PER_HOUR, CLIENT_RATE_PER_HOUR, pickServerKey } from '../functions/submit/handler.js';
import { goodSample as rawSample, goodSampleV2, goodPuzzleSample } from './samples.mjs';

// The Studio sends the school with every category since the multischool release.
const goodSample = () => Object.assign(rawSample(), { school: 'cmsru' });

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ORIGIN = 'https://cooperstarrysky.github.io';

/** Minimal stand-in for the supabase-js calls the handler makes. */
function fakeDb(opts = {}) {
  const st = { rate: [], rows: [], files: new Map(), removed: [], insertCalls: 0,
    schools: [{ slug: 'cmsru', status: 'active' }, { slug: 'pinebrook', status: 'setup' }], schoolReads: 0 };
  const table = (name) => {
    const q = { name, filters: [], op: 'select' };
    const api = {
      select(_c, o) { q.op = 'select'; q.count = o && o.count; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
      gte(k, v) { q.filters.push((r) => r[k] >= v); return api; },
      lt(k, v) { q.filters.push((r) => r[k] < v); return api; },
      insert(row) {
        if (name === 'submit_rate') { st.rate.push(row); return Promise.resolve({ error: null }); }
        st.insertCalls++;
        if (opts.insertError) return Promise.resolve({ error: { message: 'db down', code: 'XX000' } });
        if (opts.clashOnce && st.insertCalls === 1) return Promise.resolve({ error: { message: 'dup', code: '23505' } });
        st.rows.push(JSON.parse(JSON.stringify(row)));
        return Promise.resolve({ error: null });
      },
      then(res, rej) {
        if (name === 'schools') {
          st.schoolReads++;
          if (opts.schoolsError) return Promise.resolve({ data: null, error: { message: 'db down' } }).then(res, rej);
          return Promise.resolve({ data: st.schools.filter((r) => q.filters.every((f) => f(r))), error: null }).then(res, rej);
        }
        const src = name === 'submit_rate' ? st.rate : st.rows;
        const hit = src.filter((r) => q.filters.every((f) => f(r)));
        if (q.op === 'delete') { for (const r of hit) src.splice(src.indexOf(r), 1); return Promise.resolve({ error: null }).then(res, rej); }
        return Promise.resolve({ count: hit.length, data: null, error: null }).then(res, rej);
      },
    };
    return api;
  };
  return {
    st,
    from: table,
    storage: {
      from: (bucket) => ({
        upload: async (p, bytes, o) => {
          if (opts.uploadFailAt && st.files.size + 1 === opts.uploadFailAt) return { error: { message: 'storage full' } };
          st.files.set(bucket + '/' + p, { bytes, type: o.contentType }); return { data: { path: p }, error: null };
        },
        remove: async (paths) => { paths.forEach((p) => { st.removed.push(p); st.files.delete(bucket + '/' + p); }); return { error: null }; },
      }),
    },
  };
}

function setup(envVars = {}, dbOpts = {}, turnstileOk = true) {
  const db = fakeDb(dbOpts);
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: String(init.body) }); return { json: async () => ({ success: turnstileOk }) }; };
  let n = 0;
  const handle = createHandler({ env: (k) => envVars[k], supabase: db, fetch,
    randomUUID: () => '11111111-2222-3333-4444-55555555555' + (n++), now: () => new Date('2026-10-10T12:00:00Z') });
  return { handle, db, calls };
}
const post = (body, headers = {}) => new Request('https://x.supabase.co/functions/v1/submit', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, headers),
});
const json = async (r) => ({ status: r.status, body: await r.json(), r });

// CORS preflight
{
  const { handle } = setup();
  const r = await handle(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  ok(r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN && /apikey/.test(r.headers.get('access-control-allow-headers')), 'preflight from the site -> 204 with CORS headers');
  const r2 = await handle(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'http://localhost:4607' } }));
  ok(r2.status === 204, 'preflight from localhost:4607 allowed by default');
  const r3 = await handle(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  ok(r3.status === 403 && !r3.headers.get('access-control-allow-origin'), 'preflight from another site -> 403, no CORS header');
}
// Bad origin, custom ALLOWED_ORIGINS
{
  const { handle, db } = setup();
  const r = await json(await handle(post({ submission: goodSample() }, { origin: 'https://evil.example' })));
  ok(r.status === 403 && r.body.ok === false && /Desk Puzzle website/.test(r.body.error) && db.st.rows.length === 0, 'POST from another site -> 403 friendly error, nothing stored');
  const s2 = setup({ ALLOWED_ORIGINS: 'https://a.test' });
  const r2 = await s2.handle(post({ submission: goodSample() }));
  ok(r2.status === 403, 'ALLOWED_ORIGINS env replaces the default list');
}
// Honeypot
{
  const { handle, db } = setup();
  const r = await json(await handle(post({ submission: goodSample(), website: 'http://spam.example' })));
  ok(r.status === 400 && /automatically/.test(r.body.error) && db.st.rows.length === 0 && db.st.rate.length === 0, 'honeypot filled -> 400, nothing stored');
}
// Junk body, wrong method, oversize body
{
  const { handle } = setup();
  ok((await handle(post('{not json'))).status === 400, 'not JSON -> 400');
  ok((await handle(new Request('https://x/f', { method: 'GET', headers: { origin: ORIGIN } }))).status === 405, 'GET -> 405');
  const r = await json(await handle(post('x'.repeat(9 * 1024 * 1024 + 10))));
  ok(r.status === 413 && /too big/.test(r.body.error) && /9 MB max/.test(r.body.error), 'body over 9 MB -> 413 "too big"');
  const r2 = await json(await handle(post({ submission: goodSample(), pad: 'x'.repeat(7 * 1024 * 1024) })));
  ok(r2.status === 413 && /7 MB max/.test(r2.body.error), 'category body over 7 MB -> 413 (category cap unchanged)');
  const s3 = setup();
  const r3 = await json(await s3.handle(post({ submission: goodPuzzleSample(), pad: 'x'.repeat(8 * 1024 * 1024) })));
  ok(r3.status === 400 && /one category at a time/.test(r3.body.error) && s3.db.st.rows.length === 0, 'old Studio sending an 8 MB full puzzle gets the plain "one category" answer, not "too big"');
}
// Turnstile
{
  const { handle, calls, db } = setup({ TURNSTILE_SECRET: 's3cret' }, {}, false);
  const r0 = await json(await handle(post({ submission: goodSample() })));
  ok(r0.status === 400 && /are you human/.test(r0.body.error) && calls.length === 0, 'secret set, no token -> 400 asks for the check');
  const r = await json(await handle(post({ submission: goodSample(), turnstileToken: 'tok' })));
  ok(r.status === 403 && r.body.retryTurnstile === true && db.st.rows.length === 0, 'turnstile says no -> 403, nothing stored');
  ok(calls.length === 1 && /secret=s3cret/.test(calls[0].body) && /remoteip=203\.0\.113\.9/.test(calls[0].body), 'siteverify called with secret, token, client IP');
  const good = setup({ TURNSTILE_SECRET: 's3cret' }, {}, true);
  const r2 = await json(await good.handle(post({ submission: goodSample(), turnstileToken: 'tok' })));
  ok(r2.status === 200 && r2.body.ok, 'turnstile passes -> stored');
  const off = setup({}, {}, false);
  const r3 = await json(await off.handle(post({ submission: goodSample() })));
  ok(r3.status === 200 && off.calls.length === 0, 'no secret -> turnstile skipped');
}
// Validation error
{
  const { handle, db } = setup();
  const s = goodSample(); s.group.name = ''; s.kind = 'category';
  const r = await json(await handle(post({ submission: s })));
  ok(r.status === 400 && /the category has no name/.test(r.body.error) && Array.isArray(r.body.problems) && db.st.rows.length === 0, 'invalid category -> 400 with the problem');
  const sl = Object.assign(goodSampleV2(), { school: 'cmsru' }); sl.group.items[3].info.image = sl.group.items[2].info.image;
  const r5 = await json(await handle(post({ submission: sl })));
  ok(r5.status === 400 && /microscope slide, so its picture goes under the microscope/.test(r5.body.error) && db.st.files.size === 0, 'v2 slide with info.image -> 400 (rejected, not stripped)');
}
// Oversize image
{
  const { handle, db } = setup();
  const s = goodSample();
  s.group.items[2].info.image = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(710 * 1024)]).toString('base64');
  const r = await json(await handle(post({ submission: s })));
  ok(r.status === 400 && /too big/.test(r.body.error) && db.st.files.size === 0, 'image over 700 KB -> 400, nothing uploaded');
}
// Success path
{
  const { handle, db } = setup();
  const r = await json(await handle(post({ submission: goodSample(), website: '' })));
  ok(r.status === 200 && r.body.ok === true && /^DP-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.body.receipt), 'good category -> 200 with receipt ' + r.body.receipt);
  ok(r.r.headers.get('access-control-allow-origin') === ORIGIN, 'success reply carries CORS header');
  const files = [...db.st.files.keys()].sort();
  const id = '11111111-2222-3333-4444-555555555550';
  ok(JSON.stringify(files) === JSON.stringify([`submissions/${id}/lung-cancer-info.png`, `submissions/${id}/mesothelioma-info.webp`, `submissions/${id}/mesothelioma-scope.webp`]), 'uploads go to <uuid>/<itemid>-info|scope.<ext>');
  ok(db.st.files.get(`submissions/${id}/lung-cancer-info.png`).type === 'image/png', 'upload content type set');
  const row = db.st.rows[0];
  ok(row && row.id === id && row.receipt_code === r.body.receipt && row.group_name === 'TEST: things that cause clubbing' && row.suggested_tier === 2, 'row: id, receipt, group name, tier');
  ok(row.credit_mode === 'named' && row.credit_name === 'Test Student' && row.credit_line === 'MS2' && row.contact_email === 'test.student@rowan.edu' && row.consent === true && row.kind === 'category' && row.school === 'cmsru', 'row: credit, contact, consent, kind, school');
  const its = row.payload.items;
  ok(its[2].info.image === `${id}/lung-cancer-info.png` && its[3].scope.image === `${id}/mesothelioma-scope.webp` && !JSON.stringify(row.payload).includes('data:'), 'payload images rewritten to storage paths, no data URIs left');
  ok(db.st.rate.length === 1 && /^[0-9a-f]{64}$/.test(db.st.rate[0].ip_hash) && !JSON.stringify(db.st.rate).includes('203.0.113.9'), 'rate row stores only a hash of the IP');
  const anon = goodSample(); anon.credit = { mode: 'anonymous' }; anon.contact = null;
  await handle(post({ submission: anon }));
  const row2 = db.st.rows[1];
  ok(row2.credit_mode === 'anonymous' && row2.credit_name === null && row2.contact_email === null, 'anonymous with no email -> nulls');
}
// Full puzzles are refused (categories only since the multischool release)
{
  const { handle, db } = setup();
  const r = await json(await handle(post({ submission: Object.assign(goodPuzzleSample(), { school: 'cmsru' }) })));
  ok(r.status === 400 && r.body.ok === false && /Full puzzles can’t be sent any more/.test(r.body.error) && /one category at a time/.test(r.body.error), 'full puzzle -> 400 with a plain "one category at a time" message');
  ok(db.st.rows.length === 0 && db.st.files.size === 0 && db.st.rate.length === 0, 'full puzzle: nothing stored and no rate-limit slot used');
  const bad = goodPuzzleSample(); bad.puzzle.groups.pop();
  const r2 = await json(await handle(post({ submission: bad })));
  ok(r2.status === 400 && /one category at a time/.test(r2.body.error), 'even a broken full puzzle gets the same plain answer (not a list of puzzle problems)');
}
// School: required, and must be an active school
{
  const s1 = setup();
  const r1 = await json(await s1.handle(post({ submission: rawSample() })));
  ok(r1.status === 400 && /pick your school/i.test(r1.body.error) && s1.db.st.rows.length === 0, 'no school -> 400 asks to pick one, nothing stored');
  const r2 = await json(await s1.handle(post({ submission: Object.assign(rawSample(), { school: 'Not a school!' }) })));
  ok(r2.status === 400 && /recognize that school/.test(r2.body.error) && s1.db.st.schoolReads === 0, 'malformed school -> 400 without asking the database');
  const r3 = await json(await s1.handle(post({ submission: Object.assign(rawSample(), { school: 'harvard' }) })));
  ok(r3.status === 400 && /recognize that school/.test(r3.body.error) && s1.db.st.rows.length === 0, 'unknown school -> 400, nothing stored');
  const r4 = await json(await s1.handle(post({ submission: Object.assign(rawSample(), { school: 'pinebrook' }) })));
  ok(r4.status === 400 && s1.db.st.rows.length === 0 && s1.db.st.files.size === 0, 'school still in setup -> 400 (not in the Studio list yet)');
  const r5 = await json(await s1.handle(post({ submission: Object.assign(rawSample(), { school: ' CMSRU ' }) })));
  ok(r5.status === 200 && s1.db.st.rows[0].school === 'cmsru', 'school code tidied (case, spaces) and stored on the row');
  const s2 = setup({}, { schoolsError: true });
  const r6 = await json(await s2.handle(post({ submission: goodSample() })));
  ok(r6.status === 503 && s2.db.st.rows.length === 0 && s2.db.st.files.size === 0, 'school lookup fails -> 503, nothing stored');
}
// Category success (v2) and notes
{
  const v2 = setup();
  const r2 = await json(await v2.handle(post({ submission: Object.assign(goodSampleV2(), { school: 'cmsru' }) })));
  const row2 = v2.db.st.rows[0];
  ok(r2.status === 200 && row2.kind === 'category' && row2.suggested_tier === 2 && row2.payload.submissionVersion === 2 && row2.payload.items[3].scope.image === '11111111-2222-3333-4444-555555555550/clubbing-slide-scope.webp',
    'v2 category -> stored like v1 (no group prefix in paths)');
  const vn = setup();
  const noted = Object.assign(goodSampleV2(), { school: 'cmsru' }); noted.group.items[0].note = 'Chronic airway dilation.';
  const rn = await json(await vn.handle(post({ submission: noted })));
  ok(rn.status === 200 && vn.db.st.rows[0].payload.items[0].note === 'Chronic airway dilation.' && !('note' in vn.db.st.rows[0].payload.items[1]), 'v2 clue results note stored in the payload as sent');
  const v1 = setup();
  await v1.handle(post({ submission: goodSample() }));
  ok(v1.db.st.rows[0].payload.submissionVersion === 1 && v1.db.st.rows[0].payload.items[2].info.title === 'Fingertips', 'v1 category still OK, its titles kept');
}
// Rate limit
{
  const { handle, db } = setup();
  for (let i = 0; i < RATE_PER_HOUR; i++) await handle(post({ submission: goodSample() }));
  const r = await json(await handle(post({ submission: goodSample() })));
  ok(db.st.rows.length === RATE_PER_HOUR && r.status === 429 && /wait/.test(r.body.error), `${RATE_PER_HOUR + 1}th send in an hour -> 429`);
  const other = await handle(post({ submission: goodSample() }, { 'x-forwarded-for': '198.51.100.7' }));
  ok(other.status === 200, 'a different IP is not affected');
  db.st.rate.forEach((x) => { x.at = '2026-10-10T10:30:00.000Z'; });
  const later = await handle(post({ submission: goodSample() }));
  ok(later.status === 200, 'old attempts (over an hour) no longer count');
  db.st.rate.forEach((x) => { x.at = '2026-10-08T10:00:00.000Z'; });
  await handle(post({ submission: goodSample() }));
  ok(db.st.rate.length === 1, 'rows older than a day are pruned');
}
// Per-browser limit (clientId), many students behind one campus IP
{
  const { handle, db } = setup();
  ok(RATE_PER_HOUR === 40 && CLIENT_RATE_PER_HOUR === 5, 'limits: 40 per IP, 5 per browser, per hour');
  const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  for (let i = 0; i < CLIENT_RATE_PER_HOUR; i++) await handle(post({ submission: goodSample(), clientId: A }));
  const r = await json(await handle(post({ submission: goodSample(), clientId: A })));
  ok(db.st.rows.length === CLIENT_RATE_PER_HOUR && r.status === 429, `${CLIENT_RATE_PER_HOUR + 1}th send from one browser -> 429`);
  const rb = await handle(post({ submission: goodSample(), clientId: B }));
  ok(rb.status === 200, 'another browser on the same IP is not affected');
  const rn = await handle(post({ submission: goodSample() }));
  ok(rn.status === 200, 'no clientId -> only the IP limit applies');
  const rm = await handle(post({ submission: goodSample(), clientId: 'bad id!' }));
  ok(rm.status === 200, 'malformed clientId is ignored (IP limit only)');
  ok(!JSON.stringify(db.st.rate).includes(A) && db.st.rate.every((x) => /^[0-9a-f]{64}$/.test(x.ip_hash)), 'clientId stored only as a salted hash in submit_rate.ip_hash');
  const ipRows = db.st.rate.filter((x) => x.ip_hash === db.st.rate[0].ip_hash).length;
  ok(ipRows === CLIENT_RATE_PER_HOUR + 3, 'every accepted attempt also counts toward the IP limit; refused ones do not (' + ipRows + ')');
  const shared = setup();
  for (let i = 0; i < RATE_PER_HOUR; i++) await shared.handle(post({ submission: goodSample(), clientId: 'student-' + String(i).padStart(4, '0') }));
  const r41 = await json(await shared.handle(post({ submission: goodSample(), clientId: 'student-new1' })));
  ok(shared.db.st.rows.length === RATE_PER_HOUR && r41.status === 429, `${RATE_PER_HOUR} different browsers on one IP fill the IP limit; the next -> 429`);
}
// Cleanup on failure
{
  const { handle, db } = setup({}, { insertError: true });
  const r = await json(await handle(post({ submission: goodSample() })));
  ok(r.status === 500 && /nothing was kept/.test(r.body.error) && db.st.files.size === 0 && db.st.removed.length === 3, 'insert fails -> 500, all 3 uploaded images removed');
  const s2 = setup({}, { uploadFailAt: 2 });
  const r2 = await json(await s2.handle(post({ submission: goodSample() })));
  ok(r2.status === 500 && s2.db.st.files.size === 0 && s2.db.st.removed.length === 1 && s2.db.st.rows.length === 0, 'second upload fails -> first image removed, no row');
  const s3 = setup({}, { clashOnce: true });
  const r3 = await json(await s3.handle(post({ submission: goodSample() })));
  ok(r3.status === 200 && s3.db.st.rows.length === 1 && s3.db.st.rows[0].receipt_code === r3.body.receipt, 'receipt code clash -> retried with a new code');
}
// Server key choice (new secret keys first, legacy service_role last)
{
  const k = (o) => pickServerKey((n) => o[n]);
  ok(k({ DP_SECRET_KEY: 'sb_secret_a', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x.y' }) === 'sb_secret_a', 'pickServerKey prefers DP_SECRET_KEY');
  ok(k({ SUPABASE_SECRET_KEY: 'sb_secret_b', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x.y' }) === 'sb_secret_b', 'pickServerKey then SUPABASE_SECRET_KEY');
  ok(k({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_c"}', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x.y' }) === 'sb_secret_c', 'pickServerKey then SUPABASE_SECRET_KEYS JSON');
  ok(k({ SUPABASE_SECRET_KEYS: 'garbage', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x.y' }) === 'eyJ.x.y', 'pickServerKey falls back to the legacy service_role key');
}
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
