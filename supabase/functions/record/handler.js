// The "record" function's logic: anonymous play stats from the game. Kept
// free of Deno-only code so node tests can drive it with a fake database;
// index.ts only wires it to Deno.serve. Plan: docs/08-stats-plan.md (platform
// repo), privacy wording §8. Anything this accepts must match that wording.
//
// A request is: POST JSON, exactly one of
//   { event: 'finish', puzzleId, anonId, outcome: 'won'|'lost', mistakes, guesses,
//     hints: { labels, seeds, category }, casual }
//   { event: 'rate', puzzleId, anonId, rating: 1..5 }
// Any other key is refused, so nothing beyond the approved list can be stored.
// Reply: { ok: true } or { ok: false, error }.
//
// Rules:
//   * Only from the Desk Puzzle website (origin allowlist, same as submit).
//   * Only puzzles released AFTER 2026-10-11: the id must end in its date
//     (some-name-YYYY-MM-DD), the date must be later than STATS_SINCE and no
//     more than 2 days in the future.
//   * 'finish' is stored once per browser per puzzle; repeats are ignored (still ok).
//   * 'rate' needs that browser's finish row; sending again changes the rating.
//   * RATE_PER_HOUR events per network (salted IP hash, deleted after 24 h).

import { clientIp, sha256Hex, pickServerKey } from '../submit/handler.js';

export { pickServerKey };
export const DEFAULT_ORIGINS = 'https://pathologyconnections.org,https://www.pathologyconnections.org,https://cooperstarrysky.github.io,http://localhost:4607';
export const STATS_SINCE = '2026-10-11';
export const RATE_PER_HOUR = 300; // a whole class can share one campus IP
export const MAX_BODY_BYTES = 2048;
const DEFAULT_SALT = 'desk-puzzle-record-rate-v1';
const ID_RE = /^[a-z0-9-]+-(\d{4}-\d{2}-\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINISH_KEYS = ['event', 'puzzleId', 'anonId', 'outcome', 'mistakes', 'guesses', 'hints', 'casual'];
const RATE_KEYS = ['event', 'puzzleId', 'anonId', 'rating'];
const HINT_KEYS = ['labels', 'seeds', 'category'];

/** null when the puzzle id may be counted at time t, else a reason. */
export function eligibility(puzzleId, t) {
  if (typeof puzzleId !== 'string' || puzzleId.length > 120) return 'bad puzzle id';
  const m = ID_RE.exec(puzzleId);
  if (!m) return 'bad puzzle id';
  const d = new Date(m[1] + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== m[1]) return 'bad puzzle date';
  if (m[1] <= STATS_SINCE) return 'puzzle too old for stats';
  const latest = new Date(t.getTime() + 2 * 86400e3).toISOString().slice(0, 10);
  if (m[1] > latest) return 'puzzle date is in the future';
  return null;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

/** The plays row for a finish event, or a string saying what is wrong. */
export function finishRow(b) {
  if (!onlyKeys(b, FINISH_KEYS)) return 'unexpected field';
  if (b.outcome !== 'won' && b.outcome !== 'lost') return 'bad outcome';
  if (!isInt(b.mistakes, 0, 20)) return 'bad mistakes';
  if (!isInt(b.guesses, 0, 40)) return 'bad guesses';
  if (typeof b.casual !== 'boolean') return 'bad casual';
  const h = b.hints;
  if (!h || typeof h !== 'object' || Array.isArray(h) || !onlyKeys(h, HINT_KEYS) ||
      !HINT_KEYS.every((k) => typeof h[k] === 'boolean')) return 'bad hints';
  // A standard game ends on the 4th mistake, so a standard win has at most 3.
  if (!b.casual && b.outcome === 'won' && b.mistakes > 3) return 'bad mistakes';
  if (b.guesses < b.mistakes) return 'bad guesses';
  return {
    puzzle_id: b.puzzleId, anon_id: b.anonId.toLowerCase(), outcome: b.outcome,
    mistakes: b.mistakes, guesses: b.guesses,
    hint_labels: h.labels, hint_seeds: h.seeds, hint_category: h.category, casual: b.casual,
  };
}

/**
 * deps:
 *   env(name)  -> string | undefined   (Deno.env.get)
 *   supabase   secret-key supabase-js client (or a test fake)
 *   now()      -> Date (optional)
 */
export function createHandler(deps) {
  const env = (k) => (deps.env ? deps.env(k) : undefined);
  const now = deps.now || (() => new Date());
  const db = deps.supabase;
  const origins = String(env('ALLOWED_ORIGINS') || DEFAULT_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

  return async function handle(req) {
    const origin = (req.headers.get('origin') || '').replace(/\/+$/, '');
    const allowed = origins.includes(origin);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } : { Vary: 'Origin' };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors),
    });
    const fail = (status, error) => reply(status, { ok: false, error });

    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return fail(403, 'Stats can only be sent from the Desk Puzzle website.');
    if (req.method !== 'POST') return fail(405, 'Use POST.');

    if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) return fail(413, 'Too big.');
    let raw;
    try { raw = await req.text(); } catch (e) { return fail(400, 'Unreadable.'); }
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'Too big.');
    let b;
    try { b = JSON.parse(raw); } catch (e) { return fail(400, 'Not JSON.'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'Not an event.');
    if (b.event !== 'finish' && b.event !== 'rate') return fail(400, 'Unknown event.');
    const t = now();
    const why = eligibility(b.puzzleId, t);
    if (why) return fail(400, why);
    if (typeof b.anonId !== 'string' || !UUID_RE.test(b.anonId)) return fail(400, 'bad anonId');
    let row = null;
    if (b.event === 'finish') {
      row = finishRow(b);
      if (typeof row === 'string') return fail(400, row);
    } else {
      if (!onlyKeys(b, RATE_KEYS)) return fail(400, 'unexpected field');
      if (!isInt(b.rating, 1, 5)) return fail(400, 'bad rating');
    }

    // ── Rate limit (after the cheap checks, so junk never fills the log) ──
    const salt = env('RATE_SALT') || DEFAULT_SALT;
    const ipHash = await sha256Hex(salt + '|rec|' + (clientIp(req) || 'unknown'));
    const hourAgo = new Date(t.getTime() - 3600e3).toISOString();
    const dayAgo = new Date(t.getTime() - 24 * 3600e3).toISOString();
    try {
      // The 24-hour promise: old rate rows go every time (pg_cron also runs hourly).
      await db.from('record_rate').delete().lt('at', dayAgo);
      await db.from('submit_rate').delete().lt('at', dayAgo);
      const { count, error } = await db.from('record_rate').select('ip_hash', { count: 'exact', head: true })
        .eq('ip_hash', ipHash).gte('at', hourAgo);
      if (error) throw error;
      if ((count || 0) >= RATE_PER_HOUR) return fail(429, 'Too many events from this network. Try later.');
      const ins = await db.from('record_rate').insert({ ip_hash: ipHash, at: t.toISOString() });
      if (ins && ins.error) throw ins.error;
    } catch (e) {
      return fail(503, 'Stats are not available right now.');
    }

    try {
      if (b.event === 'finish') {
        const { error } = await db.from('plays').insert(Object.assign(row, { finished_at: t.toISOString() }));
        // 23505 = this browser already finished this puzzle: the first finish stands.
        if (error && error.code !== '23505') throw error;
        return reply(200, { ok: true });
      }
      const { data, error } = await db.from('plays').update({ rating: b.rating, rated_at: t.toISOString() })
        .eq('puzzle_id', b.puzzleId).eq('anon_id', b.anonId.toLowerCase()).select('puzzle_id');
      if (error) throw error;
      if (!data || !data.length) return fail(409, 'Finish the puzzle before rating it.');
      return reply(200, { ok: true });
    } catch (e) {
      console.error('record failed', e && e.message);
      return fail(500, 'Could not save that just now.');
    }
  };
}
