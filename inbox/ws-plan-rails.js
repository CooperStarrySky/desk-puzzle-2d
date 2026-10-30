/* Puzzle workspace: Planner layout A (owner-approved mockup, option A).
   Left rail = Database, right rail = Live preview, the four tier slots in the
   middle. Each rail folds to a slim strip and reopens on click. Default: both
   folded, except an empty draft opens the Database. Each rail's open/closed
   choice and width are kept per browser. The inner edge of an open rail is a
   width bar: drag it, or focus it and use the arrow keys (Shift = bigger
   steps, Home/End = narrowest/widest); double-click resets. The tiers keep at
   least CENTER_MIN px: open rails squeeze to their minimum first, then the
   rail you didn't touch last folds, and on a small window the one open rail
   floats over the tiers. Phone (<600 px): slots only, plus a bottom bar
   (Database / Preview / Checks) that opens each as a sheet. */
import { $, $$, toast, prefJson, prefSet, modalOpen } from './ws-core.js';
import { morph, enter } from './ws-motion.js';

const KEY = 'dp2d:plan-rails';
export const RAIL = { db: { min: 260, max: 560, def: 340, name: 'Database' }, pv: { min: 300, max: 640, def: 380, name: 'Live preview' } };
export const CENTER_MIN = 460;
const STRIP = 48, GAP = 16;
const phone = () => !!(window.matchMedia && window.matchMedia('(max-width: 599px)').matches);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function load() { const v = prefJson(KEY, {}) || {}; return { db: Object.assign({ open: null, w: 0 }, v.db), pv: Object.assign({ open: null, w: 0 }, v.pv) }; }
let ST = load();
const E = { empty: false, last: 'db', shown: { db: false, pv: false }, w: { db: 0, pv: 0 } };
const save = () => prefSet(KEY, JSON.stringify(ST));
const want = (n) => (n === 'db' && E.empty) || (ST[n].open == null ? false : !!ST[n].open);
const prefW = (n) => clamp(ST[n].w || RAIL[n].def, RAIL[n].min, RAIL[n].max);
const other = (n) => (n === 'db' ? 'pv' : 'db');

/* Works out what is shown from what you asked for and the room there is. */
export function applyRails() {
  const ed = $('#editor'); if (!ed || !ed.classList.contains('la')) return;
  if (phone()) { ed.dataset.db = ed.dataset.pv = 'closed'; E.shown = { db: false, pv: false }; return; }
  const W = ed.clientWidth, open = { db: want('db'), pv: want('pv') }, w = { db: prefW('db'), pv: prefW('pv') };
  const total = () => CENTER_MIN + 2 * GAP + (open.db ? w.db : STRIP) + (open.pv ? w.pv : STRIP);
  const squeeze = (n) => { if (open[n] && total() > W) w[n] = Math.max(RAIL[n].min, w[n] - (total() - W)); };
  const minTotal = CENTER_MIN + 2 * GAP + (open.db ? RAIL.db.min : STRIP) + (open.pv ? RAIL.pv.min : STRIP);
  if (open.db && open.pv && minTotal > W) open[other(E.last)] = false; // no room for both: the one you touched last stays
  squeeze(other(E.last)); squeeze(E.last);
  const over = total() > W;
  ['db', 'pv'].forEach((n) => {
    ed.dataset[n] = open[n] ? (over ? 'over' : 'open') : 'closed';
    ed.style.setProperty('--' + n + 'w', w[n] + 'px');
    const s = $('#' + n + '-strip'); if (s) s.setAttribute('aria-expanded', String(open[n]));
    const h = $('#' + n + '-handle');
    if (h) { h.setAttribute('aria-valuenow', String(w[n])); h.setAttribute('aria-valuemin', String(RAIL[n].min)); h.setAttribute('aria-valuemax', String(maxW(n, W, open, w)));
      h.setAttribute('aria-valuetext', RAIL[n].name + ' ' + w[n] + ' pixels wide'); }
  });
  E.shown = open; E.w = w;
}
/* The widest this rail can be while the tiers keep their minimum. */
function maxW(n, W, open, w) { const o = other(n); return clamp(W - CENTER_MIN - 2 * GAP - (open[o] ? w[o] : STRIP), RAIL[n].min, RAIL[n].max); }
/* Folding, unfolding and keyboard/reset width changes glide; dragging follows the pointer as is. */
const RAILS = () => [$('#editor .rail-l'), $('#editor .rail-r')];
function glide(fn) {
  const was = { db: !!E.shown.db, pv: !!E.shown.pv };
  morph(RAILS, fn, { prop: 'width', key: (el) => el.className });
  ['db', 'pv'].forEach((n) => { if (E.shown[n] && !was[n]) enter(n === 'db' ? $('#lib') : $('#pv-col')); });
}
export function foldRail(n, on, focus) {
  ST[n].open = !!on; if (on) E.last = n; if (n === 'db' && !on) E.empty = false;
  save(); glide(applyRails);
  if (!focus) return;
  if (on && E.shown[n]) { const f = n === 'db' ? $('#sug-q') : $('#pv-fold'); if (f) f.focus(); } else { const s = $('#' + n + '-strip'); if (s) s.focus(); }
}
export const railShown = (n) => !!E.shown[n];
function setW(n, v) {
  const ed = $('#editor'); if (!ed) return;
  ST[n].w = Math.round(clamp(v, RAIL[n].min, maxW(n, ed.clientWidth, E.shown, E.w))); E.last = n; applyRails();
}
function wireHandle(n) {
  const h = $('#' + n + '-handle'); if (!h) return;
  const dir = n === 'db' ? 1 : -1; // the Database grows to the right, the preview to the left
  let x0 = 0, w0 = 0, on = false;
  const move = (e) => { if (on) setW(n, w0 + dir * (e.clientX - x0)); };
  const up = () => { if (!on) return; on = false; h.classList.remove('active'); document.body.classList.remove('resizing'); save();
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); on = true; x0 = e.clientX; w0 = E.w[n] || prefW(n);
    h.classList.add('active'); document.body.classList.add('resizing');
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  });
  h.addEventListener('keydown', (e) => {
    const w = E.w[n] || prefW(n), step = e.shiftKey ? 64 : 16, k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') glide(() => setW(n, w + (k === 'ArrowRight' ? dir : -dir) * step));
    else if (k === 'Home') glide(() => setW(n, RAIL[n].min)); else if (k === 'End') glide(() => setW(n, RAIL[n].max)); else return;
    e.preventDefault(); save();
  });
  h.addEventListener('dblclick', () => { ST[n].w = 0; save(); glide(applyRails); toast(RAIL[n].name + ' width reset'); });
}

/* ===== Phone sheets ===== */
const SHEETS = { db: '#lib', pv: '#pv-col', ck: '#ck-panel' };
export function sheet(name, on) {
  const el = $(SHEETS[name]); if (!el) return;
  if (el.classList.contains('sheet-open') === !!on) return;
  if (on) Object.keys(SHEETS).forEach((k) => { if (k !== name) sheet(k, false); });
  el.classList.toggle('sheet-open', !!on); document.body.classList.toggle('sheet-lock', !!on);
  if (name === 'ck') el.hidden = !on;
  const b = $('#pb-' + name); if (b) b.setAttribute('aria-expanded', String(!!on));
  let sc = $('#sheet-scrim');
  if (on && !sc) { sc = document.createElement('div'); sc.id = 'sheet-scrim'; sc.className = 'sheet-scrim'; sc.addEventListener('click', closeSheets); document.body.appendChild(sc); }
  if (!on && sc) sc.remove();
  if (on) { const f = name === 'db' ? $('#sug-q') : el; if (f) f.focus(); } else if (b && b.offsetParent) b.focus();
}
export const openSheet = () => Object.keys(SHEETS).find((k) => { const el = $(SHEETS[k]); return el && el.classList.contains('sheet-open'); }) || '';
export function closeSheets() { Object.keys(SHEETS).forEach((k) => sheet(k, false)); }

/* Called once per editor draw. empty = the draft has no categories yet. */
export function mountRails(empty) {
  E.empty = !!empty; E.last = 'db'; ST = load();
  ['db', 'pv'].forEach((n) => {
    const s = $('#' + n + '-strip'); if (s) s.addEventListener('click', () => foldRail(n, true, true));
    const f = $('#' + n + '-fold'); if (f) f.addEventListener('click', () => foldRail(n, false, true));
    wireHandle(n);
  });
  $$('[data-sheet]').forEach((b) => b.addEventListener('click', () => sheet(b.dataset.sheet, !$(SHEETS[b.dataset.sheet]).classList.contains('sheet-open'))));
  applyRails();
}
document.addEventListener('click', (e) => { if (e.target.closest('#lib-close, [data-sheet-x]')) closeSheets(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openSheet() || modalOpen() || $('.mnu-pop:not([hidden])')) return;
  if (e.target.closest && e.target.closest('#ms-pop, #filters.open')) return; // those close themselves first
  e.preventDefault(); closeSheets();
});
let rt = 0;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!phone() && openSheet()) closeSheets(); applyRails(); }, 60); });

/* ===== Header pills: Checks and Faculty approval open small popovers ===== */
const POPS = [['#ck-pill', '#ck-panel'], ['#appr-pill', '#appr']];
function setPop(b, p, on, focus) {
  p.hidden = !on; b.setAttribute('aria-expanded', String(on));
  if (on) { POPS.forEach(([b2, p2]) => { const B = $(b2), P = $(p2); if (P && P !== p && !P.hidden && !P.classList.contains('sheet-open')) setPop(B, P, false); }); if (focus) p.focus(); }
  else if (focus) b.focus();
}
document.addEventListener('click', (e) => {
  POPS.forEach(([bs, ps]) => {
    const b = $(bs), p = $(ps); if (!b || !p || p.classList.contains('sheet-open')) return;
    if (b.contains(e.target)) setPop(b, p, p.hidden, false);
    else if (!p.hidden && e.target.isConnected && !p.contains(e.target) && !e.target.closest('#modal-root, .toast, #toast')) setPop(b, p, false);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || modalOpen()) return;
  POPS.forEach(([bs, ps]) => { const b = $(bs), p = $(ps); if (b && p && !p.hidden && !p.classList.contains('sheet-open')) { e.preventDefault(); setPop(b, p, false, true); } });
});
