/* Puzzle workspace: the Category database tab (was "Suggestions"). Every
   school's categories in one shared bank, with a Trash sub-tab that has the
   same filters. One card opens in place (#/categories/<id> is shareable).
   Data: all categories once, plus usage (category_usage), 👍 (with the voter's
   school) and comment counts; the word search runs on the server ("search"
   column); every other filter runs here so the counts and chips stay live.
   Filters, chips and saved views: ws-cat-filters.js. Trash, Add to draft,
   menus and keyboard: ws-cat-actions.js. The open card: ws-detail.js. */
import { S, $, esc, toast, plainError, ago, av, person, isPuzzle, groupsOf, itemsOf, allItems, ZONES, TIER_WORDS,
  schName, isCurator, canPlan, modalOpen, prefGet, prefSet } from './ws-core.js';
import { mountDetail } from './ws-detail.js';
import { filtersShell, searchHtml, renderFilters, renderActive, blankF, wireFilters } from './ws-cat-filters.js';
import { catMenu, wireListActions, initCatKeys } from './ws-cat-actions.js';

export const COLS = 'id, created_at, kind, status, suggested_tier, group_name, payload, credit_mode, credit_name, credit_line, ' +
  'contact_email, consent, admin_note, used_in, receipt_code, reviewed_by, reviewed_at, tags, school, trashed_by, trashed_at, trash_reason, source, source_ref';
export const BLOCKS = ['Cardio', 'Pulm', 'Renal', 'GI', 'Heme', 'Neuro', 'MSK', 'Endo', 'Repro', 'Derm', 'Micro', 'Pharm', 'Genetics'];
export const ROUTE = '#/categories';
const NO_USE = { times_used: 0, as_is: 0, adapted: 0, schools: [], drafts_count: 0 };

/* rows = every category; usage: id -> category_usage row; votes: id -> [{ e, s }];
   cmts: id -> count I can see; hits: ids matching the word search (null = no search). */
export const V = { rows: [], usage: new Map(), votes: new Map(), cmts: new Map(), hits: null, hitQ: '',
  view: 'all', open: null, seq: 0, sseq: 0, err: '', loaded: false, justOpened: false, lastVisit: '', onCounts: () => {} };
/* One filter set per sub-tab, so Trash keeps its own search and filters. */
export const FS = { all: blankF('all'), trash: blankF('trash') };
export const cf = () => FS[V.view];

export const rowById = (id) => V.rows.find((r) => r.id === id) || null;
export const useOf = (id) => V.usage.get(id) || NO_USE;
export const votesOf = (id) => (V.votes.get(id) || []).map((v) => v.e);
export const votesMine = (id) => (V.votes.get(id) || []).filter((v) => S.school && v.s === S.school).length;
export const voteSchools = (id) => new Set((V.votes.get(id) || []).map((v) => v.s).filter(Boolean)).size;
export const voteN = (id) => (cf().vfrom === 'mine' ? votesMine(id) : votesOf(id).length);
export const isUsed = (r) => useOf(r.id).times_used > 0 || r.status === 'used';
/* new | draft | used, worked out from usage (the database stores new/used/trashed). */
export const stOf = (r) => (r.status === 'trashed' ? 'trashed' : useOf(r.id).drafts_count ? 'draft' : isUsed(r) ? 'used' : 'new');
export const newCount = () => V.rows.filter((r) => stOf(r) === 'new').length;
export const inTrash = () => V.rows.filter((r) => r.status === 'trashed').length;

/* ===== Data ===== */
async function fetchAll() {
  const res = await Promise.all([
    S.sb.from('submissions').select(COLS).order('created_at', { ascending: false }).limit(5000),
    S.sb.from('category_usage').select('submission_id, times_used, as_is, adapted, schools, drafts_count').limit(5000),
    S.sb.from('votes').select('submission_id, voter_email, school').limit(20000),
    S.sb.from('comments').select('target_id').eq('target_type', 'submission').limit(20000),
    S.sb.from('site_settings').select('trash_retention_days').limit(1)]);
  const bad = res.slice(0, 4).find((r) => r.error);
  if (bad) throw bad.error;
  V.retention = res[4].data && res[4].data[0] ? res[4].data[0].trash_retention_days : null;
  const [subs, use, votes, cmts] = res.map((r) => r.data || []);
  V.rows = subs;
  V.usage = new Map(use.map((u) => [u.submission_id, u]));
  V.votes = new Map(); votes.forEach((v) => { if (!V.votes.has(v.submission_id)) V.votes.set(v.submission_id, []); V.votes.get(v.submission_id).push({ e: v.voter_email, s: v.school }); });
  V.cmts = new Map(); cmts.forEach((c) => V.cmts.set(c.target_id, (V.cmts.get(c.target_id) || 0) + 1));
}
/* The word search, on the server. Called when the words change. */
export async function search() {
  const words = cf().q.trim();
  if (!words) { V.hits = null; V.hitQ = ''; return; }
  if (words === V.hitQ && V.hits) return;
  const seq = ++V.sseq;
  const { data, error } = await S.sb.from('submissions').select('id').textSearch('search', words, { type: 'websearch', config: 'english' }).limit(5000);
  if (seq !== V.sseq) return;
  if (error) { V.err = plainError(error); return; }
  V.hits = new Set((data || []).map((r) => r.id)); V.hitQ = words; V.err = '';
}
export async function reload() {
  const seq = ++V.seq;
  try {
    await fetchAll();
    if (seq !== V.seq) return;
    V.err = ''; V.hitQ = ''; await search();
  } catch (e) { if (seq === V.seq) V.err = plainError(e); }
  V.onCounts();
}

/* ===== Matching (skip = leave one filter out, for the counts next to its options) ===== */
const clueKinds = (r) => new Set(allItems(r).map((it) => (ZONES[it.zone] || [])[2]).filter(Boolean));
const day = (iso) => String(iso || '').slice(0, 10);
export function match(r, skip, F) {
  F = F || cf();
  if ((F.view === 'trash') !== (r.status === 'trashed')) return false;
  const u = useOf(r.id);
  if (skip !== 'school' && F.school.length && !F.school.includes(r.school)) return false;
  if (skip !== 'block' && F.block.length && !(r.tags || []).some((t) => F.block.includes(t))) return false;
  if (skip !== 'used' && ((F.used === 'never' && isUsed(r)) || (F.used === 'used' && !isUsed(r)) || (F.used === 'draft' && !u.drafts_count))) return false;
  if (skip !== 'st' && F.st.length && !F.st.includes(stOf(r))) return false;
  if (F.tier.length && !F.tier.includes(String(r.suggested_tier))) return false;
  if (F.ct.length) { const k = clueKinds(r); if (!F.ct.some((c) => k.has(c))) return false; }
  if (F.sub !== 'all' && (F.sub === 'named') !== (r.credit_mode === 'named')) return false;
  if (F.from && day(r.created_at) < F.from) return false;
  if (F.to && day(r.created_at) > F.to) return false;
  if (F.since && V.lastVisit && r.created_at <= V.lastVisit) return false;
  if (F.unusedMine && S.school && u.schools.includes(S.school)) return false;
  if (F.tby && r.trashed_by !== F.tby) return false;
  if (F.q.trim() && V.hits && !V.hits.has(r.id)) {
    const w = F.q.trim().toLowerCase();
    if (F.view !== 'trash' || !((r.trash_reason || '') + ' ' + person(r.trashed_by).name).toLowerCase().includes(w)) return false;
  }
  return true;
}
const newest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
const SORTERS = {
  newest, oldest: (a, b) => -newest(a, b), name: (a, b) => String(a.group_name).localeCompare(String(b.group_name)),
  votes: (a, b) => voteN(b.id) - voteN(a.id) || newest(a, b),
  used: (a, b) => useOf(b.id).times_used - useOf(a.id).times_used || newest(a, b),
  unused: (a, b) => useOf(a.id).times_used - useOf(b.id).times_used || (isUsed(a) - isUsed(b)) || newest(a, b),
  trashed: (a, b) => (a.trashed_at < b.trashed_at ? 1 : a.trashed_at > b.trashed_at ? -1 : 0),
};
export function visibleRows() {
  const F = cf(), list = V.rows.filter((r) => match(r) || r.id === V.open);
  return list.sort(SORTERS[F.sort] || newest);
}

/* ===== Cards ===== */
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
/* "Used 2× (as-is) · CMSRU · in 1 draft · 👍 6 (1 from CMSRU) · 💬 2" */
export function usageLine(r) {
  const u = useOf(r.id), b = [], vs = votesOf(r.id).length, n = V.cmts.get(r.id) || 0;
  const split = u.as_is && u.adapted ? u.as_is + ' as-is, ' + u.adapted + ' adapted' : u.adapted ? 'adapted' : 'as-is';
  if (u.times_used) b.push('<b>Used ' + u.times_used + '×</b> (' + split + ')', esc(u.schools.map(schName).join(', ')));
  else b.push(r.status === 'used' ? '<b>Used</b>' : 'Never used');
  if (u.drafts_count) b.push('in ' + plural(u.drafts_count, 'draft') + (u.drafts_count > 1 ? ' <span class="flag" title="Sits in ' + u.drafts_count + ' drafts">!</span>' : ''));
  b.push('👍 ' + vs + (S.school ? ' (' + votesMine(r.id) + ' from ' + esc(schName(S.school)) + ')' : ''));
  if (n) b.push('💬 ' + n);
  return '<p class="usage card-line">' + b.join(' · ') + '</p>';
}
export function attribHtml(r) {
  const day = (iso) => esc(new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  if (r.status === 'trashed') {
    return '<p class="attrib declined">' + av(r.trashed_by) + 'Trashed by ' + esc(person(r.trashed_by).name) + (r.trashed_at ? ' · ' + day(r.trashed_at) : '') +
      (r.trash_reason ? ' — <q>' + esc(r.trash_reason) + '</q>' : ' · <span class="faint">No reason given</span>') + '</p>';
  }
  if (r.source === 'published') return '<p class="attrib used">From published puzzle <span class="code">' + esc(r.source_ref || '') + '</span></p>';
  return '';
}
export function tierClass(r) { return isPuzzle(r) ? 'tp' : 't' + (Number(r.suggested_tier) || 0); }
function inlineClues(r) {
  if (isPuzzle(r)) {
    const gs = groupsOf(r).slice().sort((a, b) => (Number(a.tier) || 9) - (Number(b.tier) || 9));
    return '<ul class="grp-inline">' + gs.map((g) => '<li><span class="tierdot t' + (Number(g.tier) || 0) + '" title="' + esc(TIER_WORDS[g.tier] || '') + '"></span>' + esc(g.name) + '</li>').join('') + '</ul>';
  }
  return '<ul class="clue-inline">' + itemsOf(r.payload).map((it) => {
    const z = ZONES[it.zone] || ['Clue', '•'];
    return '<li title="' + esc(z[0]) + '"><span class="ki" aria-hidden="true">' + z[1] + '</span><span class="sr">' + esc(z[0]) + ': </span>' + esc(it.label) + '</li>';
  }).join('') + '</ul>';
}
function actsHtml(r) {
  const vs = votesOf(r.id), mine = vs.includes(S.me);
  if (r.status === 'trashed') {
    const off = isCurator() ? '' : ' disabled title="Faculty can’t restore from Trash"';
    return '<div class="card-acts"><button type="button" class="btn small primary" data-restore="' + esc(r.id) + '"' + off + '>Restore</button>' +
      '<button type="button" class="btn small" data-why="' + esc(r.id) + '"' + off + '>' + (r.trash_reason ? 'Edit reason' : 'Add reason') + '</button></div>';
  }
  return '<div class="card-acts"><button type="button" class="btn small vote-btn" data-id="' + esc(r.id) + '" aria-pressed="' + mine + '" aria-label="Thumbs up ' + esc(r.group_name) + ', ' + voteN(r.id) + ' so far">👍 ' + voteN(r.id) + '</button>' +
    '<button type="button" class="btn small primary" data-addd="' + esc(r.id) + '"' + (canPlan() ? '' : ' aria-disabled="true" title="Faculty can comment and approve drafts, but can’t add to them"') + '>Add to draft…</button>' + catMenu(r) + '</div>';
}
function cardHtml(r) {
  const open = V.open === r.id, id = esc(r.id);
  return '<article class="sug-card ' + tierClass(r) + (open ? ' open' : '') + '" data-id="' + id + '"><div class="sug-top"><div class="stack" style="--gap:6px">' +
    '<h3><span class="tierdot" title="Suggested: ' + esc(TIER_WORDS[r.suggested_tier] || '?') + '"></span><button type="button" class="sug-toggle" id="tg-' + id + '" data-id="' + id + '" aria-expanded="' + open + '" aria-controls="sd-' + id + '">' + esc(r.group_name) + '</button></h3>' +
    '<div class="meta"><span>' + (r.credit_mode === 'named' && r.credit_name ? esc(r.credit_name) : '<i>Anonymous</i>') + '</span><span title="' + esc(new Date(r.created_at).toLocaleString()) + '">' + esc(ago(r.created_at)) + '</span>' +
    (r.tags || []).map((t) => '<span class="tagchip">' + esc(t) + '</span>').join('') + '<span>to ' + esc(schName(r.school)) + '</span></div>' + inlineClues(r) + '</div>' +
    '<span class="chev" aria-hidden="true"></span><div class="card-foot">' + usageLine(r) + (open ? '' : actsHtml(r)) + '</div>' + attribHtml(r) + '</div>' +
    '<div class="sug-detail' + (open && V.justOpened ? ' anim' : '') + '" id="sd-' + id + '" role="region" aria-labelledby="tg-' + id + '"' + (open ? '' : ' hidden') + '></div></article>';
}

/* ===== List ===== */
export function renderList(pending) {
  const el = $('#sug-list'); if (!el) return;
  el.setAttribute('aria-busy', String(!!pending));
  if (pending) return;
  const list = visibleRows(), trash = V.view === 'trash', total = trash ? inTrash() : V.rows.length - inTrash();
  $('#sug-n').textContent = V.err ? '' : 'Showing ' + list.length + ' of ' + total + (trash ? ' in Trash' : ' categories in the database');
  if (V.err) { el.innerHTML = '<div class="err-box">' + esc(V.err) + ' <button type="button" class="btn small" id="sug-retry">Try again</button></div>'; return; }
  if (!list.length) {
    el.innerHTML = '<p class="empty">' + (trash ? (total ? 'Nothing in Trash matches these filters.' : 'Trash is empty.')
      : !total ? 'Nothing here yet. New categories show up here as students send them.' : 'Nothing matches these filters. Try clearing one.') + '</p>';
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
  V.justOpened = false;
  const r = V.open && rowById(V.open), box = r && document.getElementById('sd-' + r.id);
  if (box) mountDetail(box, r);
}
/* Re-draws everything that shows category data (after any change). */
export function redraw() { renderSubtabs(); renderFilters(); renderActive(); renderList(); }
export const hashFor = (id) => (id ? ROUTE + '/' + encodeURIComponent(id) : V.view === 'trash' ? ROUTE + '/trash' : ROUTE);
function focusToggle(id) { const t = document.getElementById('tg-' + id); if (t) t.focus(); return t; }
export function openCard(id) {
  V.open = id; V.justOpened = true;
  history.replaceState(null, '', location.pathname + location.search + hashFor(id));
  renderList();
  const t = document.getElementById('tg-' + id);
  if (t) t.closest('.sug-card').scrollIntoView({ block: 'nearest' });
}
export function closeCard(focus) {
  const id = V.open; if (!id) return;
  V.open = null;
  history.replaceState(null, '', location.pathname + location.search + hashFor(null));
  renderList();
  if (focus) focusToggle(id);
}

/* ===== The tab ===== */
function renderSubtabs() {
  const el = $('#cat-subtabs'); if (!el) return;
  el.innerHTML = '<a href="' + ROUTE + '"' + (V.view !== 'trash' ? ' aria-current="page"' : '') + '>All categories <span class="n">' + (V.rows.length - inTrash()) + '</span></a>' +
    '<a href="' + ROUTE + '/trash"' + (V.view === 'trash' ? ' aria-current="page"' : '') + '>🗑 Trash <span class="n">' + inTrash() + '</span></a>';
  const note = $('#trash-note');
  if (note) {
    note.hidden = V.view !== 'trash';
    note.innerHTML = 'Trash is shared by every school: junk, duplicates and copyright problems go here, and no school sees them in the database. ' +
      (V.retention ? 'Items are deleted for good ' + V.retention + ' days after they were trashed.' : 'Auto-delete is <b>off</b>, so nothing leaves Trash on its own.');
  }
}
function renderView() {
  $('#ws-main').innerHTML = '<div class="view-head"><div><h1>' + (V.view === 'trash' ? 'Trash' : 'Category database') + '</h1></div>' +
    '<div class="row" style="--gap:8px"><button class="btn" type="button" id="btn-refresh">Refresh</button>' +
    '<button type="button" class="btn ftoggle" id="f-toggle" aria-controls="filters" aria-expanded="false">Filters</button></div></div>' +
    '<nav class="subtabs" id="cat-subtabs" aria-label="Category database or Trash"></nav><p class="trash-note" id="trash-note" hidden></p>' +
    '<div class="views" id="views" role="group" aria-label="Saved views"></div>' + filtersShell() +
    '<section aria-label="' + (V.view === 'trash' ? 'Trash' : 'Categories') + '">' + searchHtml() +
    '<div class="active-f" id="active-f" aria-label="Active filters"></div><p class="result-n" id="sug-n" aria-live="polite"></p>' +
    '<div class="stack" style="--gap:10px" id="sug-list"></div></section></div>';
  wireFilters();
  wireListActions($('#sug-list'));
  $('#btn-refresh').addEventListener('click', async (e) => {
    const b = e.currentTarget; if (b.disabled) return;
    b.disabled = true; b.textContent = 'Refreshing…';
    await reload(); redraw();
    if (b.isConnected) { b.disabled = false; b.textContent = 'Refresh'; }
    if (!V.err) toast('Up to date');
  });
}
/* Called by ws-main: sub = 'trash' or '', id = a card to open. */
export async function showSuggestions(sub, id) {
  const first = !V.loaded;
  if (first && !V.lastVisit) {
    const k = 'dp2d:cat-visit:' + S.me;
    V.lastVisit = prefGet(k) || new Date(Date.now() - 7 * 864e5).toISOString();
    prefSet(k, new Date().toISOString());
  }
  if (first) { renderView(); renderList(true); await reload(); V.loaded = !V.err; }
  if (id) {
    const r = rowById(id);
    if (!r) { toast('That category isn’t in the database any more.', 4000); id = null; }
    else { sub = r.status === 'trashed' ? 'trash' : ''; V.open = id; V.justOpened = true; }
  } else V.open = null;
  const view = sub === 'trash' ? 'trash' : 'all', changed = view !== V.view || first || !$('#sug-list');
  V.view = view;
  if (changed) renderView();
  redraw();
  history.replaceState(null, '', location.pathname + location.search + hashFor(V.open));
  if (id && V.open) { const t = focusToggle(id); if (t) t.closest('.sug-card').scrollIntoView({ block: 'center' }); }
}
export function initSuggest(onCounts) {
  V.onCounts = onCounts;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !V.open || modalOpen() || !$('#sug-list') || $('.mnu-pop:not([hidden])')) return;
    const t = e.target;
    if ((t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.value) return; // don't throw away typing
    closeCard(true);
  });
  initCatKeys();
}
/* Sign-out: forget everything. */
export function resetSuggest() {
  FS.all = blankF('all'); FS.trash = blankF('trash');
  Object.assign(V, { rows: [], usage: new Map(), votes: new Map(), cmts: new Map(), hits: null, hitQ: '', view: 'all', open: null, err: '', loaded: false, lastVisit: '' });
}
