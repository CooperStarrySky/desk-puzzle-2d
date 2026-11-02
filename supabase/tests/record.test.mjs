// node supabase/tests/record.test.mjs
// Drives supabase/functions/record/handler.js with a fake Supabase client. No network.
import { createHandler, RATE_PER_HOUR, eligibility, pickServerKey } from '../functions/record/handler.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ORIGIN = 'https://cooperstarrysky.github.io';
const NOW = new Date('2026-10-20T15:00:00Z');
const ANON = '3f1c2b4a-9d8e-4f00-a1b2-c3d4e5f60718';
const PID = 'cases-2026-10-18';

/** Stand-in for the supabase-js calls the handler makes (one plays row per puzzle+anon). */
function fakeDb(opts = {}) {
  const st = { record_rate: [], submit_rate: [], plays: [] };
  const table = (name) => {
    const q = { op: 'select', filters: [], patch: null, wantRows: false };
    const api = {
      select(_c, o) { if (q.op === 'update') q.wantRows = true; else { q.op = 'select'; q.head = o && o.head; } return api; },
      delete() { q.op = 'delete'; return api; },
      update(p) { q.op = 'update'; q.patch = p; return api; },
      eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
      gte(k, v) { q.filters.push((r) => r[k] >= v); return api; },
      lt(k, v) { q.filters.push((r) => r[k] < v); return api; },
      insert(row) {
        if (opts.down) return Promise.resolve({ error: { message: 'down', code: 'XX000' } });
        if (name === 'plays' && st.plays.some((r) => r.puzzle_id === row.puzzle_id && r.anon_id === row.anon_id)) {
          return Promise.resolve({ error: { message: 'duplicate key', code: '23505' } });
        }
        st[name].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      },
      then(res, rej) {
        if (opts.down) return Promise.resolve({ error: { message: 'down' } }).then(res, rej);
        const src = st[name];
        const hit = src.filter((r) => q.filters.every((f) => f(r)));
        if (q.op === 'delete') { for (const r of hit) src.splice(src.indexOf(r), 1); return Promise.resolve({ error: null }).then(res, rej); }
        if (q.op === 'update') { hit.forEach((r) => Object.assign(r, q.patch)); return Promise.resolve({ data: hit.map((r) => ({ puzzle_id: r.puzzle_id })), error: null }).then(res, rej); }
        return Promise.resolve({ count: hit.length, data: null, error: null }).then(res, rej);
      },
    };
    return api;
  };
  return { st, from: table };
}
function setup(envVars = {}, dbOpts = {}, now = NOW) {
  const db = fakeDb(dbOpts);
  return { db, handle: createHandler({ env: (k) => envVars[k], supabase: db, now: () => now }) };
}
const finish = (o = {}) => Object.assign({ event: 'finish', puzzleId: PID, anonId: ANON, outcome: 'won', mistakes: 1, guesses: 5,
  hints: { labels: true, seeds: false, category: false }, casual: false }, o);
const post = (body, headers = {}) => new Request('https://x.supabase.co/functions/v1/record', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, headers),
});
const json = async (r) => ({ status: r.status, body: await r.json() });

// ── Origin ──
{
  const { handle } = setup();
  let r = await handle(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  ok(r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN, 'preflight from the site -> 204 + CORS');
  r = await handle(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  ok(r.status === 403 && !r.headers.get('access-control-allow-origin'), 'preflight from another site -> 403');
  r = await json(await handle(post(finish(), { origin: 'https://evil.example' })));
  ok(r.status === 403, 'POST from another site -> 403');
  r = await json(await handle(post(finish(), { origin: '' })));
  ok(r.status === 403, 'POST with no origin -> 403');
  const c = setup({ ALLOWED_ORIGINS: 'https://a.example, http://localhost:9999/' });
  r = await json(await c.handle(post(finish(), { origin: 'http://localhost:9999' })));
  ok(r.status === 200, 'custom ALLOWED_ORIGINS honoured');
  r = await c.handle(new Request('https://x/f', { method: 'GET', headers: { origin: ORIGIN } }));
  ok(r.status === 403, 'default origin not allowed when ALLOWED_ORIGINS replaces it');
  r = await setup().handle(new Request('https://x/f', { method: 'GET', headers: { origin: ORIGIN } }));
  ok(r.status === 405, 'GET -> 405');
}
// ── Eligibility ──
{
  const t = NOW;
  ok(eligibility('cases-2026-10-12', t) === null, 'puzzle after the old cutoff is eligible');
  ok(eligibility('cases-2026-10-11', t) === null, 'old cutoff day itself is now eligible (all puzzles count since 2026-10-29)');
  ok(eligibility('holes-haze-and-old-paint-2026-10-08', t) === null, 'older published puzzle accepted');
  ok(eligibility('starry-sky-society-2026-08-21', t) === null, 'oldest published puzzle accepted');
  ok(eligibility('cases-2026-10-22', t) === null, 'today + 2 days allowed');
  ok(eligibility('cases-2026-10-23', t) === 'puzzle date is in the future', 'today + 3 days refused');
  ok(eligibility('cases-2026-02-30', t) === 'bad puzzle date', 'impossible date refused');
  for (const bad of ['Cases-2026-10-18', 'cases_2026-10-18', 'cases-2026-10-18x', '2026-10-18', 'cases-26-10-18', 'a b-2026-10-18', 42, null, 'x'.repeat(120) + '-2026-10-18']) {
    ok(eligibility(bad, t) !== null, 'bad id refused: ' + String(bad).slice(0, 30));
  }
  const { handle, db } = setup();
  let r = await json(await handle(post(finish({ puzzleId: 'cases-nodate' }))));
  ok(r.status === 400 && db.st.plays.length === 0 && db.st.record_rate.length === 0, 'undated id via POST -> 400, nothing stored, not even a rate row');
  r = await json(await handle(post(finish({ puzzleId: 'holes-haze-and-old-paint-2026-10-08' }))));
  ok(r.status === 200 && db.st.plays.length === 1 && db.st.plays[0].puzzle_id === 'holes-haze-and-old-paint-2026-10-08', 'old puzzle id via POST -> stored');
}
// ── Finish once ──
{
  const { handle, db } = setup();
  let r = await json(await handle(post(finish())));
  ok(r.status === 200 && r.body.ok === true, 'finish -> {ok:true}');
  const row = db.st.plays[0];
  ok(row && row.puzzle_id === PID && row.anon_id === ANON && row.outcome === 'won' && row.mistakes === 1 && row.guesses === 5 &&
    row.hint_labels === true && row.hint_seeds === false && row.hint_category === false && row.casual === false && row.finished_at === NOW.toISOString(),
    'row has exactly the sent values');
  ok(Object.keys(row).sort().join(',') === 'anon_id,attempts,casual,finished_at,guesses,hint_after,hint_category,hint_labels,hint_seeds,mistakes,outcome,puzzle_id,revealed_group,solve_order', 'row has no other columns: ' + Object.keys(row).sort().join(','));
  ok(row.attempts === null && row.solve_order === null && row.revealed_group === null && row.hint_after === null, 'old client (no guess detail) -> detail columns null');
  r = await json(await handle(post(finish({ outcome: 'lost', mistakes: 4, guesses: 8 }))));
  ok(r.status === 200 && r.body.ok && db.st.plays.length === 1 && db.st.plays[0].outcome === 'won', 'second finish ignored, ok returned, first stands');
  r = await json(await handle(post(finish({ anonId: ANON.toUpperCase() }))));
  ok(r.status === 200 && db.st.plays.length === 1, 'upper-case anonId is the same browser');
  ok(db.st.record_rate.length === 3 && /^[0-9a-f]{64}$/.test(db.st.record_rate[0].ip_hash) && !db.st.record_rate[0].ip_hash.includes('203'), 'rate rows hold a salted hash, never the IP');
}
// ── Rate ──
{
  const { handle, db } = setup();
  let r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: ANON, rating: 4 })));
  ok(r.status === 409 && db.st.plays.length === 0, 'rate before finish -> 409, no row made');
  await handle(post(finish()));
  r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: ANON, rating: 4 })));
  ok(r.status === 200 && db.st.plays[0].rating === 4 && db.st.plays[0].rated_at === NOW.toISOString(), 'rate after finish -> stored');
  r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: ANON, rating: 2 })));
  ok(r.status === 200 && db.st.plays[0].rating === 2, 'rating can be changed');
  r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: '11111111-2222-4333-8444-555555555555', rating: 3 })));
  ok(r.status === 409 && db.st.plays[0].rating === 2, "another browser can't rate without its own finish");
  for (const bad of [0, 5, 6, 2.5, '3', null]) {
    r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: ANON, rating: bad })));
    ok(r.status === 400, 'bad rating refused: ' + JSON.stringify(bad));
  }
  r = await json(await handle(post({ event: 'rate', puzzleId: PID, anonId: ANON, rating: 3, outcome: 'won' })));
  ok(r.status === 400, 'extra field on rate refused');
}
// ── Bad fields ──
{
  const { handle, db } = setup();
  const cases = [
    ['unknown event', { event: 'start' }], ['bad anonId', { anonId: 'abc' }], ['anonId not uuid', { anonId: 'a-lx9-123456789012345678901234567' }],
    ['outcome', { outcome: 'draw' }], ['mistakes -1', { mistakes: -1 }], ['mistakes 21', { mistakes: 21, casual: true, guesses: 30 }],
    ['mistakes float', { mistakes: 1.5 }], ['mistakes string', { mistakes: '1' }], ['guesses 41', { guesses: 41 }],
    ['guesses < mistakes', { mistakes: 3, guesses: 2 }], ['standard win with 4 mistakes', { mistakes: 4, guesses: 8 }],
    ['casual not boolean', { casual: 'no' }], ['hints missing', { hints: undefined }], ['hints extra key', { hints: { labels: true, seeds: false, category: false, x: true } }],
    ['hint not boolean', { hints: { labels: 1, seeds: false, category: false } }], ['extra field name', { name: 'Thirth' }],
    ['extra field email', { email: 'a@b.c' }], ['extra field rating on finish', { rating: 3 }],
  ];
  for (const [label, o] of cases) {
    const r = await json(await handle(post(finish(o))));
    ok(r.status === 400 && r.body.ok === false, 'refused: ' + label + ' -> ' + r.status);
  }
  ok(db.st.plays.length === 0, 'none of those stored');
  let r = await json(await handle(post('not json')));
  ok(r.status === 400, 'not JSON -> 400');
  r = await json(await handle(post([1, 2])));
  ok(r.status === 400, 'array -> 400');
  r = await json(await handle(post(JSON.stringify(finish({ hints: { labels: true, seeds: false, category: false } })) + ' '.repeat(25000))));
  ok(r.status === 413, 'oversized body -> 413');
  r = await json(await handle(post(finish({ casual: true, mistakes: 9, guesses: 13 }))));
  ok(r.status === 200, 'casual win with 9 mistakes accepted');
  r = await json(await handle(post(finish({ anonId: '11111111-2222-4333-8444-555555555555', outcome: 'lost', mistakes: 4, guesses: 7 }))));
  ok(r.status === 200, 'standard loss accepted');
}
// ── Rate limit + purge ──
{
  const { handle, db } = setup();
  const old = new Date(NOW.getTime() - 25 * 3600e3).toISOString();
  db.st.submit_rate.push({ ip_hash: 'oldsub', at: old }, { ip_hash: 'newsub', at: NOW.toISOString() });
  db.st.record_rate.push({ ip_hash: 'oldrec', at: old });
  const { sha256Hex } = await import('../functions/submit/handler.js');
  const h = await sha256Hex('desk-puzzle-record-rate-v1|rec|203.0.113.9');
  for (let i = 0; i < RATE_PER_HOUR; i++) db.st.record_rate.push({ ip_hash: h, at: new Date(NOW.getTime() - 600e3).toISOString() });
  let r = await json(await handle(post(finish())));
  ok(r.status === 429 && db.st.plays.length === 0, `${RATE_PER_HOUR} events in the hour -> 429`);
  ok(!db.st.submit_rate.some((x) => x.ip_hash === 'oldsub') && db.st.submit_rate.some((x) => x.ip_hash === 'newsub') &&
    !db.st.record_rate.some((x) => x.ip_hash === 'oldrec'), 'rows older than 24 h purged from record_rate and submit_rate');
  r = await json(await handle(post(finish(), { 'x-forwarded-for': '198.51.100.7' })));
  ok(r.status === 200, 'another network is not blocked');
  ok(RATE_PER_HOUR >= 300, 'limit is generous (>= 300/hour) for shared campus IPs');
  const salted = setup({ RATE_SALT: 'other' });
  await salted.handle(post(finish()));
  ok(salted.db.st.record_rate[0].ip_hash !== h, 'RATE_SALT changes the hash');
  const down = setup({}, { down: true });
  r = await json(await down.handle(post(finish())));
  ok(r.status === 503, 'database down -> 503');
}
// ── Secret key choice (shared with submit) ──
{
  const env = (m) => (k) => m[k];
  ok(pickServerKey(env({ DP_SECRET_KEY: 'sb_secret_new', SUPABASE_SERVICE_ROLE_KEY: 'legacy' })) === 'sb_secret_new', 'DP_SECRET_KEY wins');
  ok(pickServerKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_map"}', SUPABASE_SERVICE_ROLE_KEY: 'legacy' })) === 'sb_secret_map', 'SUPABASE_SECRET_KEYS map next');
  ok(pickServerKey(env({ SUPABASE_SERVICE_ROLE_KEY: 'legacy' })) === 'legacy', 'legacy service key last');
}

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
process.exit(fails ? 1 : 0);
