/* Puzzle workspace: the Planner's Database (left rail; was "Category library").
   Same search, filters, active-filter chips and sorts as the Category database
   tab: ws-cat-filters.js runs them through a planner context (library items,
   so each group of an old full puzzle counts on its own) plus a few
   planner-only filters (images, draft usage, min 👍, submitted within, kind).
   Trash never shows. Filters and sort last for the session, across drafts.
   Desktop: cards drag onto the slots by their ⠿ handle; 👁 View's "Add to
   draft…" (then choose a tier) does the same without a mouse or on touch. 👁 View, or hovering a card,
   shows what is inside without adding it (ws-plan-peek.js). Folding, widths
   and the phone sheets: ws-plan-rails.js. */
import { S, $, esc, TIER_WORDS, ZONES, lc, schName, schPill, toast, plainError, busy, fillImages, prefGet, prefSet } from './ws-core.js';
import { matchRow, stFrom, searchIds, clueImage, thumbHtml, densityHtml, DENSITY_KEY } from './ws-suggest.js';
import { searchHtml, renderFilters, renderActive, wireFilters, blankF, CAT_SORTS } from './ws-cat-filters.js';
import { PL, libraryPool, votesFor, imageCount, tierOfKey, otherDrafts, slotsOf } from './ws-plan-data.js';
import { sheet } from './ws-plan-rails.js';
import { wirePeek, viewDialog } from './ws-plan-peek.js';
import { flip, enter } from './ws-motion.js';

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
  sorts: () => LIB_SORTS, setF: (F) => { PF = F; }, blank: PF0, refresh: libRefresh, views: false, vfrom: false, extra: EXTRA, placeholder: 'Search names, clues, notes…', name: 'plan' };

export function alsoFlags(key) {
  return LIB.draft ? otherDrafts(key, LIB.draft.id).map((o) => '<span class="flag" title="Also in the draft ' + esc(o.title) + '">⚠ Also in ' + esc(o.title) + '</span>').join('') : '';
}
/* The narrow B2 card (owner-approved mockup): name + pill, one clue per line
   (image clues with a small thumbnail), one usage line with zeros hidden, then
   👁 View and 👍 (your own, toggles; the split is in the tooltip). */
function useLine(it) {
  const u = useOfItem(it), b = [];
  if (u.times_used) b.push('<span>In <b>' + u.times_used + '</b> published puzzle' + (u.times_used === 1 ? '' : 's') + '</span>');
  if (u.drafts_count) b.push('<span>In <b>' + u.drafts_count + '</b> draft' + (u.drafts_count === 1 ? '' : 's') + '</span>');
  return '<p class="lc-use">' + (b.length ? b.join('') : '<span class="zero">Not used yet</span>') + '</p>';
}
function libVoteTip(it) {
  const vs = votesFor(it), n = vs.length, mine = vs.includes(S.me), here = S.school ? vs.filter((e) => PL.voteSch.get(it.sid + '|' + e) === S.school).length : 0;
  if (!n) return 'No thumbs up yet';
  return (mine ? (n === 1 ? 'You' : 'You and ' + (n - 1) + ' other' + (n === 2 ? '' : 's')) : n + ' thumbs up') + (S.school ? ' · ' + here + ' from ' + schName(S.school) : '');
}
function cardHtml(it) {
  const t = LIB.draft ? tierOfKey(LIB.draft.id, it.key) : 0, vs = votesFor(it), mine = vs.includes(S.me), tip = libVoteTip(it);
  const drag = !TOUCH && !!LIB.draft && LIB.canEdit;
  const clues = '<ul class="b2-clues">' + (it.items.length ? it.items.map((c) => { const p = clueImage(c);
    return '<li' + (p ? ' class="img"' : '') + '>' + thumbHtml(p, c.label) + '<span class="lbl">' + esc(c.label) + '</span></li>'; }).join('') : '<li><i>No clues</i></li>') + '</ul>';
  return '<div class="lib-card b2n t' + (it.tier || 0) + (t ? ' in-use' : '') + '"' + (drag ? ' draggable="true"' : '') + ' data-key="' + esc(it.key) + '">' +
    '<div class="lc-head"><h4>' + (drag ? '<span class="grip" title="Drag onto a slot" aria-hidden="true">⠿</span>' : '') + '<span class="lc-name" title="Suggested ' + esc(TIER_WORDS[it.tier] || '?') + '">' + esc(it.name) + '</span></h4>' +
    schPill(it.sub && it.sub.school) + '</div>' +
    (it.kind === 'group' ? '<p class="faint lib-from"><span class="kind-tag puzzle">Group</span> from “' + esc(it.parent) + '”</p>' : '') + clues + useLine(it) +
    (t ? '<span class="badge in-draft">In this draft · ' + esc(TIER_WORDS[t]) + '</span>' : '') + alsoFlags(it.key) +
    '<div class="lib-btns"><button type="button" class="btn small ghost lc-view" data-view="' + esc(it.key) + '" aria-label="View ' + esc(it.name) + ' without adding it" title="See inside without adding it">👁 View</button>' +
    voteHtml(it, vs, mine, tip) + '</div></div>';
}
function voteHtml(it, vs, mine, tip) {
  return (it.sid ? '<button type="button" class="btn small vote-btn has-tip' + (mine ? ' on' : '') + '" data-lvote="' + esc(it.key) + '" aria-pressed="' + mine + '" data-tip="' + esc(tip) + '" aria-label="Thumbs up ' +
      esc(it.name) + ', ' + vs.length + ' so far. ' + esc(tip) + '">👍 ' + vs.length + '</button>' : '');
}
/* Compact row: only the name and 👍. Still drags onto a slot; clicking the row
   opens the View dialog (which has "Add to draft…", the touch way in). */
function rowHtml(it) {
  const t = LIB.draft ? tierOfKey(LIB.draft.id, it.key) : 0, vs = votesFor(it), mine = vs.includes(S.me), tip = libVoteTip(it);
  const drag = !TOUCH && !!LIB.draft && LIB.canEdit;
  return '<div class="lib-card b2n lc-row t' + (it.tier || 0) + (t ? ' in-use' : '') + '"' + (drag ? ' draggable="true"' : '') + ' data-key="' + esc(it.key) + '">' +
    '<button type="button" class="lc-name lc-open" data-view="' + esc(it.key) + '" title="View ' + esc(it.name) + (t ? ' (in this draft · ' + esc(TIER_WORDS[t]) + ')' : '') + '">' +
    (drag ? '<span class="grip" aria-hidden="true">⠿</span>' : '') + esc(it.name) + '</button>' + voteHtml(it, vs, mine, tip) + '</div>';
}
export function renderLib() {
  const el = $('#lib-list'); if (!el) return;
  const list = libItems(), all = pool().length;
  const compact = prefGet(DENSITY_KEY) === 'compact';
  const draw = () => { el.innerHTML = list.length ? list.map(compact ? rowHtml : cardHtml).join('') : '<p class="empty">Nothing matches. Try clearing a filter.</p>'; el.classList.toggle('compact', compact); };
  if (el.classList.contains('compact') !== compact && el.childElementCount) { draw(); enter(el); }
  else flip(el, '.lib-card[data-key]', (x) => x.dataset.key, draw); // filtering: cards glide into place
  fillImages(el);
  $('#lib-n').textContent = 'Showing ' + list.length + ' of ' + all;
  const c = $('#lib-count'); if (c) c.textContent = all + (all === 1 ? ' category' : ' categories');
  const s = $('#db-cnt'); if (s) s.textContent = String(list.length);
}
/* The rail's inside (the editor draws it; ids match the Category database tab so one filter module serves both). */
export function libHtml(tip) {
  return '<div class="lib-head"><h2 id="lib-h">Database</h2><span class="faint lib-count" id="lib-count"></span>' +
    '<button type="button" class="btn small ghost rail-x" id="db-fold" aria-controls="lib" aria-label="Fold the Database" title="Fold the Database">«</button>' +
    '<button type="button" class="btn small primary lib-close" id="lib-close">Done</button></div>' + searchHtml(PCTX) +
    '<div class="row lib-ftools"><button type="button" class="btn small" id="f-toggle" aria-controls="filters" aria-expanded="false">Filters</button>' +
    densityHtml(prefGet(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable') + '</div>' +
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
    const v = e.target.closest('[data-view]'); if (v && lib.contains(v)) { viewDialog(v.dataset.view); return; }
    const vb = e.target.closest('[data-lvote]'); if (vb && lib.contains(vb)) { libVote(vb); return; }
    const row = e.target.closest('.lib-card.lc-row'); if (row && lib.contains(row)) { viewDialog(row.dataset.key); return; }
    const d = e.target.closest('[data-dens]');
    if (d && lib.contains(d)) {
      prefSet(DENSITY_KEY, d.dataset.dens === 'compact' ? 'compact' : null);
      d.parentElement.querySelectorAll('[data-dens]').forEach((x) => x.setAttribute('aria-checked', String(x === d)));
      renderLib(); d.focus();
    }
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
/* 👍 from the rail: add yours or take it back, then redraw the cards. */
async function libVote(b) {
  const it = pool().find((x) => x.key === b.dataset.lvote); if (!it || !it.sid) return;
  const mine = votesFor(it).includes(S.me);
  await busy(b, '…', async () => {
    const { error } = mine ? await S.sb.from('votes').delete().eq('submission_id', it.sid).eq('voter_email', S.me)
      : await S.sb.from('votes').insert({ submission_id: it.sid });
    if (error) { toast('Could not save your 👍: ' + plainError(error), 5000); return; }
    const list = votesFor(it).filter((e) => e !== S.me);
    if (!mine) { list.push(S.me); PL.voteSch.set(it.sid + '|' + S.me, S.school); }
    PL.votes.set(it.sid, list);
    toast(mine ? 'Took back your 👍' : '👍 added');
  });
  renderLib();
  const again = $('#lib-list [data-lvote="' + CSS.escape(it.key) + '"]'); if (again) again.focus();
}
/* Which tiers already hold something (for the slot picker). */
export const tiersUsed = () => (LIB.draft ? slotsOf(LIB.draft.id) : []);
/* Sign-out: forget the filters. */
export function resetLib() { PF = PF0(); PS.hits = null; PS.hitQ = ''; POOL = { src: null, list: [] }; }
