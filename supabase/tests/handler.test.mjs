// node supabase/tests/handler.test.mjs
// Drives supabase/functions/submit/handler.js with a fake Supabase client and a
// fake fetch (for Turnstile). No network. Exit 1 on any failure.
import { createHandler, RATE_PER_HOUR } from '../functions/submit/handler.js';
import { goodSample } from './samples.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ORIGIN = 'https://cooperstarrysky.github.io';

/** Minimal stand-in for the supabase-js calls the handler makes. */
function fakeDb(opts = {}) {
  const st = { rate: [], rows: [], files: new Map(), removed: [], insertCalls: 0 };
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
  const r = await json(await handle(post('x'.repeat(7 * 1024 * 1024 + 10))));
  ok(r.status === 413 && /too big/.test(r.body.error), 'body over 7 MB -> 413 "too big"');
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
  const p = goodSample(); p.kind = 'puzzle';
  const r2 = await json(await handle(post({ submission: p })));
  ok(r2.status === 400 && /not open yet/.test(r2.body.error), 'kind puzzle -> 400 friendly "not open yet"');
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
  ok(row.credit_mode === 'named' && row.credit_name === 'Test Student' && row.credit_line === 'MS2' && row.contact_email === 'test.student@rowan.edu' && row.consent === true && row.kind === 'category', 'row: credit, contact, consent, kind');
  const its = row.payload.items;
  ok(its[2].info.image === `${id}/lung-cancer-info.png` && its[3].scope.image === `${id}/mesothelioma-scope.webp` && !JSON.stringify(row.payload).includes('data:'), 'payload images rewritten to storage paths, no data URIs left');
  ok(db.st.rate.length === 1 && /^[0-9a-f]{64}$/.test(db.st.rate[0].ip_hash) && !JSON.stringify(db.st.rate).includes('203.0.113.9'), 'rate row stores only a hash of the IP');
  const anon = goodSample(); anon.credit = { mode: 'anonymous' }; anon.contact = null;
  await handle(post({ submission: anon }));
  const row2 = db.st.rows[1];
  ok(row2.credit_mode === 'anonymous' && row2.credit_name === null && row2.contact_email === null, 'anonymous with no email -> nulls');
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
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
