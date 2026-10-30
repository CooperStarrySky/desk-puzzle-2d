/* ════════════════════════════════════════════════════════════════════
 * stats-remote.js — class-wide play stats: sending and reading.
 *
 * What is sent, and when, must match the approved Settings wording
 * (docs/08-stats-plan.md §8):
 *   - only when a puzzle is FINISHED for the first time in this browser,
 *     and that finish happened on this page (state.js; a first finish from
 *     before class stats existed is never sent),
 *   - for any published puzzle (isStatsEligible: a dated id; until
 *     2026-10-29 only puzzles released after Oct 11, 2026),
 *   - only the fields in stats-core.js finishPayload (+ a rating 1-4),
 *     with a random per-browser id (dp2d:anon),
 *   - nothing at all while "Share my anonymous play stats" is off
 *     (switching it off also empties the outbox).
 * Sends go to the Supabase "record" function. A failed send waits in a
 * small outbox (dp2d:outbox) and is retried on later page loads for up
 * to OUTBOX_DAYS. Every request gives up after 3 s and fails silently.
 *
 * Reading: the public puzzle_stats totals over the REST API with the
 * publishable key (apikey header only). Results are cached for the page.
 *
 * Settings: window.DESK_PUZZLE_CONFIG from studio/config.js (the same file
 * the Studio uses; index.html loads it before the game).
 * Imports: state.js, stats-core.js.
 * ════════════════════════════════════════════════════════════════════ */

import { state, SAVE_PREFIX, getFirstResult, setFirstFinishHook } from './state.js';
import { isStatsEligible, finishPayload, hasCountedFinish } from './stats-core.js';

var ANON_KEY = SAVE_PREFIX + 'anon';
var OUTBOX_KEY = SAVE_PREFIX + 'outbox';
var RATING_NS = SAVE_PREFIX + 'rating4:'; // new key for the 4-point scale, so old 5-point picks don't show as pressed
var COUNTED_NS = SAVE_PREFIX + 'counted:'; // a finish for this puzzle was queued to the server
var OUTBOX_DAYS = 3;
var OUTBOX_MAX = 30;
var TIMEOUT_MS = 3000;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var statsCache = {}; // puzzleId -> puzzle_stats row, or null when there is none yet
var flushing = false;
var pending = {}; // puzzleId -> promise of the latest send, so the results screen can wait for it

/** True unless the player switched off "Share my anonymous play stats". */
export function statsSharingEnabled() {
  return state.settings.shareStats !== false;
}

function config() {
  var c = window.DESK_PUZZLE_CONFIG || {};
  var url = String(c.supabaseUrl || '').trim().replace(/\/+$/, '');
  var key = String(c.supabasePublishableKey || c.supabaseAnonKey || '').trim();
  return url && key ? { url: url, key: key } : null;
}

function uuid4() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  var b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

/** Random per-browser id (a UUID), created on first use. Not tied to a person. */
export function getAnonId() {
  try {
    var id = localStorage.getItem(ANON_KEY);
    if (id && UUID_RE.test(id)) return id;
    id = uuid4();
    localStorage.setItem(ANON_KEY, id);
    return id;
  } catch (e) { return null; }
}

/** fetch with a hard 3 s limit; resolves to the Response or null (never throws). */
function timedFetch(url, init) {
  var ctl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
  if (ctl) init.signal = ctl.signal;
  return Promise.race([
    fetch(url, init),
    new Promise(function (res) { setTimeout(function () { res(null); }, TIMEOUT_MS + 50); }),
  ]).then(function (r) { clearTimeout(timer); return r; }, function () { clearTimeout(timer); return null; });
}

/* ── Outbox ──────────────────────────────────────────────────────── */

function readOutbox() {
  try {
    var a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function writeOutbox(a) {
  try {
    if (a.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(a.slice(-OUTBOX_MAX)));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch (e) { /* storage unavailable */ }
}
export function clearOutbox() { writeOutbox([]); }

/** Post one event. 'sent' (stored or refused for good), or 'retry' (network/server trouble). */
function postEvent(body) {
  var cfg = config();
  if (!cfg) return Promise.resolve('retry');
  return timedFetch(cfg.url + '/functions/v1/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.key },
    body: JSON.stringify(body),
  }).then(function (r) {
    if (!r) return 'retry';
    // 4xx other than 429 will never succeed (bad or ineligible): drop it.
    return (r.status >= 500 || r.status === 429) ? 'retry' : 'sent';
  });
}

/** Queue an event, then try to send everything waiting (in order). */
function queueAndFlush(body) {
  if (!statsSharingEnabled() || !isStatsEligible(body.puzzleId)) return Promise.resolve();
  var box = readOutbox().filter(function (e) {
    // A newer rating for the same puzzle replaces a waiting one.
    return !(body.event === 'rate' && e.body && e.body.event === 'rate' && e.body.puzzleId === body.puzzleId);
  });
  box.push({ body: body, queuedAt: Date.now() });
  writeOutbox(box);
  return flushOutbox();
}

/** Retry waiting events; stops at the first failure so order is kept. */
export function flushOutbox() {
  if (flushing || state.previewMode || state.editorMode) return Promise.resolve();
  if (!statsSharingEnabled()) { clearOutbox(); return Promise.resolve(); }
  var cutoff = Date.now() - OUTBOX_DAYS * 86400e3;
  var box = readOutbox().filter(function (e) { return e && e.body && e.queuedAt > cutoff && isStatsEligible(e.body.puzzleId); });
  writeOutbox(box);
  if (!box.length) return Promise.resolve();
  flushing = true;
  var step = function () {
    var cur = readOutbox();
    if (!cur.length || !statsSharingEnabled()) { flushing = false; return; }
    var head = cur[0];
    return postEvent(head.body).then(function (res) {
      if (res === 'retry') { flushing = false; return; }
      writeOutbox(readOutbox().filter(function (e) { return e.queuedAt !== head.queuedAt || JSON.stringify(e.body) !== JSON.stringify(head.body); }));
      return step();
    });
  };
  return Promise.resolve(step()).catch(function () { flushing = false; });
}

/* ── Events ──────────────────────────────────────────────────────── */

/** First finish of a puzzle (hooked into state.js recordFirstResult). */
export function sendFirstFinish(puzzleId, rec) {
  if (state.previewMode || state.editorMode || !statsSharingEnabled() || !isStatsEligible(puzzleId)) return Promise.resolve();
  var anon = getAnonId();
  var body = anon && finishPayload(puzzleId, anon, rec || getFirstResult(puzzleId));
  if (!body) return Promise.resolve();
  delete statsCache[puzzleId]; // our own finish changes the totals
  try { localStorage.setItem(COUNTED_NS + puzzleId, '1'); } catch (e) { /* storage unavailable */ }
  return (pending[puzzleId] = queueAndFlush(body));
}

/** True when the server has (or will get) this browser's finish for the
    puzzle, so a rating can attach to it. False for a finish from before
    class stats counted that puzzle: the results screen hides the rating row. */
export function hasCountedPlay(puzzleId) {
  var marker = false;
  try { marker = localStorage.getItem(COUNTED_NS + puzzleId) === '1'; } catch (e) { /* ignore */ }
  return hasCountedFinish(puzzleId, getFirstResult(puzzleId), marker);
}

/** Resolves when this page's latest send for the puzzle is done (or failed). */
export function whenSent(puzzleId) { return Promise.resolve(pending[puzzleId]).catch(function () {}); }

/** This browser's rating for a puzzle: {rating: 1-4} or {skipped: true} or null. */
export function getMyRating(puzzleId) {
  try { var r = JSON.parse(localStorage.getItem(RATING_NS + puzzleId) || 'null'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; }
}
function setMyRating(puzzleId, v) {
  try { localStorage.setItem(RATING_NS + puzzleId, JSON.stringify(v)); } catch (e) { /* ignore */ }
}

/** Save a rating locally and send it (when sharing is on). */
export function rate(puzzleId, rating) {
  setMyRating(puzzleId, { rating: rating, at: new Date().toISOString() });
  if (state.previewMode || !statsSharingEnabled() || !isStatsEligible(puzzleId)) return Promise.resolve();
  var anon = getAnonId();
  if (!anon) return Promise.resolve();
  delete statsCache[puzzleId];
  return (pending[puzzleId] = queueAndFlush({ event: 'rate', puzzleId: puzzleId, anonId: anon, rating: rating }));
}
export function skipRating(puzzleId) {
  if (!getMyRating(puzzleId)) setMyRating(puzzleId, { skipped: true });
}

/* ── Reading the public totals ───────────────────────────────────── */

/** puzzle_stats rows for eligible ids, one request for all of them.
    Resolves to {id: row|null}; ids that failed to load are left out. */
export function fetchClassStats(ids, opts) {
  var want = (ids || []).filter(isStatsEligible);
  var fresh = opts && opts.fresh;
  var missing = want.filter(function (id) { return fresh || !(id in statsCache); });
  var cfg = config();
  var done = function () {
    var out = {};
    want.forEach(function (id) { if (id in statsCache) out[id] = statsCache[id]; });
    return out;
  };
  if (!missing.length || !cfg || state.previewMode) return Promise.resolve(done());
  var q = cfg.url + '/rest/v1/puzzle_stats?select=*&puzzle_id=in.(' + missing.map(encodeURIComponent).join(',') + ')';
  return timedFetch(q, { method: 'GET', headers: { apikey: cfg.key, Accept: 'application/json' } }).then(function (r) {
    if (!r || !r.ok) return null;
    return r.json().catch(function () { return null; });
  }).then(function (rows) {
    if (!Array.isArray(rows)) return done();
    missing.forEach(function (id) { statsCache[id] = null; });
    rows.forEach(function (row) { if (row && missing.indexOf(row.puzzle_id) !== -1) statsCache[row.puzzle_id] = row; });
    return done();
  });
}

/** Cached row (or undefined if never loaded). For the share text. */
export function cachedClassStats(puzzleId) { return statsCache[puzzleId]; }

/** Call once at boot: hook first finishes and retry anything waiting. */
export function initRemoteStats() {
  setFirstFinishHook(sendFirstFinish);
  if (state.previewMode || state.editorMode) return;
  setTimeout(flushOutbox, 1500); // after the menu is drawn; never blocks it
}

/** The share-stats switch changed. Off: forget anything still waiting. */
export function onShareSettingChanged() {
  if (!statsSharingEnabled()) clearOutbox();
  else flushOutbox();
}
