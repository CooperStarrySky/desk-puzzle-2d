// The "record" function's logic: anonymous play stats from the game. Kept
// free of Deno-only code so node tests can drive it with a fake database;
// index.ts only wires it to Deno.serve. Plan: docs/08-stats-plan.md (platform
// repo), privacy wording §8. Anything this accepts must match that wording.
//
// A request is: POST JSON, exactly one of
//   { event: 'finish', puzzleId, anonId, outcome: 'won'|'lost', mistakes, guesses,
//     hints: { labels, seeds, category }, casual,
//     -- optional (2026-10-29; older game versions leave them out) --
//     attempts: [{ i: [4 clue ids], ok, one_away }, ...]   every guess, in order
//     solveOrder: [group ids in solve order], revealedGroup: group id | null,
//     hintAfter: { labels, seeds, category }  groups solved when each hint was
//                first used (0-3), null when unused or unknown }
//   { event: 'rate', puzzleId, anonId, rating: 1..5 }
// Any other key is refused, so nothing beyond the approved list can be stored.
// A malformed OPTIONAL field is dropped (stored as null) and the rest of the
// finish is still saved; a malformed required field refuses the whole event.
// Reply: { ok: true } or { ok: false, error }.
//
// Rules:
//   * Only from the Desk Puzzle website (origin allowlist, same as submit).
//   * Any published puzzle: the id must end in a real date (some-name-YYYY-MM-DD)
//     no more than 2 days in the future. (Until 2026-10-29 the date also had to
//     be later than STATS_SINCE; the game now only sends finishes it saw happen,
//     so first finishes from before stats existed are never sent.)
//   * 'finish' is stored once per browser per puzzle; repeats are ignored (still ok).
//   * 'rate' needs that browser's finish row; sending again changes the rating.
//   * RATE_PER_HOUR events per network (salted IP hash, deleted after 24 h).

import { clientIp, sha256Hex, pickServerKey } from '../submit/handler.js';

export { pickServerKey };
export const DEFAULT_ORIGINS = 'https://pathologyconnections.org,https://www.pathologyconnections.org,https://cooperstarrysky.github.io,http://localhost:4607';
export const STATS_SINCE = '2026-10-11'; // kept for reference; no longer a cutoff
export const RATE_PER_HOUR = 300; // a whole class can share one campus IP
export const MAX_BODY_BYTES = 24576; // 40 guesses x 4 long clue ids fits with room to spare
export const MAX_ATTEMPTS = 40;
export const MAX_ATTEMPTS_CHARS = 20000; // compact JSON; the database allows 24000 (its text form adds spaces)
const DEFAULT_SALT = 'desk-puzzle-record-rate-v1';
const ID_RE = /^[a-z0-9-]+-(\d{4}-\d{2}-\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINISH_KEYS = ['event', 'puzzleId', 'anonId', 'outcome', 'mistakes', 'guesses', 'hints', 'casual',
  'attempts', 'solveOrder', 'revealedGroup', 'hintAfter'];
// Clue and group ids: slugs from the published puzzle file (build_puzzle.py slugify).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;
const ATTEMPT_KEYS = ['i', 'ok', 'one_away'];
const DETAIL_COLS = ['attempts', 'solve_order', 'revealed_group', 'hint_after'];
const RATE_KEYS = ['event', 'puzzleId', 'anonId', 'rating'];
const HINT_KEYS = ['labels', 'seeds', 'category'];

/** null when the puzzle id may be counted at time t, else a reason. */
export function eligibility(puzzleId, t) {
  if (typeof puzzleId !== 'string' || puzzleId.length > 120) return 'bad puzzle id';
  const m = ID_RE.exec(puzzleId);
  if (!m) return 'bad puzzle id';
  const d = new Date(m[1] + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== m[1]) return 'bad puzzle date';
  const latest = new Date(t.getTime() + 2 * 86400e3).toISOString().slice(0, 10);
  if (m[1] > latest) return 'puzzle date is in the future';
  return null;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

const isSlug = (v) => typeof v === 'string' && SLUG_RE.test(v);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && onlyKeys(o, keys);

/** plays.attempts from the request, or null when absent or malformed. */
export function cleanAttempts(a, guesses) {
  if (!Array.isArray(a) || a.length < 1 || a.length > MAX_ATTEMPTS || a.length > guesses) return null;
  let correct = 0;
  const out = [];
  for (const g of a) {
    if (!isPlainObject(g) || !sameKeys(g, ATTEMPT_KEYS)) return null;
    if (typeof g.ok !== 'boolean' || typeof g.one_away !== 'boolean' || (g.ok && g.one_away)) return null;
    if (!Array.isArray(g.i) || g.i.length !== 4 || !g.i.every(isSlug) || new Set(g.i).size !== 4) return null;
    if (g.ok) correct++;
    out.push({ i: g.i.slice(), ok: g.ok, one_away: g.one_away });
  }
  if (correct > 4 || JSON.stringify(out).length > MAX_ATTEMPTS_CHARS) return null;
  return out;
}

/** plays.solve_order, or null. A won game solved all 4 groups. */
export function cleanSolveOrder(s, outcome) {
  if (!Array.isArray(s) || s.length < 1 || s.length > 4 || !s.every(isSlug) || new Set(s).size !== s.length) return null;
  if (outcome === 'won' && s.length !== 4) return null;
  return s.slice();
}

/** plays.hint_after as [labels, seeds, category], or null. */
export function cleanHintAfter(h, hints) {
  if (!isPlainObject(h) || !sameKeys(h, HINT_KEYS)) return null;
  const out = HINT_KEYS.map((k) => h[k]);
  for (let n = 0; n < 3; n++) {
    const v = out[n];
    if (v === null) continue;
    if (!isInt(v, 0, 3) || !hints[HINT_KEYS[n]]) return null; // a number only for a used hint
  }
  return out.every((v) => v === null) ? null : out;
}

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
    // Optional detail: a bad value is dropped here, the play itself is kept.
    attempts: cleanAttempts(b.attempts, b.guesses),
    solve_order: cleanSolveOrder(b.solveOrder, b.outcome),
    revealed_group: h.category && isSlug(b.revealedGroup) ? b.revealedGroup : null,
    hint_after: cleanHintAfter(b.hintAfter, h),
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
        let { error } = await db.from('plays').insert(Object.assign(row, { finished_at: t.toISOString() }));
        // 23514 = a check rule refused the row. The optional guess detail is the
        // only part this function can't fully vouch for, so keep the play without it.
        if (error && error.code === '23514' && DETAIL_COLS.some((k) => row[k] !== null)) {
          DETAIL_COLS.forEach((k) => { row[k] = null; });
          ({ error } = await db.from('plays').insert(row));
        }
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
