/* Puzzle workspace: Category database filters. Always visible: search,
   receiving school (searchable multi-select), block, usage. The rest sits
   under "More filters". Active filters show as chips with × and Clear all;
   on a phone the panel is a drawer ("Filters (n)"). Saved views are presets
   plus your own, kept in this browser. Trash uses the same panel. */
import { S, $, esc, toast, openModal, person, schName, schFull, fmtD, TIER_WORDS, prefJson, prefSet } from './ws-core.js';
import { V, FS, cf, match, stOf, search, renderList, BLOCKS } from './ws-suggest.js';

const SNAP = ['q', 'school', 'block', 'used', 'st', 'tier', 'ct', 'sub', 'from', 'to', 'vfrom', 'since', 'unusedMine', 'tby', 'sort'];
export const blankF = (view) => ({ view, q: '', school: [], block: [], used: 'any', st: [], tier: [], ct: [], sub: 'all', from: '', to: '', vfrom: 'all',
  since: false, unusedMine: false, tby: '', sort: view === 'trash' ? 'trashed' : 'newest', more: false, schQ: '', schOpen: false, drawer: false });
const CTYPES = [['slide', 'Slide'], ['xray', 'X-ray'], ['photo', 'Photo'], ['text', 'Text']];
const USED = [['any', 'Any'], ['never', 'Never used'], ['used', 'Used'], ['draft', 'In a draft']];
const ST = [['new', 'New'], ['draft', 'In a draft'], ['used', 'Used']];
const sorts = () => (V.view === 'trash' ? [['trashed', 'Recently trashed']] : []).concat([['newest', 'Newest first'], ['oldest', 'Oldest first'],
  ['votes', 'Most 👍'], ['used', 'Most used'], ['unused', 'Never used first'], ['name', 'Name A–Z']]);

export function filtersShell() {
  return '<div class="sug-layout"><div class="f-scrim" id="f-scrim" hidden></div><aside class="filters panel" id="filters" aria-label="Filters"></aside>';
}
export function searchHtml() {
  const F = cf();
  return '<div class="searchbar" role="search"><label class="sr" for="sug-q">Search ' + (V.view === 'trash' ? 'Trash' : 'categories') + '</label>' +
    '<input class="input" type="search" id="sug-q" autocomplete="off" placeholder="' + (V.view === 'trash' ? 'Search trashed names, clues, reasons…' : 'Search names, clues, explanations…') + '" value="' + esc(F.q) + '">' +
    '<label class="sr" for="sug-sort">Sort</label><select class="input" id="sug-sort">' + sorts().map((o) => '<option value="' + o[0] + '"' + (F.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>';
}

/* ===== The panel ===== */
const chipGroup = (key, opts, label) => '<fieldset class="fgroup"><legend class="eyebrow">' + label + '</legend><div class="chips">' + opts.map((o) =>
  '<button type="button" class="chip" data-f="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + cf()[key].includes(o[0]) + '">' + (o[2] || '') + esc(o[1]) +
  (o[3] != null ? ' <span class="n">' + o[3] + '</span>' : '') + '</button>').join('') + '</div></fieldset>';
const seg = (key, cur, opts, label) => '<fieldset class="fgroup"><legend class="eyebrow">' + label + '</legend><div class="chips">' + opts.map((o) =>
  '<button type="button" class="chip" data-seg="' + key + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>').join('') + '</div></fieldset>';
function msList() {
  const F = cf(), q = F.schQ.toLowerCase().trim(), keys = [...S.schools.keys()].filter((k) => !q || (S.schools.get(k).name + ' ' + k).toLowerCase().includes(q));
  if (!keys.length) return '<li class="faint ms-none">No school matches “' + esc(F.schQ) + '”</li>';
  return keys.map((k) => '<li><label class="ms-opt"><input type="checkbox" id="ms-c-' + esc(k) + '" data-msk="' + esc(k) + '"' + (F.school.includes(k) ? ' checked' : '') + '>' +
    '<span class="grow">' + esc(schName(k)) + '<small class="faint">' + esc(schFull(k)) + '</small></span><span class="n">' + V.rows.filter((r) => r.school === k && match(r, 'school')).length + '</span></label></li>').join('');
}
function schoolMs() {
  const F = cf(), sel = F.school, sum = !sel.length ? 'Any school' : sel.length === 1 ? schName(sel[0]) : sel.length + ' schools';
  return '<fieldset class="fgroup ms"><legend class="eyebrow">Receiving school</legend>' +
    (sel.length ? '<div class="ms-chips">' + sel.map((k) => '<span class="ms-chip">' + esc(schName(k)) + '<button type="button" data-msx="' + esc(k) + '" aria-label="Remove ' + esc(schName(k)) + '">×</button></span>').join('') +
      '<button type="button" class="btn small ghost" id="ms-clear">Clear all</button></div>' : '') +
    '<button type="button" class="input ms-btn" id="ms-btn" aria-expanded="' + F.schOpen + '" aria-controls="ms-pop">' + esc(sum) + '<span class="chev" aria-hidden="true"></span></button>' +
    '<div class="ms-pop" id="ms-pop"' + (F.schOpen ? '' : ' hidden') + '><label class="sr" for="ms-q">Find a school</label><input class="input" id="ms-q" type="search" autocomplete="off" placeholder="Type to find a school…" value="' + esc(F.schQ) + '">' +
    '<ul class="ms-list" id="ms-list" aria-label="Schools">' + msList() + '</ul><div class="row spread"><span class="faint" style="font-size:.76rem">' + S.schools.size + ' schools</span>' +
    '<button type="button" class="btn small" id="ms-done">Done</button></div></div></fieldset>';
}
export function renderFilters() {
  const el = $('#filters'); if (!el) return;
  const F = cf(), trash = V.view === 'trash', moreN = activeF().filter((a) => a.more).length, n = V.rows.filter((r) => match(r)).length;
  const blocks = BLOCKS.slice(); V.rows.forEach((r) => (r.tags || []).forEach((t) => { if (!blocks.includes(t)) blocks.push(t); }));
  const stN = (st) => V.rows.filter((r) => stOf(r) === st && match(r, 'st')).length;
  const tby = [...new Set(V.rows.filter((r) => r.status === 'trashed' && r.trashed_by).map((r) => r.trashed_by))];
  el.innerHTML = '<div class="f-head"><h2>Filters</h2><button type="button" class="btn small ghost" id="f-x" aria-label="Close filters">✕</button></div>' +
    schoolMs() + chipGroup('block', blocks.map((b) => [b, b]), 'Block / system') + seg('used', F.used, USED, 'Usage') +
    '<button type="button" class="btn small more-f" id="more-f" aria-expanded="' + F.more + '" aria-controls="more-panel">More filters' + (moreN ? ' <span class="n">' + moreN + '</span>' : '') + '<span class="chev" aria-hidden="true"></span></button>' +
    '<div class="stack more-panel" id="more-panel" style="--gap:14px"' + (F.more ? '' : ' hidden') + '>' +
    (trash ? '<label class="field"><span>Trashed by</span><select class="input" id="f-tby"><option value="">Anyone</option>' + tby.map((e) => '<option value="' + esc(e) + '"' + (F.tby === e ? ' selected' : '') + '>' + esc(person(e).name) + '</option>').join('') + '</select></label>'
      : chipGroup('st', ST.map((o) => [o[0], o[1], '', stN(o[0])]), 'Status')) +
    chipGroup('tier', [1, 2, 3, 4].map((t) => [String(t), TIER_WORDS[t], '<span class="tierdot t' + t + '"></span>']), 'Suggested difficulty') +
    chipGroup('ct', CTYPES, 'Clue types') + seg('sub', F.sub, [['all', 'Anyone'], ['named', 'Named'], ['anon', 'Anonymous']], 'Submitter') +
    '<fieldset class="fgroup"><legend class="eyebrow">Submitted between</legend><div class="fdates">' +
    '<label class="field"><span>From</span><input class="input" type="date" id="f-from" value="' + esc(F.from) + '"></label>' +
    '<label class="field"><span>To</span><input class="input" type="date" id="f-to" value="' + esc(F.to) + '"></label></div></fieldset>' +
    (S.school ? seg('vfrom', F.vfrom, [['all', 'All admins'], ['mine', 'My school only']], 'Count 👍 from') : '') + '</div>' +
    '<div class="f-foot"><button type="button" class="btn small" id="f-clear">Clear all</button><button type="button" class="btn primary f-apply" id="f-apply">Show ' + n + ' result' + (n === 1 ? '' : 's') + '</button></div>';
}

/* ===== Active-filter chips ===== */
function activeF() {
  const F = cf(), out = [], add = (label, clr, more) => out.push({ label, clr, more: !!more });
  const arr = (k, lab, more) => F[k].forEach((v) => add(lab(v), () => { F[k] = F[k].filter((x) => x !== v); }, more));
  if (F.q.trim()) add('Search: “' + F.q.trim() + '”', () => { F.q = ''; });
  arr('school', (v) => 'To ' + schName(v));
  arr('block', (v) => v);
  if (F.used !== 'any') add(USED.find((o) => o[0] === F.used)[1], () => { F.used = 'any'; });
  if (F.since) add('New since ' + fmtD(V.lastVisit), () => { F.since = false; });
  if (F.unusedMine) add('Unused at ' + schName(S.school), () => { F.unusedMine = false; });
  arr('st', (v) => ST.find((o) => o[0] === v)[1], 1);
  arr('tier', (v) => TIER_WORDS[v], 1);
  arr('ct', (v) => CTYPES.find((o) => o[0] === v)[1] + ' clues', 1);
  if (F.sub !== 'all') add(F.sub === 'named' ? 'Named submitters' : 'Anonymous', () => { F.sub = 'all'; }, 1);
  if (F.from) add('From ' + fmtD(F.from + 'T12:00'), () => { F.from = ''; }, 1);
  if (F.to) add('To ' + fmtD(F.to + 'T12:00'), () => { F.to = ''; }, 1);
  if (F.vfrom !== 'all') add('👍 from my school', () => { F.vfrom = 'all'; }, 1);
  if (F.tby) add('Trashed by ' + person(F.tby).name, () => { F.tby = ''; }, 1);
  return out;
}
let shown = [];
export function renderActive() {
  const el = $('#active-f'); if (!el) return;
  shown = activeF();
  el.innerHTML = shown.length ? shown.map((x, i) => '<span class="af-chip">' + esc(x.label) + '<button type="button" data-afx="' + i + '" aria-label="Remove filter: ' + esc(x.label) + '">×</button></span>').join('') +
    '<button type="button" class="btn small ghost" id="af-clear">Clear all</button>' : '';
  const t = $('#f-toggle'); if (t) t.textContent = 'Filters' + (shown.length ? ' (' + shown.length + ')' : '');
  renderViews();
}

/* ===== Saved views ===== */
const viewsKey = () => 'dp2d:cat-views:' + V.view;
const snap = (F) => JSON.stringify(SNAP.reduce((o, k) => { o[k] = F[k]; return o; }, {}));
const withOver = (over) => Object.assign(blankF(V.view), JSON.parse(JSON.stringify(over)));
function presets() {
  if (V.view === 'trash') return [['all', 'All', {}]];
  return [['all', 'All', {}], ['since', 'New since my last visit', { since: true }]]
    .concat(S.school ? [['unused', 'Unused at my school', { unusedMine: true }]] : [], [['top', 'Top 👍', { sort: 'votes' }]]);
}
function renderViews() {
  const el = $('#views'); if (!el) return;
  const cur = snap(cf()), saved = prefJson(viewsKey(), []);
  el.innerHTML = presets().map((p) => '<button type="button" class="view-tab" data-pv="' + p[0] + '" aria-pressed="' + (snap(withOver(p[2])) === cur) + '"' +
    (p[0] === 'since' ? ' title="Since ' + esc(new Date(V.lastVisit).toLocaleString()) + '"' : '') + '>' + esc(p[1]) + '</button>').join('') +
    saved.map((v, i) => '<span class="view-saved"><button type="button" class="view-tab" data-sv="' + i + '" aria-pressed="' + (v.snap === cur) + '">' + esc(v.name) + '</button>' +
      '<button type="button" class="view-x" data-svx="' + i + '" aria-label="Delete view ' + esc(v.name) + '">×</button></span>').join('') +
    '<button type="button" class="view-tab add" id="save-view">＋ Save this view</button>';
}
async function applyView(over, focusSel) {
  const F = cf(), keep = { more: F.more, drawer: F.drawer };
  FS[V.view] = Object.assign(withOver(over), keep);
  $('#sug-q').value = cf().q; $('#sug-sort').value = cf().sort;
  await refresh(focusSel);
}
function saveViewDialog() {
  const n = activeF().length;
  openModal('<form class="stack" style="--gap:12px" id="sv-form" novalidate><h2 id="modal-h">Save this view</h2>' +
    '<p class="muted">Saves the current search, ' + n + ' filter' + (n === 1 ? '' : 's') + ' and sort as a tab. Kept in this browser only.</p>' +
    '<label class="field"><span>Name</span><input class="input" id="sv-n" maxlength="40" placeholder="e.g. Heme, never used"></label><p class="err" id="sv-err" role="alert" hidden>Give it a name.</p>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="submit">Save view</button></div></form>', (m, close) => {
    $('#sv-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#sv-n', m).value.trim(); if (!v) { $('#sv-err', m).hidden = false; $('#sv-n', m).focus(); return; }
      const saved = prefJson(viewsKey(), []); saved.push({ name: v, snap: snap(cf()) }); prefSet(viewsKey(), JSON.stringify(saved));
      close(); renderViews(); toast('Saved view “' + v + '”');
      const b = $('[data-sv="' + (saved.length - 1) + '"]'); if (b) b.focus();
    });
  });
}

/* ===== Wiring (once per render of the tab; the panel's inside is redrawn) ===== */
export async function refresh(focusSel) {
  if (cf().q.trim() !== V.hitQ) { renderList(true); await search(); }
  renderFilters(); renderActive(); renderList();
  if (focusSel) { const b = $(focusSel); if (b) b.focus(); }
}
function drawer(on) {
  const F = cf(); F.drawer = on;
  $('#filters').classList.toggle('open', on); $('#f-scrim').hidden = !on; $('#f-toggle').setAttribute('aria-expanded', String(on));
  if (on) { const f = $('#filters button, #filters input'); if (f) f.focus(); } else $('#f-toggle').focus();
}
export function wireFilters() {
  const el = $('#filters');
  let timer = 0;
  $('#sug-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { cf().q = e.target.value; refresh(); }, 250); });
  $('#sug-sort').addEventListener('change', (e) => { cf().sort = e.target.value; refresh(); });
  $('#f-toggle').addEventListener('click', () => drawer(!cf().drawer));
  $('#f-scrim').addEventListener('click', () => drawer(false));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cf().schOpen && e.target.closest('#ms-pop')) { e.stopPropagation(); cf().schOpen = false; refresh('#ms-btn'); return; }
    if (cf().drawer) { e.stopPropagation(); drawer(false); }
  });
  el.addEventListener('click', (e) => {
    const F = cf(), b = e.target.closest('button'); if (!b || !el.contains(b)) return;
    if (b.dataset.f) { const k = b.dataset.f, v = b.dataset.v; F[k] = F[k].includes(v) ? F[k].filter((x) => x !== v) : F[k].concat(v); refresh('[data-f="' + k + '"][data-v="' + CSS.escape(v) + '"]'); }
    else if (b.dataset.seg) { F[b.dataset.seg] = b.dataset.v; refresh('[data-seg="' + b.dataset.seg + '"][data-v="' + b.dataset.v + '"]'); }
    else if (b.dataset.msx) { F.school = F.school.filter((x) => x !== b.dataset.msx); refresh('#ms-btn'); }
    else if (b.id === 'ms-clear') { F.school = []; toast('School filter cleared'); refresh('#ms-btn'); }
    else if (b.id === 'ms-btn') { F.schOpen = !F.schOpen; refresh(F.schOpen ? '#ms-q' : '#ms-btn'); }
    else if (b.id === 'ms-done') { F.schOpen = false; refresh('#ms-btn'); }
    else if (b.id === 'more-f') { F.more = !F.more; renderFilters(); $('#more-f').focus(); }
    else if (b.id === 'f-x' || b.id === 'f-apply') drawer(false);
    else if (b.id === 'f-clear') { applyView({}, '#f-clear').then(() => toast('Filters cleared')); }
  });
  el.addEventListener('change', (e) => {
    const F = cf(), t = e.target;
    if (t.dataset.msk) { const k = t.dataset.msk; F.school = F.school.includes(k) ? F.school.filter((x) => x !== k) : F.school.concat(k); refresh('#ms-c-' + CSS.escape(k)); }
    else if (t.id === 'f-from' || t.id === 'f-to') { F[t.id === 'f-from' ? 'from' : 'to'] = t.value; refresh('#' + t.id); }
    else if (t.id === 'f-tby') { F.tby = t.value; refresh('#f-tby'); }
  });
  el.addEventListener('input', (e) => { if (e.target.id === 'ms-q') { cf().schQ = e.target.value; $('#ms-list').innerHTML = msList(); } });
  $('#active-f').addEventListener('click', (e) => {
    const x = e.target.closest('[data-afx]');
    if (x) { const i = Number(x.dataset.afx); shown[i].clr(); $('#sug-q').value = cf().q; refresh().then(() => { const n = $('[data-afx="' + Math.min(i, shown.length - 1) + '"]') || $('#sug-q'); n.focus(); }); }
    else if (e.target.id === 'af-clear') applyView({}, '#sug-q').then(() => toast('Filters cleared'));
  });
  $('#views').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pv) { const p = presets().find((x) => x[0] === b.dataset.pv); applyView(p[2], '[data-pv="' + p[0] + '"]'); }
    else if (b.dataset.sv) { const v = prefJson(viewsKey(), [])[Number(b.dataset.sv)]; if (v) applyView(JSON.parse(v.snap), '[data-sv="' + b.dataset.sv + '"]'); }
    else if (b.dataset.svx) {
      const saved = prefJson(viewsKey(), []), v = saved.splice(Number(b.dataset.svx), 1)[0];
      prefSet(viewsKey(), JSON.stringify(saved)); renderViews(); if (v) toast('Deleted view “' + v.name + '”'); $('#save-view').focus();
    } else if (b.id === 'save-view') saveViewDialog();
  });
}
