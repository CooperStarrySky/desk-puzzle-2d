/* Puzzle workspace: the Planner's Database (left rail; was "Category library").
   Same search, filters, active-filter chips and sorts as the Category database
   tab: ws-cat-filters.js runs them through a planner context (library items,
   so each group of an old full puzzle counts on its own) plus a few
   planner-only filters (images, draft usage, min 👍, submitted within, kind).
   Trash never shows. Filters and sort last for the session, across drafts.
   Desktop: cards drag onto the slots by their ⠿ handle; "Add to draft…" (then
   choose a tier) does the same without a mouse. 👁 View, or hovering a card,
   shows what is inside without adding it (ws-plan-peek.js). Folding, widths
   and the phone sheets: ws-plan-rails.js. */
import { $, esc, TIER_WORDS, ZONES, lc } from './ws-core.js';
import { matchRow, stFrom, searchIds } from './ws-suggest.js';
import { searchHtml, renderFilters, renderActive, wireFilters, blankF, CAT_SORTS } from './ws-cat-filters.js';
import { PL, libraryPool, votesFor, imageCount, tierOfKey, otherDrafts, slotsOf } from './ws-plan-data.js';
import { sheet } from './ws-plan-rails.js';
import { wirePeek, viewDialog } from './ws-plan-peek.js';

const CTYPES = [['slide', 'Slide'], ['xray', 'X-ray'], ['photo', 'Photo'], ['text', 'Text']];
const ST_WORDS = { new: 'New', draft: 'In a draft', used: 'Used' };
const NO_USE = { times_used: 0, as_is: 0, adapted: 0, schools: [], drafts_count: 0 };
export const LIB_SORTS = CAT_SORTS.concat([['diff', 'Difficulty (easy→hard)'], ['imgs', 'Fewest images']]);
/* Planner-only filters, drawn under "More filters" by ws-cat-filters.js (chips and Clear all included). */
const EXTRA = [
  { key: 'img', label: 'Images', def: 'any', opts: [['any', 'Any'], ['has', 'Has images'], ['text', 'Text only']] },
  { key: 'duse', label: 'Draft usage', def: 'any', opts: [['any', 'Any'], ['none', 'Not in any draft'], ['other', 'In another draft'], ['this', 'In this draft']] },
  { key: 'minv', label: 'Min 👍', def: '0', opts: [['0', 'Any'], ['1', '1+'], ['2', '2+'], ['3', '3+']] },
  { key: 'within', label: 'Submitted within', def: 'any', opts: [['any', 'Any time'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']] },
  { key: 'kind', label: 'Kind', def: 'any', opts: [['any', 'Any'], ['category', 'Category'], ['group', 'Group from a full puzzle']] }];
const PF0 = () => Object.assign(blankF('all'), { sort: 'votes', img: 'any', duse: 'any', minv: '0', within: 'any', kind: 'any' });
let PF = PF0();
const PS = { hits: null, hitQ: '', seq: 0 };
/* The drag in progress ("lib:<key>" or "slot:<tier>"), for browsers that hide dataTransfer until drop. */
export const DND = { v: '' };
/* Set by the editor: what "Add to draft…", "Details" and dropping a slot back here do. */
export const LIB = { draft: null, canEdit: false, onAdd: null, onDetails: null, onRemove: null };
/* Touch screens get tap-to-choose instead of drag and drop. */
export const TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
document.documentElement.classList.toggle('touch', TOUCH);
/* Phone: the Database as a bottom sheet over the slots. */
export const libSheet = (on) => sheet('db', on);

export const useOfItem = (it) => (it.sid && PL.usage.get(it.sid)) || NO_USE;
export const stOfItem = (it) => stFrom(it.sub || {}, useOfItem(it));
export const ST_LABEL = (it) => ST_WORDS[stOfItem(it)] || '';
const kindsOf = (it) => new Set(it.items.map((c) => (ZONES[c.zone] || [])[2]).filter(Boolean));
const hay = (it) => lc([it.name, it.explanation, it.parent, it.credit && it.credit.name].concat(it.items.map((c) => c.label + ' ' + (c.note || ''))).join(' \n '));
/* Every placeable category not in Trash (rebuilt when the planner reloads). */
let POOL = { src: null, list: [] };
function pool() {
  if (POOL.src !== PL.subs) POOL = { src: PL.subs, list: libraryPool().filter((it) => it.status !== 'trashed' && it.status !== 'declined').map((it) => Object.assign(it, { kinds: kindsOf(it), hay: hay(it) })) };
  return POOL.list;
}
function itemMatch(it, skip) {
  const F = PF, d = LIB.draft;
  if (!matchRow(it.sub, skip, F, { u: useOfItem(it), tier: it.tier, kinds: it.kinds, hits: PS.hits, text: it.hay })) return false;
  const n = imageCount(it);
  if ((F.img === 'has' && !n) || (F.img === 'text' && n)) return false;
  if (F.duse !== 'any') {
    const here = d ? tierOfKey(d.id, it.key) : 0, other = d ? otherDrafts(it.key, d.id).length : 0;
    if ((F.duse === 'none' && (here || other)) || (F.duse === 'other' && !other) || (F.duse === 'this' && !here)) return false;
  }
  if (votesFor(it).length < Number(F.minv)) return false;
  if (F.within !== 'any' && Date.now() - new Date(it.created_at).getTime() > Number(F.within) * 864e5) return false;
  return F.kind === 'any' || it.kind === F.kind;
}
const byName = (a, b) => a.name.localeCompare(b.name);
const newest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : byName(a, b));
const BY = { newest, oldest: (a, b) => -newest(a, b), name: byName, votes: (a, b) => votesFor(b).length - votesFor(a).length || newest(a, b),
  used: (a, b) => useOfItem(b).times_used - useOfItem(a).times_used || newest(a, b), unused: (a, b) => useOfItem(a).times_used - useOfItem(b).times_used || newest(a, b),
  diff: (a, b) => (a.tier || 9) - (b.tier || 9) || byName(a, b), imgs: (a, b) => imageCount(a) - imageCount(b) || byName(a, b) };
export const libItems = () => pool().filter((it) => itemMatch(it)).sort(BY[PF.sort] || BY.votes);

async function libRefresh(focusSel) {
  const q = PF.q.trim();
  if (q !== PS.hitQ) {
    const seq = ++PS.seq; let hits = null;
    if (q) { try { hits = await searchIds(q); } catch (e) { hits = null; /* the local text match still works */ } }
    if (seq !== PS.seq) return;
    PS.hits = hits; PS.hitQ = q;
  }
  renderFilters(); renderActive(); renderLib();
  if (focusSel) { const b = $(focusSel); if (b) b.focus(); }
}
/* The context ws-cat-filters.js works through while the Planner is on screen. */
const PCTX = { F: () => PF, rows: pool, match: itemMatch, school: (it) => it.sub.school, tags: (it) => it.tags, st: stOfItem, trash: () => false,
  sorts: () => LIB_SORTS, setF: (F) => { PF = F; }, blank: PF0, refresh: libRefresh, views: false, vfrom: false, extra: EXTRA, placeholder: 'Search names, clues, notes…' };

export function alsoFlags(key) {
  return LIB.draft ? otherDrafts(key, LIB.draft.id).map((o) => '<span class="flag" title="Also in the draft ' + esc(o.title) + '">⚠ Also in ' + esc(o.title) + '</span>').join('') : '';
}
function cardHtml(it) {
  const t = LIB.draft ? tierOfKey(LIB.draft.id, it.key) : 0, vs = votesFor(it).length, imgs = imageCount(it), st = stOfItem(it);
  const kinds = Array.from(it.kinds).map((k) => (CTYPES.find((c) => c[0] === k) || [k, k])[1]).join(', ');
  const drag = !TOUCH && !!LIB.draft && LIB.canEdit;
  return '<div class="lib-card t' + (it.tier || 0) + (t ? ' in-use' : '') + '"' + (drag ? ' draggable="true"' : '') + ' data-key="' + esc(it.key) + '">' +
    '<h4>' + (drag ? '<span class="grip" title="Drag onto a slot" aria-hidden="true">⠿</span>' : '') + '<span class="tierdot" title="Suggested ' + esc(TIER_WORDS[it.tier] || '?') + '"></span><span class="lc-name">' + esc(it.name) + '</span></h4>' +
    (it.kind === 'group' ? '<p class="faint lib-from"><span class="kind-tag puzzle">Group</span> from “' + esc(it.parent) + '”</p>' : '') +
    '<p class="lc-clues">' + (it.items.length ? it.items.map((c) => esc(c.label)).join(' · ') : '<i>No clues</i>') + '</p>' +
    '<p class="faint lib-sum"><span class="st st-' + esc(st) + '">' + esc(ST_WORDS[st] || st) + '</span> ' + (it.tags.length ? esc(it.tags.join(', ')) + ' · ' : '') +
    '👍 ' + vs + ' · ' + imgs + (imgs === 1 ? ' image' : ' images') + (kinds ? ' · ' + esc(kinds) : '') + '</p>' +
    (t ? '<span class="badge in-draft">In this draft · ' + esc(TIER_WORDS[t]) + '</span>' : '') + alsoFlags(it.key) +
    '<div class="row lib-btns">' + (LIB.canEdit ? '<button type="button" class="btn small" data-add="' + esc(it.key) + '">' + (t ? 'Move…' : 'Add to draft…') + '</button>' : '') +
    '<button type="button" class="btn small ghost lc-view" data-view="' + esc(it.key) + '" aria-label="View ' + esc(it.name) + ' without adding it" title="See inside without adding it">👁 View</button></div></div>';
}
export function renderLib() {
  const el = $('#lib-list'); if (!el) return;
  const list = libItems(), all = pool().length;
  el.innerHTML = list.length ? list.map(cardHtml).join('') : '<p class="empty">Nothing matches. Try clearing a filter.</p>';
  $('#lib-n').textContent = 'Showing ' + list.length + ' of ' + all;
  const c = $('#lib-count'); if (c) c.textContent = all + (all === 1 ? ' category' : ' categories');
  const s = $('#db-cnt'); if (s) s.textContent = String(list.length);
}
/* The rail's inside (the editor draws it; ids match the Category database tab so one filter module serves both). */
export function libHtml(tip) {
  return '<div class="lib-head"><h2 id="lib-h">Database</h2><span class="faint lib-count" id="lib-count"></span>' +
    '<button type="button" class="btn small ghost rail-x" id="db-fold" aria-controls="lib" aria-label="Fold the Database" title="Fold the Database">«</button>' +
    '<button type="button" class="btn small primary lib-close" id="lib-close">Done</button></div>' + searchHtml(PCTX) +
    '<div class="row lib-ftools"><button type="button" class="btn small" id="f-toggle" aria-controls="filters" aria-expanded="false">Filters</button></div>' +
    '<div class="active-f" id="active-f" aria-label="Active filters"></div><div class="f-scrim" id="f-scrim" hidden></div>' +
    '<aside class="filters lib-filters" id="filters" aria-label="Database filters"></aside>' + tip +
    '<p class="result-n" id="lib-n" aria-live="polite"></p><div class="lib-list" id="lib-list"></div>';
}
/* Wires the Database once per editor draw (the elements are new each time). */
export function wireLib() {
  const lib = $('#lib'); if (!lib) return;
  wireFilters(PCTX);
  $('#filters').classList.toggle('open', !!PF.drawer); $('#f-toggle').setAttribute('aria-expanded', String(!!PF.drawer));
  lib.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'); if (add && lib.contains(add) && LIB.onAdd) { LIB.onAdd(add.dataset.add, add); return; }
    const v = e.target.closest('[data-view]'); if (v && lib.contains(v)) viewDialog(v.dataset.view);
  });
  lib.addEventListener('dragstart', (e) => {
    const c = e.target.closest && e.target.closest('.lib-card'); if (!c) return;
    DND.v = 'lib:' + c.dataset.key; c.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', DND.v); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* read-only in some browsers */ }
  });
  lib.addEventListener('dragend', (e) => { const c = e.target.closest && e.target.closest('.lib-card'); if (c) c.classList.remove('dragging'); DND.v = ''; });
  // Drag a slot back onto the Database to take it out of the draft.
  lib.addEventListener('dragover', (e) => { if (DND.v.startsWith('slot:')) { e.preventDefault(); lib.classList.add('drop-back'); } });
  lib.addEventListener('dragleave', (e) => { if (!lib.contains(e.relatedTarget)) lib.classList.remove('drop-back'); });
  lib.addEventListener('drop', (e) => {
    lib.classList.remove('drop-back');
    let v = ''; try { v = e.dataTransfer.getData('text/plain'); } catch (x) { /* */ }
    v = v || DND.v; DND.v = '';
    if (!v.startsWith('slot:')) return;
    e.preventDefault(); if (LIB.onRemove) LIB.onRemove(Number(v.slice(5)));
  });
  wirePeek(lib);
  libRefresh();
}
/* Which tiers already hold something (for the slot picker). */
export const tiersUsed = () => (LIB.draft ? slotsOf(LIB.draft.id) : []);
/* Sign-out: forget the filters. */
export function resetLib() { PF = PF0(); PS.hits = null; PS.hitQ = ''; POOL = { src: null, list: [] }; }
