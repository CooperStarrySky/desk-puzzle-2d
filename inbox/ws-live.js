/* Puzzle workspace: live syncing and "who else is here" (Supabase Realtime).
   The database sends a small note after every change (which table, which ids,
   who did it; never the content) on PRIVATE channels:
     ws:bank            the shared category database (every member)
     ws:school:<slug>   one school's drafts + who is online there (presence)
   The row rules on realtime.messages decide who may join a channel
   (supabase/migrations/20261015120000_live_sync.sql). On a note the page
   fetches fresh rows through the normal row rules and redraws in place.
   If Realtime is missing or down, nothing here runs and the workspace works
   exactly as before (Refresh buttons). Imports only ws-core.js. */
import { S, $, $$, esc, lc, av, person } from './ws-core.js';

const L = { on: false, chans: new Map(), onNotes: null, where: () => null, queue: [], qTimer: 0,
  pres: new Map(), tracked: new Map(), tab: Math.random().toString(36).slice(2, 8), hiddenAt: 0, down: false };
const RETRY_MS = [2000, 5000, 15000, 30000, 60000, 120000];

export const liveOn = () => L.on;
/* Topics I belong to: the bank, plus each of my schools (every school for the site owner). */
function topics() {
  const schools = S.owner ? Array.from(S.schools.keys()) : Object.keys(S.roles || {});
  return ['ws:bank'].concat(schools.filter(Boolean).sort().map((s) => 'ws:school:' + s));
}
const schoolOf = (topic) => (topic.startsWith('ws:school:') ? topic.slice(10) : null);

/* Start after sign-in. onNotes(batch) gets the notes of the last moment (or
   [{ t: '*' }] = "you may have missed things, check everything"). where()
   says what I have open: { view: 'draft' | 'cat', id, school, tier }. */
export function startLive(onNotes, where) {
  stopLive();
  const sb = S.sb;
  if (!sb || typeof sb.channel !== 'function' || typeof sb.removeChannel !== 'function') return false;
  L.on = true; L.onNotes = onNotes; L.where = where || (() => null);
  let auth = null;
  try { auth = sb.realtime && typeof sb.realtime.setAuth === 'function' ? sb.realtime.setAuth() : null; } catch (e) { auth = null; }
  Promise.resolve(auth).catch(() => {}).then(() => { if (L.on) topics().forEach(join); });
  return true;
}
export function stopLive() {
  const sb = S.sb;
  L.on = false; clearTimeout(L.qTimer); L.queue = [];
  L.chans.forEach((c) => { clearTimeout(c.timer); try { if (c.ch && sb) sb.removeChannel(c.ch); } catch (e) { /* gone */ } });
  L.chans.clear(); L.pres.clear(); L.tracked.clear(); L.down = false;
  paint();
}
function join(topic) {
  const sb = S.sb, school = !!schoolOf(topic);
  const prev = L.chans.get(topic) || { tries: 0, wasDown: false };
  let ch;
  try {
    ch = sb.channel(topic, { config: Object.assign({ private: true }, school ? { presence: { key: S.me + '#' + L.tab } } : {}) });
    ch.on('broadcast', { event: 'change' }, (m) => note(m && m.payload));
    if (school) ch.on('presence', { event: 'sync' }, () => presSync(topic));
  } catch (e) { return; } // Realtime not usable: stay quiet, the page works as before
  const c = { ch, ok: false, tries: prev.tries, wasDown: prev.wasDown, timer: 0 };
  L.chans.set(topic, c);
  ch.subscribe((status) => {
    if (!L.on || L.chans.get(topic) !== c) return;
    if (status === 'SUBSCRIBED') {
      const missed = c.wasDown;
      c.ok = true; c.tries = 0; c.wasDown = false; L.down = !allOk();
      if (school) { L.tracked.delete(topic); presenceChanged(); }
      if (missed) push({ t: '*' }); // back online: catch up on what we missed
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      c.ok = false; c.wasDown = true; L.down = true; L.pres.delete(topic); paint();
      if (c.timer || c.tries >= RETRY_MS.length) return; // gave up: tab focus still refreshes
      c.timer = setTimeout(() => {
        c.timer = 0; c.tries++;
        if (!L.on || L.chans.get(topic) !== c) return;
        L.chans.set(topic, { tries: c.tries, wasDown: true }); // first, so the CLOSED from removeChannel is ignored
        try { sb.removeChannel(ch); } catch (e) { /* already gone */ }
        join(topic);
      }, RETRY_MS[Math.min(c.tries, RETRY_MS.length - 1)]);
    }
  });
}
const allOk = () => L.chans.size > 0 && Array.from(L.chans.values()).every((c) => c.ok);
export const liveHealthy = () => L.on && allOk();

/* Notes: my own changes are skipped (this page already redrew); the rest are
   gathered for a moment so a burst of changes means one refresh. */
function note(p) {
  if (!p || typeof p.t !== 'string') return;
  if (p.by && lc(p.by) === S.me) return;
  push(p);
}
function push(p) {
  L.queue.push(p);
  clearTimeout(L.qTimer);
  L.qTimer = setTimeout(flush, 350);
}
async function flush() {
  const batch = L.queue; L.queue = [];
  if (!batch.length || !L.on || !L.onNotes) return;
  try { await L.onNotes(batch); } catch (e) { /* a failed live redraw never breaks the page; Refresh still works */ }
}

/* Fallback: back on the tab after a while, or Realtime is down: check everything once. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { L.hiddenAt = Date.now(); return; }
  if (L.on && (!allOk() || (L.hiddenAt && Date.now() - L.hiddenAt > 120000))) push({ t: '*' });
  L.hiddenAt = 0;
});
window.addEventListener('online', () => { if (L.on) push({ t: '*' }); });

/* ===== Presence: who has which draft or category open (my school only) ===== */
export function presenceChanged() {
  if (!L.on) { paint(); return; }
  const w = L.where() || null;
  L.chans.forEach((c, topic) => {
    const sch = schoolOf(topic); if (!sch) return;
    const want = w && w.view && w.id && w.school === sch
      ? { e: S.me, n: person(S.me).name, v: w.view, id: String(w.id), tier: w.tier || null } : null;
    const key = JSON.stringify(want);
    if (L.tracked.get(topic) === key) return;
    if (!c.ok) return; // tracked once the channel is up
    L.tracked.set(topic, key);
    try { Promise.resolve(want ? c.ch.track(want) : c.ch.untrack()).catch(() => {}); } catch (e) { /* presence is a nicety */ }
  });
  paint();
}
function presSync(topic) {
  const c = L.chans.get(topic); if (!c || !c.ch) return;
  let st = {};
  try { st = c.ch.presenceState() || {}; } catch (e) { st = {}; }
  const list = [];
  Object.keys(st).forEach((k) => (st[k] || []).forEach((x) => { if (x && x.e && lc(x.e) !== S.me) list.push(x); }));
  L.pres.set(topic, list);
  paint();
}
/* Others (one entry per person) with this draft or category open. Someone editing wins over viewing. */
export function others(view, id) {
  const seen = new Map();
  L.pres.forEach((list) => list.forEach((x) => {
    if (x.v !== view || String(x.id) !== String(id)) return;
    const k = lc(x.e), had = seen.get(k);
    if (!had || (!had.tier && x.tier)) seen.set(k, x);
  }));
  return Array.from(seen.values()).sort((a, b) => lc(a.e).localeCompare(lc(b.e)));
}
const nameOf = (x) => person(x.e).name;
const doing = (x) => (x.tier ? 'is editing Tier ' + Number(x.tier) : 'is viewing');
export function presText(list) {
  if (!list.length) return '';
  if (list.length === 1) return nameOf(list[0]) + ' ' + doing(list[0]);
  if (list.length === 2) return nameOf(list[0]) + ' and ' + nameOf(list[1]) + ' are here';
  return nameOf(list[0]) + ' and ' + (list.length - 1) + ' others are here';
}
function paint() { paintDraft(); paintCats(); }
function paintDraft() {
  const box = $('#ed-pres'); if (!box) return;
  const w = L.where() || {};
  const list = L.on && w.view === 'draft' ? others('draft', w.id) : [];
  box.hidden = !list.length;
  box.innerHTML = list.length ? '<span class="avs">' + list.map((x) => '<span class="pres-av' + (x.tier ? ' editing' : '') + '" title="' + esc(nameOf(x) + ' ' + doing(x)) + '">' + av(x.e) + '</span>').join('') + '</span>' +
    '<span class="pres-t">' + esc(presText(list)) + '</span>' +
    list.filter((x) => x.tier).map((x) => '<span class="sr">' + esc(nameOf(x)) + ' is editing Tier ' + Number(x.tier) + '.</span>').join('') : '';
}
/* Categories: a small chip on any card someone else in my school has open. */
export function paintCats() {
  $$('#sug-list .sug-card[data-id]').forEach((card) => {
    const old = $('.pres-chip', card); if (old) old.remove();
    const list = L.on ? others('cat', card.dataset.id) : [];
    if (!list.length) return;
    const h = $('h3', card); if (!h) return;
    const words = list.length === 1 ? nameOf(list[0]) + ' has this open' : presText(list).replace(' are here', ' have this open');
    h.insertAdjacentHTML('afterend', '<span class="pres-chip" title="' + esc(words) + '"><span class="avs">' + list.slice(0, 3).map((x) => av(x.e)).join('') +
      '</span><span class="sr">' + esc(words) + '</span></span>');
  });
}

/* ===== Small helpers for the live redraws ===== */
const TEXTY = 'textarea, select, [contenteditable="true"], input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=color])';
/* Is the person typing (or choosing) inside root right now? */
export function typingIn(root) {
  const a = document.activeElement;
  return !!(root && a && a !== document.body && root.contains(a) && a.matches(TEXTY));
}
/* Has unsent text inside root (typed but not saved, focused or not)? */
export function dirtyIn(root) {
  if (!root) return false;
  return $$('textarea, input[type=text], input[type=search], input:not([type])', root).some((x) => x.value !== x.defaultValue && x.id !== 'sug-q');
}
/* Waits until busy() is false, checking every 1.5 s, then runs fn once. */
export function whenIdle(key, busy, fn) {
  if (whenIdle[key]) return;
  whenIdle[key] = setInterval(() => {
    if (busy()) return;
    clearInterval(whenIdle[key]); whenIdle[key] = 0; fn();
  }, 1500);
}
const KEYS = ['id', 'data-id', 'data-t', 'data-act', 'data-addd', 'data-restore', 'data-why', 'data-cact', 'data-cid', 'data-fill', 'data-adapt',
  'data-det', 'data-tag', 'data-row', 'data-mact', 'href'];
function selectorFor(a) {
  if (a.id) return '#' + CSS.escape(a.id);
  const own = KEYS.filter((k) => a.hasAttribute(k)).map((k) => '[' + k + '="' + CSS.escape(a.getAttribute(k)) + '"]').join('');
  const cls = a.classList[0] ? '.' + CSS.escape(a.classList[0]) : '';
  const scope = a.parentElement && a.parentElement.closest('.sug-card[data-id], .slot[data-t], .cmt[data-cid]');
  let pre = '';
  if (scope) {
    const k = scope.dataset.id != null ? 'data-id' : scope.dataset.t != null ? 'data-t' : 'data-cid';
    pre = '.' + CSS.escape(scope.classList[0]) + '[' + k + '="' + CSS.escape(scope.getAttribute(k)) + '"] ';
  }
  return own || cls ? pre + a.tagName.toLowerCase() + cls + own : null;
}
/* Runs a redraw and puts focus back where it was (same control, if it still exists). */
export async function keepFocus(fn) {
  const a = document.activeElement, sel = a && a !== document.body ? selectorFor(a) : null;
  await fn();
  if (sel && a && !a.isConnected) {
    let n = null; try { n = document.querySelector(sel); } catch (e) { n = null; }
    if (n && n.focus) n.focus({ preventScroll: true });
  }
}
/* A brief highlight plus "Updated by Marcus T." on something that changed. */
export function flash(el, by, what) {
  if (!el || !el.isConnected) return;
  const old = $(':scope > .live-by', el); if (old) old.remove();
  el.classList.remove('live-flash'); void el.offsetWidth; el.classList.add('live-flash', 'live-host');
  const tag = document.createElement('span');
  tag.className = 'live-by';
  tag.textContent = (what || 'Updated') + (by ? ' by ' + person(by).name : '');
  el.appendChild(tag);
  setTimeout(() => { tag.remove(); if (!$(':scope > .live-by', el)) el.classList.remove('live-flash'); }, 4500);
}
/* For tests and the console: what the live layer is doing. */
window.__wsLive = { state: () => ({ on: L.on, ok: allOk(), topics: Array.from(L.chans.keys()), pres: Object.fromEntries(L.pres), tracked: Object.fromEntries(L.tracked) }) };
