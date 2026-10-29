// supabase/tests/ui/pg_server.mjs — local stand-in for Supabase, for the
// workspace's browser tests. It serves the site's files and answers the page's
// database calls from a throwaway in-memory Postgres (PGlite) that has every
// real migration applied, so the real row rules, triggers and RPCs decide
// what each test user may see and do. Never talks to the live database.
//
//   PGLITE_MODULE=/path/to/pglite/dist/index.js node supabase/tests/ui/pg_server.mjs 4820
//
// POST /__pg     { who, table, op, cols, filters, order, limit, patch, ret } or { who, rpc, args } or { who, storage: 'upload', bucket, path }
//                or { who, storage: 'remove', bucket, paths }
// POST /__reset  fresh database + seed (between test files)
// POST /__rt     Realtime stand-in for live syncing (see "Realtime stand-in" below)
// /__fake/...    stand-in Supabase for the Studio (studio.e2e.mjs points its config here):
//                POST /__fake/rest/v1/rpc/active_schools (as the public key) and
//                POST /__fake/functions/v1/submit (the REAL submit handler, storing into PGlite)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, migrationFiles, applyMigration, as, userId } from '../db_harness.mjs';
import { seed } from './seed.mjs';
import { createHandler } from '../../functions/submit/handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const port = Number(process.argv[2] || 4820);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

let db = null, queue = Promise.resolve();
async function reset() {
  const t = Date.now();
  if (db) await db.close().catch(() => {});
  db = await freshDb();
  for (const f of migrationFiles()) await applyMigration(db, f);
  await seed(db);
  return Date.now() - t;
}
// PGlite has one connection: run requests one after another.
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

const ID = /^[a-z_][a-z0-9_]*$/;
const q = (x) => { if (!ID.test(x)) throw new Error('bad identifier ' + x); return '"' + x + '"'; };
function colList(cols) {
  const s = String(cols || '*').trim();
  if (s === '*') return '*';
  return s.split(',').map((c) => q(c.trim())).join(', ');
}
function where(filters, params) {
  const out = (filters || []).map(([k, c, v]) => {
    if (k === 'is') return q(c) + (v === null ? ' is null' : ' is not null');
    params.push(v); const n = '$' + params.length;
    if (k === 'eq') return q(c) + ' = ' + n;
    if (k === 'neq') return q(c) + ' <> ' + n;
    if (k === 'in') return q(c) + ' = any(' + n + ')';
    if (k === 'gte') return q(c) + ' >= ' + n;
    if (k === 'lt') return q(c) + ' < ' + n;
    if (k === 'overlaps') return q(c) + ' && ' + n;
    if (k === 'fts') return q(c) + " @@ websearch_to_tsquery('english', " + n + ')';
    throw new Error('unknown filter ' + k);
  });
  return out.length ? ' where ' + out.join(' and ') : '';
}
async function rpc(who, name, args) {
  if (!ID.test(name)) throw new Error('bad rpc');
  const meta = await db.query(`select p.proretset, t.typname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype where n.nspname = 'public' and p.proname = $1`, [name]);
  if (!meta.rows.length) return { data: null, error: { message: 'Could not find the function public.' + name, code: 'PGRST202' } };
  const params = [], named = Object.keys(args || {}).map((k) => { params.push(args[k]); return q(k) + ' => $' + params.length; }).join(', ');
  const set = meta.rows[0].proretset;
  const sql = set ? `select * from public.${q(name)}(${named})` : `select public.${q(name)}(${named}) as v`;
  const r = await as(db, who, sql, params);
  if (r.error) return { data: null, error: { message: r.error } };
  return { data: set ? r.rows : meta.rows[0].typname === 'void' ? null : r.rows[0].v, error: null };
}
async function upload(who, bucket, name, upsert) {
  const r = await as(db, who, 'insert into storage.objects (bucket_id, name) values ($1, $2) returning name', [bucket, name]);
  if (!r.error) return { data: { path: name }, error: null };
  if (upsert && /duplicate|unique/i.test(r.error)) {
    const u = await as(db, who, 'update storage.objects set created_at = now() where bucket_id = $1 and name = $2 returning name', [bucket, name]);
    if (!u.error && u.rows.length) return { data: { path: name }, error: null };
  }
  return { data: null, error: { message: /row-level security/i.test(r.error) ? 'new row violates row-level security policy' : r.error } };
}
async function run(b) {
  const who = b.who || 'anon';
  if (b.rpc) return rpc(who, b.rpc, b.args);
  if (b.storage === 'upload') return upload(who, String(b.bucket || ''), String(b.path || ''), b.upsert);
  if (b.storage === 'remove') { // like Storage: removes what the rules allow, silently skips the rest
    const r = await as(db, who, 'delete from storage.objects where bucket_id = $1 and name = any($2) returning name', [String(b.bucket || ''), (b.paths || []).map(String)]);
    return r.error ? { data: null, error: { message: r.error } } : { data: r.rows.map((x) => ({ name: x.name })), error: null };
  }
  const t = 'public.' + q(b.table), params = [];
  let sql;
  if (b.op === 'select') {
    sql = 'select ' + colList(b.cols) + ' from ' + t + where(b.filters, params);
    if (b.order && b.order.length) sql += ' order by ' + b.order.map(([c, asc]) => q(c) + (asc ? ' asc nulls last' : ' desc nulls first')).join(', ');
    if (b.limit) sql += ' limit ' + Number(b.limit);
  } else if (b.op === 'insert') {
    const rows = Array.isArray(b.patch) ? b.patch : [b.patch];
    const keys = Object.keys(rows[0]);
    sql = 'insert into ' + t + ' (' + keys.map(q).join(', ') + ') values ' + rows.map((r) => '(' + keys.map((k) => { params.push(r[k]); return '$' + params.length; }).join(', ') + ')').join(', ');
  } else if (b.op === 'update') {
    sql = 'update ' + t + ' set ' + Object.keys(b.patch).map((k) => { params.push(b.patch[k]); return q(k) + ' = $' + params.length; }).join(', ') + where(b.filters, params);
  } else if (b.op === 'delete') {
    sql = 'delete from ' + t + where(b.filters, params);
  } else throw new Error('bad op');
  if (b.op !== 'select' && b.ret) sql += ' returning ' + colList(b.cols);
  // jsonb/array values: PGlite serializes by the parameter type it infers.
  const r = await as(db, who, sql, params);
  if (r.error) return { data: null, error: { message: r.error } };
  return { data: b.op === 'select' || b.ret ? r.rows : null, error: null };
}

// The real submit function's handler, with a tiny supabase-js stand-in over PGlite
// (rate rows in memory; images are not kept, only their paths).
const rate = [];
function fakeSupabase() {
  const table = (name) => {
    const st = { op: 'select', f: [] };
    const api = {
      select() { return api; }, delete() { st.op = 'delete'; return api; },
      eq(k, v) { st.f.push(['eq', k, v]); return api; }, gte(k, v) { st.f.push(['gte', k, v]); return api; }, lt(k, v) { st.f.push(['lt', k, v]); return api; },
      insert(row) {
        if (name === 'submit_rate') { rate.push(row); return Promise.resolve({ error: null }); }
        const keys = Object.keys(row);
        return serial(() => as(db, 'service', `insert into public.${q(name)} (${keys.map(q).join(', ')}) values (${keys.map((k, i) => '$' + (i + 1)).join(', ')})`, keys.map((k) => row[k])))
          .then((r) => ({ error: r.error ? { message: r.error, code: /duplicate/.test(r.error) ? '23505' : 'XX000' } : null }));
      },
      then(res, rej) {
        const hit = (r) => st.f.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'gte' ? r[c] >= v : r[c] < v));
        if (name === 'submit_rate') {
          if (st.op === 'delete') { for (let i = rate.length - 1; i >= 0; i--) if (hit(rate[i])) rate.splice(i, 1); return Promise.resolve({ error: null }).then(res, rej); }
          return Promise.resolve({ count: rate.filter(hit).length, error: null }).then(res, rej);
        }
        const params = [], w = st.f.map(([k, c, v]) => { params.push(v); return q(c) + (k === 'eq' ? ' = ' : k === 'gte' ? ' >= ' : ' < ') + '$' + params.length; });
        return serial(() => as(db, 'service', `select * from public.${q(name)}` + (w.length ? ' where ' + w.join(' and ') : ''), params))
          .then((r) => ({ data: r.error ? null : r.rows, error: r.error ? { message: r.error } : null })).then(res, rej);
      },
    };
    return api;
  };
  return { from: table, storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), remove: async () => ({ error: null }) }) } };
}
const submitHandler = createHandler({ env: (k) => (k === 'ALLOWED_ORIGINS' ? 'http://127.0.0.1:' + port : undefined), supabase: fakeSupabase(), fetch: () => Promise.reject(new Error('no network')) });

// ── Realtime stand-in (live syncing tests) ──────────────────────────────────
// Private channels like Supabase Realtime: joining asks the real row rules on
// realtime.messages as that person with the topic set; presence tracking asks
// the insert rule. Notes written by the live-sync triggers into
// realtime.messages are delivered to everyone joined to that topic.
// POST /__rt { cid, who, op: join|leave|track|untrack|poll, topic, key, state }
// POST /__rt_ctl { down: true|false } simulates Realtime going away / coming back.
const RT = { clients: new Map(), presence: new Map(), lastId: 0, down: false };
const rtClient = (cid) => { if (!RT.clients.has(cid)) RT.clients.set(cid, { subs: new Set(), q: [], wait: null }); return RT.clients.get(cid); };
function rtPush(c, ev) { c.q.push(ev); if (c.wait) { const w = c.wait; c.wait = null; w(); } }
async function rtAsk(who, topic, sql, params, probe) {
  return serial(async () => {
    try {
      return await db.transaction(async (tx) => {
        if (probe) await tx.query(`insert into realtime.messages (topic, extension, payload, event) values ($1, $2, '{}', 'probe')`, [topic, probe]);
        await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
        if (who !== 'anon') await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ email: who, role: 'authenticated', sub: userId(who) })]);
        await tx.exec(`set local role ${who === 'anon' ? 'anon' : 'authenticated'}`);
        const r = await tx.query(sql, params);
        throw Object.assign(new Error('rollback'), { rows: r.rows });
      });
    } catch (e) { return e.rows ? { ok: true, rows: e.rows } : { ok: false, error: e.message }; }
  });
}
const rtCanRead = async (who, topic, ext) => {
  const r = await rtAsk(who, topic, `select count(*)::int n from realtime.messages where topic = $1 and extension = $2`, [topic, ext], ext);
  return r.ok && r.rows[0].n > 0;
};
const rtCanTrack = async (who, topic) => (await rtAsk(who, topic, `insert into realtime.messages (topic, extension, payload, event) values ($1, 'presence', '{}', 'probe') returning id`, [topic])).ok;
function rtPresenceSync(topic) {
  const m = RT.presence.get(topic) || new Map(), state = {};
  m.forEach((v, key) => { state[key] = [Object.assign({ presence_ref: key }, v.state)]; });
  RT.clients.forEach((c) => { if (c.subs.has(topic) && c.pres && c.pres.has(topic)) rtPush(c, { topic, type: 'presence', state }); });
}
function rtDrop(cid, topic) {
  const m = RT.presence.get(topic); if (!m) return false;
  let hit = false; m.forEach((v, k) => { if (v.cid === cid) { m.delete(k); hit = true; } });
  return hit;
}
async function rtDrain() {
  if (!db) return;
  const r = await as(db, 'postgres', `select id, topic, event, payload from realtime.messages where id > $1 and extension = 'broadcast' and event <> 'probe' order by id`, [RT.lastId]);
  (r.rows || []).forEach((m) => {
    RT.lastId = Math.max(RT.lastId, Number(m.id));
    if (RT.down) return;
    RT.clients.forEach((c) => { if (c.subs.has(m.topic)) rtPush(c, { topic: m.topic, type: 'broadcast', event: m.event, payload: m.payload }); });
  });
}
setInterval(() => { serial(rtDrain).catch(() => {}); }, 120).unref();
async function rtOp(b) {
  const c = rtClient(String(b.cid || '')), who = b.who || 'anon', topic = String(b.topic || '');
  if (b.op === 'poll') {
    if (!c.q.length) await new Promise((res) => { c.wait = res; setTimeout(() => { if (c.wait === res) { c.wait = null; res(); } }, 10000); });
    const events = c.q; c.q = []; return { events };
  }
  if (b.op === 'join') {
    if (RT.down) return { ok: false, error: 'Realtime is down' };
    if (!(await rtCanRead(who, topic, 'broadcast'))) return { ok: false, error: 'Unauthorized: You do not have permissions to read from this Channel topic: ' + topic };
    c.subs.add(topic);
    if (b.key) { if (!(await rtCanRead(who, topic, 'presence'))) return { ok: false, error: 'Unauthorized presence' }; (c.pres = c.pres || new Set()).add(topic); rtPresenceSync(topic); }
    return { ok: true };
  }
  if (b.op === 'leave') { c.subs.delete(topic); if (c.pres) c.pres.delete(topic); if (rtDrop(String(b.cid), topic)) rtPresenceSync(topic); return { ok: true }; }
  if (b.op === 'track') {
    if (RT.down || !c.subs.has(topic)) return { ok: false, error: 'not joined' };
    if (!(await rtCanTrack(who, topic))) return { ok: false, error: 'Unauthorized: You do not have permissions to track presence on this Channel topic: ' + topic };
    if (!RT.presence.has(topic)) RT.presence.set(topic, new Map());
    RT.presence.get(topic).set(String(b.key), { cid: String(b.cid), state: b.state || {} });
    rtPresenceSync(topic); return { ok: true };
  }
  if (b.op === 'untrack') { if (rtDrop(String(b.cid), topic)) rtPresenceSync(topic); return { ok: true }; }
  return { ok: false, error: 'bad op' };
}
function rtSetDown(down) {
  RT.down = !!down;
  if (!RT.down) return;
  RT.clients.forEach((c, cid) => { c.subs.forEach((t) => { rtDrop(cid, t); rtPush(c, { topic: t, type: 'status', status: 'CHANNEL_ERROR' }); }); c.subs.clear(); if (c.pres) c.pres.clear(); });
  RT.presence.clear();
}
function rtReset() {
  RT.clients.forEach((c) => { if (c.wait) { const w = c.wait; c.wait = null; w(); } });
  RT.clients.clear(); RT.presence.clear(); RT.lastId = 0; RT.down = false;
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/__fake/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        if (url.pathname === '/__fake/rest/v1/rpc/active_schools') {
          const out = await serial(() => rpc('anon', 'active_schools', {}));
          res.writeHead(out.error ? 404 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.error || out.data)); return;
        }
        if (url.pathname === '/__fake/functions/v1/submit') {
          const r = await submitHandler(new Request('http://127.0.0.1:' + port + url.pathname, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined }));
          const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
          res.writeHead(r.status, h); res.end(await r.text()); return;
        }
        res.writeHead(404); res.end('{}');
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/__rt' || url.pathname === '/__rt_ctl')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let out;
      try { const b = JSON.parse(body || '{}'); out = url.pathname === '/__rt_ctl' ? (rtSetDown(b.down), { ok: true, down: RT.down }) : await rtOp(b); }
      catch (e) { out = { ok: false, error: String(e.message || e) }; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/__pg' || url.pathname === '/__reset' || url.pathname === '/__sql')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let out;
      try {
        if (url.pathname === '/__reset') { rtReset(); out = { ms: await serial(reset) }; }
        else if (url.pathname === '/__sql') { const b = JSON.parse(body); out = await serial(() => as(db, b.who || 'postgres', b.sql, b.params || [])); }
        else out = await serial(() => run(JSON.parse(body)));
      } catch (e) { out = { data: null, error: { message: String(e.message || e) } }; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out, (k, v) => (v instanceof Date ? v.toISOString() : v)));
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});
reset().then((ms) => srv.listen(port, '127.0.0.1', () => console.log('ready on ' + port + ' (db ' + ms + ' ms)')))
  .catch((e) => { console.error('start failed: ' + e.message); process.exit(1); });
setTimeout(() => process.exit(0), 30 * 60 * 1000).unref(); // never outlives a test session
