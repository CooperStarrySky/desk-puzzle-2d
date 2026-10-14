/* Puzzle workspace: the Category database's filter sidebar can fold to a slim
   strip (with the number of filters on) and be dragged wider or narrower, like
   the Planner's rails. The width bar works with the keyboard too: arrow keys
   (Shift = bigger steps), Home/End = narrowest/widest; double-click resets.
   Folded or not and the width are kept per browser. Desktop only: on a phone
   the filters are a drawer (ws-cat-filters.js). */
import { $, toast, prefJson, prefSet } from './ws-core.js';

const KEY = 'dp2d:cat-filters';
export const SIDE = { min: 200, max: 440, def: 250 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const load = () => Object.assign({ fold: false, w: 0 }, prefJson(KEY, {}) || {});
let ST = load();
const save = () => prefSet(KEY, JSON.stringify(ST));
const width = () => clamp(ST.w || SIDE.def, SIDE.min, SIDE.max);

export function sideStrip() {
  return '<button type="button" class="strip f-strip" id="f-strip" aria-controls="filters" aria-expanded="true" title="Open the filters">' +
    '<span class="ic" aria-hidden="true">≡</span><span class="vl">Filters</span><span class="cnt" id="f-strip-n" hidden></span><span class="ar" aria-hidden="true">»</span></button>';
}
export function sideHandle() {
  return '<div class="rail-handle f-handle" id="f-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="filters" aria-label="Filters width" ' +
    'title="Drag to resize · double-click to reset"></div>';
}
/* The badge on the folded strip. */
export function sideCount(n) {
  const c = $('#f-strip-n'); if (!c) return;
  c.hidden = !n; c.textContent = n ? String(n) : '';
  const s = $('#f-strip'); if (s) s.setAttribute('aria-label', 'Open the filters' + (n ? ' (' + n + ' on)' : ''));
}
export function applySide() {
  const L = $('#ws-main .sug-layout'); if (!L) return;
  const w = width();
  L.dataset.fold = ST.fold ? 'closed' : 'open';
  L.style.setProperty('--fw', w + 'px');
  const s = $('#f-strip'); if (s) s.setAttribute('aria-expanded', String(!ST.fold));
  const h = $('#f-handle');
  if (h) { h.setAttribute('aria-valuenow', String(w)); h.setAttribute('aria-valuemin', String(SIDE.min)); h.setAttribute('aria-valuemax', String(SIDE.max)); h.setAttribute('aria-valuetext', 'Filters ' + w + ' pixels wide'); }
}
export function foldSide(on, focus) {
  ST.fold = !!on; save(); applySide();
  if (!focus) return;
  const f = on ? $('#f-strip') : $('#f-fold'); if (f) f.focus();
}
function setW(v) { ST.w = Math.round(clamp(v, SIDE.min, SIDE.max)); applySide(); }
/* Once per draw of the tab. */
export function mountSide() {
  ST = load();
  const s = $('#f-strip'), h = $('#f-handle');
  if (s) s.addEventListener('click', () => foldSide(false, true));
  if (h) {
    let x0 = 0, w0 = 0, on = false;
    const move = (e) => { if (on) setW(w0 + e.clientX - x0); };
    const up = () => { if (!on) return; on = false; h.classList.remove('active'); document.body.classList.remove('resizing'); save();
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); on = true; x0 = e.clientX; w0 = width();
      h.classList.add('active'); document.body.classList.add('resizing');
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    });
    h.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16, k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') setW(width() + (k === 'ArrowRight' ? step : -step));
      else if (k === 'Home') setW(SIDE.min); else if (k === 'End') setW(SIDE.max); else return;
      e.preventDefault(); save();
    });
    h.addEventListener('dblclick', () => { ST.w = 0; save(); applySide(); toast('Filters width reset'); });
  }
  applySide();
}
