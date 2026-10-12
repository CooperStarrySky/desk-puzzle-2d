/* Puzzle workspace: the Planner's suggestion library (left column). Filters
   and sort last for the session, across drafts. Cards drag onto the slots;
   "Add to slot…" does the same without a mouse. */
import { $, $$, esc, toast, TIER_WORDS, STATUS_WORDS, ZONES, lc } from './ws-core.js';
import { BLOCKS } from './ws-suggest.js';
import { libraryPool, votesFor, imageCount, tierOfKey, otherDrafts, slotsOf } from './ws-plan-data.js';

const CTYPES = [['slide', 'Slide'], ['xray', 'X-ray'], ['photo', 'Photo'], ['text', 'Text']];
export const LIB_SORTS = [['votes', 'Most 👍'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['short', 'Recently shortlisted'], ['name', 'Name A–Z'], ['diff', 'Difficulty (easy→hard)'], ['imgs', 'Fewest images']];
const LF0 = { st: 'short', kind: [], tier: [], ct: [], block: [], sub: 'all', img: 'any', use: 'any', votes: '0', within: 'any' };
const clone = (o) => JSON.parse(JSON.stringify(o));
let LF = clone(LF0);
const LX = { open: false, sort: 'votes', q: '' };
/* The drag in progress ("lib:<key>" or "slot:<tier>"), for browsers that hide dataTransfer until drop. */
export const DND = { v: '' };
/* Set by the editor: what "Add to slot…", "Details" and dropping a slot back here do. */
export const LIB = { draft: null, onAdd: null, onDetails: null, onRemove: null };

const clueKinds = (it) => new Set(it.items.map((c) => (ZONES[c.zone] || [])[2]).filter(Boolean));
const hay = (it) => lc([it.name, it.explanation, it.parent, it.credit && it.credit.name].concat(it.items.map((c) => c.label + ' ' + (c.note || ''))).join(' \n '));
export function libItems() {
  const d = LIB.draft, q = lc(LX.q), now = Date.now();
  const list = libraryPool().filter((it) => {
    if (LF.st === 'short' ? it.status !== 'shortlisted' : LF.st === 'new' ? it.status !== 'new' : it.status === 'declined') return false;
    if (LF.kind.length && !LF.kind.includes(it.kind)) return false;
    if (LF.tier.length && !LF.tier.includes(String(it.tier))) return false;
    if (LF.ct.length) { const k = clueKinds(it); if (!LF.ct.some((c) => k.has(c))) return false; }
    if (LF.block.length && !it.tags.some((t) => LF.block.includes(t))) return false;
    if ((LF.sub === 'named' && !it.credit) || (LF.sub === 'anon' && it.credit)) return false;
    const n = imageCount(it); if ((LF.img === 'has' && !n) || (LF.img === 'text' && n)) return false;
    const here = d ? tierOfKey(d.id, it.key) : 0, other = d ? otherDrafts(it.key, d.id).length : 0;
    if (LF.use === 'none' && (here || other)) return false;
    if (LF.use === 'other' && !other) return false;
    if (LF.use === 'this' && !here) return false;
    if (votesFor(it).length < Number(LF.votes)) return false;
    if (LF.within !== 'any' && now - new Date(it.created_at).getTime() > Number(LF.within) * 86400000) return false;
    return !q || q.split(/\s+/).every((w) => hay(it).includes(w));
  });
  const name = (a, b) => a.name.localeCompare(b.name);
  const by = { votes: (a, b) => votesFor(b).length - votesFor(a).length || (a.created_at < b.created_at ? 1 : -1),
    newest: (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : name(a, b)), oldest: (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : name(a, b)),
    short: (a, b) => (a.shortAt === b.shortAt ? name(a, b) : a.shortAt < b.shortAt ? 1 : -1), name,
    diff: (a, b) => (a.tier || 9) - (b.tier || 9) || name(a, b), imgs: (a, b) => imageCount(a) - imageCount(b) || name(a, b) };
  return list.sort(by[LX.sort] || by.votes);
}
const activeN = () => Object.keys(LF0).filter((k) => JSON.stringify(LF[k]) !== JSON.stringify(LF0[k])).length;
export function alsoFlags(key) {
  return LIB.draft ? otherDrafts(key, LIB.draft.id).map((o) => '<span class="flag" title="Also in the draft ' + esc(o.title) + '">⚠ Also in ' + esc(o.title) + '</span>').join('') : '';
}
function cardHtml(it) {
  const t = LIB.draft ? tierOfKey(LIB.draft.id, it.key) : 0, vs = votesFor(it).length, imgs = imageCount(it);
  const kinds = Array.from(clueKinds(it)).map((k) => (CTYPES.find((c) => c[0] === k) || [k, k])[1]).join(', ');
  return '<div class="lib-card t' + (it.tier || 0) + (t ? ' in-use' : '') + '" draggable="true" data-key="' + esc(it.key) + '">' +
    '<h4><span class="tierdot" title="Suggested ' + esc(TIER_WORDS[it.tier] || '?') + '"></span>' + esc(it.name) + '</h4>' +
    (it.kind === 'group' ? '<p class="faint lib-from"><span class="kind-tag puzzle">Group</span> from the full puzzle “' + esc(it.parent) + '”</p>' : '') +
    '<p class="lib-ex">' + (it.explanation.trim() ? esc(it.explanation) : '<i>No explanation yet</i>') + '</p>' +
    '<ul class="lib-clues">' + it.items.map((c) => '<li><span aria-hidden="true">' + ((ZONES[c.zone] || [])[1] || '•') + '</span>' + esc(c.label) + '</li>').join('') + '</ul>' +
    '<p class="faint lib-sum">' + it.items.length + ' clues · ' + esc(kinds || 'no clues') + '</p>' +
    '<div class="row lib-meta"><span class="st st-' + esc(it.status) + '">' + esc(STATUS_WORDS[it.status] || it.status) + '</span>' +
    '<span class="faint">' + (it.tags.length ? esc(it.tags.join(', ')) + ' · ' : '') + '👍 ' + vs + ' · ' + imgs + (imgs === 1 ? ' image' : ' images') + '</span></div>' +
    (t ? '<span class="badge in-draft">In this draft · ' + esc(TIER_WORDS[t]) + '</span>' : '') + alsoFlags(it.key) +
    '<div class="row lib-btns"><button type="button" class="btn small" data-add="' + esc(it.key) + '">' + (t ? 'Move to slot…' : 'Add to slot…') + '</button>' +
    '<button type="button" class="btn small ghost" data-det="' + esc(it.key) + '">Details</button></div></div>';
}
export function renderLib() {
  const el = $('#lib-list'); if (!el) return;
  const list = libItems(), all = libraryPool().filter((it) => it.status !== 'declined');
  el.innerHTML = list.length ? list.map(cardHtml).join('') : '<p class="empty">Nothing matches. Try clearing a filter.</p>';
  $('#lib-n').textContent = 'Showing ' + list.length + ' of ' + all.length;
}
function sel(key, label, opts) {
  return '<label class="field"><span>' + label + '</span><select class="input" data-lf="' + key + '">' + opts.map((o) => '<option value="' + o[0] + '"' + (LF[key] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
}
function chips(key, label, opts) {
  return '<fieldset class="fgroup"><legend class="eyebrow">' + label + '</legend><div class="chips">' + opts.map((o) =>
    '<button type="button" class="chip" data-lfc="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + LF[key].includes(o[0]) + '">' + (o[2] || '') + esc(o[1]) + '</button>').join('') + '</div></fieldset>';
}
export function renderLibTools() {
  const el = $('#lib-tools'); if (!el) return;
  const n = activeN(), blocks = BLOCKS.slice(); libraryPool().forEach((it) => it.tags.forEach((t) => { if (!blocks.includes(t)) blocks.push(t); }));
  el.innerHTML = '<div class="lf-bar"><button type="button" class="chip" id="lf-toggle" aria-expanded="' + LX.open + '" aria-controls="lf-panel">Filters' + (n ? ' <span class="n" id="lf-n">' + n + '</span>' : '') + '</button>' +
    (n ? '<button type="button" class="btn small ghost" id="lf-clear">Clear</button>' : '') +
    '<label class="sr" for="lf-sort">Sort library</label><select class="input" id="lf-sort">' + LIB_SORTS.map((o) => '<option value="' + o[0] + '"' + (LX.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
    '<div class="lf-panel" id="lf-panel"' + (LX.open ? '' : ' hidden') + '><div class="lf-selects">' +
    sel('st', 'Status', [['short', 'Shortlisted'], ['new', 'New'], ['all', 'All (not declined)']]) + sel('sub', 'Submitter', [['all', 'Anyone'], ['named', 'Named'], ['anon', 'Anonymous']]) +
    sel('img', 'Images', [['any', 'Any'], ['has', 'Has images'], ['text', 'Text only']]) +
    sel('use', 'Draft usage', [['any', 'Any'], ['none', 'Not in any draft'], ['other', 'In another draft'], ['this', 'In this draft']]) +
    sel('votes', 'Min 👍', [['0', 'Any'], ['1', '1+'], ['2', '2+'], ['3', '3+']]) + sel('within', 'Submitted within', [['any', 'Any time'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']]) + '</div>' +
    chips('kind', 'Kind', [['category', 'Category'], ['group', 'Group from full puzzle']]) +
    chips('tier', 'Suggested difficulty', [1, 2, 3, 4].map((t) => [String(t), TIER_WORDS[t], '<span class="tierdot t' + t + '"></span>'])) +
    chips('ct', 'Clue types', CTYPES) + chips('block', 'Block / system', blocks.map((b) => [b, b])) + '</div>' +
    '<p class="result-n" id="lib-n" aria-live="polite"></p>';
}
function again(focusSel) { renderLibTools(); renderLib(); const f = focusSel && $(focusSel); if (f) f.focus(); }
/* Wires the library column once per editor draw (the elements are new each time). */
export function wireLib() {
  const lib = $('#lib'); if (!lib) return;
  let timer = 0;
  $('#lib-q').value = LX.q;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { LX.q = e.target.value; renderLib(); }, 200); });
  lib.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#lf-toggle')) { LX.open = !LX.open; again('#lf-toggle'); return; }
    if (t.id === 'lf-clear') { LF = clone(LF0); toast('Library filters cleared'); again('#lf-toggle'); return; }
    const c = t.closest('[data-lfc]');
    if (c) { const a = LF[c.dataset.lfc], i = a.indexOf(c.dataset.v); if (i < 0) a.push(c.dataset.v); else a.splice(i, 1); again('[data-lfc="' + c.dataset.lfc + '"][data-v="' + CSS.escape(c.dataset.v) + '"]'); return; }
    const add = t.closest('[data-add]'); if (add && LIB.onAdd) { LIB.onAdd(add.dataset.add, add); return; }
    const det = t.closest('[data-det]'); if (det && lib.contains(det) && LIB.onDetails) LIB.onDetails(det.dataset.det);
  });
  lib.addEventListener('change', (e) => {
    if (e.target.id === 'lf-sort') { LX.sort = e.target.value; again('#lf-sort'); return; }
    const k = e.target.dataset.lf; if (k) { LF[k] = e.target.value; again('[data-lf="' + k + '"]'); }
  });
  lib.addEventListener('dragstart', (e) => {
    const c = e.target.closest && e.target.closest('.lib-card'); if (!c) return;
    DND.v = 'lib:' + c.dataset.key; c.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', DND.v); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* read-only in some browsers */ }
  });
  lib.addEventListener('dragend', (e) => { const c = e.target.closest && e.target.closest('.lib-card'); if (c) c.classList.remove('dragging'); DND.v = ''; });
  // Drag a slot back onto the library to take it out of the draft.
  lib.addEventListener('dragover', (e) => { if (DND.v.startsWith('slot:')) { e.preventDefault(); lib.classList.add('drop-back'); } });
  lib.addEventListener('dragleave', (e) => { if (!lib.contains(e.relatedTarget)) lib.classList.remove('drop-back'); });
  lib.addEventListener('drop', (e) => {
    lib.classList.remove('drop-back');
    let v = ''; try { v = e.dataTransfer.getData('text/plain'); } catch (x) { /* */ }
    v = v || DND.v; DND.v = '';
    if (!v.startsWith('slot:')) return;
    e.preventDefault(); if (LIB.onRemove) LIB.onRemove(Number(v.slice(5)));
  });
  renderLibTools(); renderLib(); wireResize();
}
/* Which tiers already hold something (for the slot picker). */
export const tiersUsed = () => (LIB.draft ? slotsOf(LIB.draft.id) : []);

/* ===== Resizable library: drag its right edge, or arrow keys on the handle ===== */
const W_KEY = 'dp2d:ws-libw', MIN = 220;
function savedW() { try { return Number(sessionStorage.getItem(W_KEY)) || 0; } catch (e) { return 0; } }
function wireResize() {
  const h = $('#lib-handle'), ed = $('#editor'), lib = $('#lib'); if (!h || !ed || !lib) return;
  const maxW = () => { const w = ed.clientWidth, cols = getComputedStyle(ed).gridTemplateColumns.split(' ').length; return Math.max(MIN, Math.min(640, cols >= 3 ? w - 340 - 32 - 300 : w - 16 - 340)); };
  const show = (w) => { h.setAttribute('aria-valuenow', String(Math.round(w))); h.setAttribute('aria-valuetext', Math.round(w) + ' pixels wide'); h.setAttribute('aria-valuemax', String(maxW())); };
  const set = (w) => { w = Math.round(Math.max(MIN, Math.min(maxW(), w))); ed.style.setProperty('--libw', w + 'px'); show(w); try { sessionStorage.setItem(W_KEY, String(w)); } catch (e) { /* storage off */ } };
  if (savedW()) ed.style.setProperty('--libw', Math.min(savedW(), maxW()) + 'px');
  show(lib.getBoundingClientRect().width);
  let x0 = 0, w0 = 0, on = false;
  const move = (e) => { if (on) set(w0 + e.clientX - x0); };
  const up = () => { if (!on) return; on = false; h.classList.remove('active'); document.body.classList.remove('resizing');
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); on = true; x0 = e.clientX; w0 = lib.getBoundingClientRect().width;
    h.classList.add('active'); document.body.classList.add('resizing');
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  });
  h.addEventListener('keydown', (e) => {
    const w = lib.getBoundingClientRect().width, k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') set(w + (k === 'ArrowRight' ? 24 : -24));
    else if (k === 'Home') set(MIN); else if (k === 'End') set(maxW()); else return;
    e.preventDefault();
  });
  h.addEventListener('dblclick', () => { ed.style.removeProperty('--libw'); try { sessionStorage.removeItem(W_KEY); } catch (e) { /* */ } show(lib.getBoundingClientRect().width); toast('Library width reset'); });
}
