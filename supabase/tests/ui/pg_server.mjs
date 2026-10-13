// supabase/tests/ui/pg_server.mjs — local stand-in for Supabase, for the
// workspace's browser tests. It serves the site's files and answers the page's
// database calls from a throwaway in-memory Postgres (PGlite) that has every
// real migration applied, so the real row rules, triggers and RPCs decide
// what each test user may see and do. Never talks to the live database.
//
//   PGLITE_MODULE=/path/to/pglite/dist/index.js node supabase/tests/ui/pg_server.mjs 4820
//
// POST /__pg     { who, table, op, cols, filters, order, limit, patch, ret } or { who, rpc, args }
// POST /__reset  fresh database + seed (between test files)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, migrationFiles, applyMigration, as } from '../db_harness.mjs';
import { seed } from './seed.mjs';

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
async function run(b) {
  const who = b.who || 'anon';
  if (b.rpc) return rpc(who, b.rpc, b.args);
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

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && (url.pathname === '/__pg' || url.pathname === '/__reset' || url.pathname === '/__sql')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let out;
      try {
        if (url.pathname === '/__reset') out = { ms: await serial(reset) };
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
