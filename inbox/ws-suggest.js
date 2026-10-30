/* Puzzle workspace: the Category database tab (was "Suggestions"). Every
   school's categories in one shared bank, with a Trash sub-tab that has the
   same filters. One card opens in place (#/categories/<id> is shareable).
   Data: all categories once, plus usage (category_usage), 👍 (with the voter's
   school) and comment counts; the word search runs on the server ("search"
   column); every other filter runs here so the counts and chips stay live.
   Filters, chips and saved views: ws-cat-filters.js. Trash, Add to draft,
   menus and keyboard: ws-cat-actions.js. The open card: ws-detail.js. */
import { S, $, $$, esc, toast, plainError, av, person, isPuzzle, groupsOf, itemsOf, allItems, ZONES, TIER_WORDS, lc,
  schName, schPill, isCurator, canPlan, modalOpen, prefGet, prefSet, fillImages } from './ws-core.js';
import { mountDetail, DS } from './ws-detail.js';
import { flip, enter } from './ws-motion.js';
import { presenceChanged, paintCats, typingIn, dirtyIn, whenIdle, keepFocus, flash } from './ws-live.js';
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
export const stFrom = (r, u) => (r.status === 'trashed' ? 'trashed' : (u || NO_USE).drafts_count ? 'draft' : (u || NO_USE).times_used > 0 || r.status === 'used' ? 'used' : 'new');
export const stOf = (r) => stFrom(r, useOf(r.id));
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
/* The server's word search: a Set of submission ids (also used by the Planner's Database rail). */
export async function searchIds(words) {
  const { data, error } = await S.sb.from('submissions').select('id').textSearch('search', words, { type: 'websearch', config: 'english' }).limit(5000);
  if (error) throw error;
  return new Set((data || []).map((r) => r.id));
}
export async function search() {
  const words = cf().q.trim();
  if (!words) { V.hits = null; V.hitQ = ''; return; }
  if (words === V.hitQ && V.hits) return;
  const seq = ++V.sseq;
  let hits; try { hits = await searchIds(words); } catch (e) { if (seq === V.sseq) V.err = plainError(e); return; }
  if (seq !== V.sseq) return;
  V.hits = hits; V.hitQ = words; V.err = '';
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
/* Local text for the word search, so part of a word matches too ("hemo" finds
   hemoptysis), same as the Planner's Database rail. The server's full-text
   search still adds its hits (stemming: "causes" finds "cause"). */
const HAY = new WeakMap();
function hayOf(r) {
  let h = HAY.get(r);
  if (h == null) {
    const g = r.payload || {};
    h = lc([r.group_name, g.explanation, r.trash_reason, r.trashed_by ? person(r.trashed_by).name : '']
      .concat(groupsOf(r).map((x) => x.name + ' ' + (x.explanation || '')), allItems(r).map((it) => it.label + ' ' + (typeof it.note === 'string' ? it.note : ''))).join(' \n '));
    HAY.set(r, h);
  }
  return h;
}
export const match = (r, skip, F) => matchRow(r, skip, F || cf(), { hits: V.hits, text: hayOf(r) });
/* The shared rules. o (Planner): u = usage row, tier = the group's tier, kinds = clue kinds,
   hits = word-search ids, text = local text to search too, votes = 👍 count. */
export function matchRow(r, skip, F, o) {
  if ((F.view === 'trash') !== (r.status === 'trashed')) return false;
  const u = o.u || useOf(r.id), isU = u.times_used > 0 || r.status === 'used', st = stFrom(r, u);
  if (skip !== 'school' && F.school.length && !F.school.includes(r.school)) return false;
  if (skip !== 'block' && F.block.length && !(r.tags || []).some((t) => F.block.includes(t))) return false;
  if (skip !== 'used' && ((F.used === 'never' && isU) || (F.used === 'used' && !isU) || (F.used === 'draft' && !u.drafts_count))) return false;
  if (skip !== 'st' && F.st.length && !F.st.includes(st)) return false;
  if (F.tier.length && !F.tier.includes(String(o.tier != null ? o.tier : r.suggested_tier))) return false;
  if (F.ct.length) { const k = o.kinds || clueKinds(r); if (!F.ct.some((c) => k.has(c))) return false; }
  if (F.sub !== 'all' && (F.sub === 'named') !== (r.credit_mode === 'named')) return false;
  if (F.from && day(r.created_at) < F.from) return false;
  if (F.to && day(r.created_at) > F.to) return false;
  if (F.since && V.lastVisit && r.created_at <= V.lastVisit) return false;
  if (F.unusedMine && S.school && u.schools.includes(S.school)) return false;
  if (F.tby && r.trashed_by !== F.tby) return false;
  if (o.text != null) {
    const ws = F.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (ws.length && !(o.hits && o.hits.has(r.id)) && !ws.every((w) => o.text.includes(w))) return false;
  } else if (F.q.trim() && V.hits && !V.hits.has(r.id)) {
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

/* ===== Cards (owner-approved option B2) =====
   Name + "Submitted to" pill on the top line, one clue per line (image clues
   get a small thumbnail), usage right-aligned at the top right with zeros
   hidden, and the buttons pinned bottom right: ⋯, Add to draft…, 👍 (the
   all-admins / my-school split is in the 👍 tooltip). Compact view: one thin
   line per category. Both: clicking anywhere on the card opens it. */
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
export const DENSITY_KEY = 'dp2d:cat-density';
export const compactOn = () => prefGet(DENSITY_KEY) === 'compact';
/* "1 as-is, 1 adapted · CMSRU, RVSOM": the details behind "In 2 published puzzles". */
function useTip(u) {
  const split = u.as_is && u.adapted ? u.as_is + ' as-is, ' + u.adapted + ' adapted' : u.adapted ? 'adapted' : 'as-is';
  return split + (u.schools.length ? ' · ' + u.schools.map(schName).join(', ') : '');
}
/* The usage bits, zeros hidden: "In 2 published puzzles", "In 1 draft", 💬 2 (or "Not used yet"). */
export function useBits(r) {
  const u = useOf(r.id), n = V.cmts.get(r.id) || 0, out = [];
  if (u.times_used) out.push('<span class="u-pub" title="' + esc(useTip(u)) + '">In <b>' + u.times_used + '</b> published puzzle' + (u.times_used === 1 ? '' : 's') + '</span>');
  else if (r.status === 'used') out.push('<span class="u-pub">Used in a puzzle</span>');
  if (u.drafts_count) out.push('<span class="u-dr">In <b>' + u.drafts_count + '</b> draft' + (u.drafts_count === 1 ? '' : 's') +
    (u.drafts_count > 1 ? ' <span class="flag" title="Sits in ' + u.drafts_count + ' drafts">!</span>' : '') + '</span>');
  if (!out.length) out.push('<span class="zero">Not used yet</span>');
  if (n) out.push('<span class="u-cm" title="' + plural(n, 'comment') + '">💬 <b>' + n + '</b></span>');
  return out.join('');
}
/* The 👍 tooltip: "You and 5 others · 2 from CMSRU · 2 schools". */
export function voteTip(id) {
  const vs = votesOf(id), n = vs.length, mine = vs.includes(S.me), sc = voteSchools(id);
  if (!n) return 'No thumbs up yet';
  const who = mine ? (n === 1 ? 'You' : 'You and ' + plural(n - 1, 'other')) : plural(n, 'thumbs up').replace(/thumbs ups$/, 'thumbs up');
  return who + (S.school ? ' · ' + votesMine(id) + ' from ' + schName(S.school) : '') + ' · ' + plural(sc, 'school');
}
export function voteBtn(r, attrs) {
  const mine = votesOf(r.id).includes(S.me), n = voteN(r.id), tip = voteTip(r.id);
  return '<button type="button" class="btn small vote-btn has-tip' + (mine ? ' on' : '') + '" ' + attrs + ' aria-pressed="' + mine + '" data-tip="' + esc(tip) + '" aria-label="Thumbs up ' +
    esc(r.group_name) + ', ' + n + ' so far. ' + esc(tip) + '"' + (r.status === 'trashed' ? ' disabled' : '') + '>👍 ' + n + '</button>';
}
export function attribHtml(r) {
  const day = (iso) => esc(new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  if (r.status !== 'trashed') return '';
  return '<p class="attrib declined">' + av(r.trashed_by) + 'Trashed by ' + esc(person(r.trashed_by).name) + (r.trashed_at ? ' · ' + day(r.trashed_at) : '') +
    (r.trash_reason ? ' — <q>' + esc(r.trash_reason) + '</q>' : ' · <span class="faint">No reason given</span>') + '</p>';
}
export function tierClass(r) { return isPuzzle(r) ? 'tp' : 't' + (Number(r.suggested_tier) || 0); }
/* A clue's picture: the microscope view for a slide, else the info image. */
export function clueImage(it) {
  const info = it.info || {}, scope = it.scope || {};
  const p = it.zone === 'rack' ? (scope.image || info.image) : info.image;
  return typeof p === 'string' && p ? p : '';
}
export function thumbHtml(p, label) {
  if (!p) return '';
  return '<span class="thumb" role="img" aria-label="Picture: ' + esc(label) + '" ' + 'data-path' + '="' + esc(p) + '"></span>';
}
export function clueList(r) {
  if (isPuzzle(r)) {
    const gs = groupsOf(r).slice().sort((a, b) => (Number(a.tier) || 9) - (Number(b.tier) || 9));
    return '<ul class="b2-clues grp-inline">' + gs.map((g) => '<li><span class="tierdot t' + (Number(g.tier) || 0) + '" title="' + esc(TIER_WORDS[g.tier] || '') + '"></span>' + esc(g.name) + '</li>').join('') + '</ul>';
  }
  return '<ul class="b2-clues">' + itemsOf(r.payload).map((it) => {
    const z = ZONES[it.zone] || ['Clue', '•'], p = clueImage(it);
    return '<li' + (p ? ' class="img"' : '') + ' title="' + esc(z[0]) + '">' + thumbHtml(p, it.label) + '<span class="lbl">' + esc(it.label) + '</span>' +
      (p ? ' <span class="kind">' + esc(z[0].toLowerCase()) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}
export function actsHtml(r) {
  if (r.status === 'trashed') {
    const off = isCurator() ? '' : ' disabled title="Faculty can’t restore from Trash"';
    return '<div class="card-acts"><button type="button" class="btn small" data-why="' + esc(r.id) + '"' + off + '>' + (r.trash_reason ? 'Edit reason' : 'Add reason') + '</button>' +
      '<button type="button" class="btn small primary" data-restore="' + esc(r.id) + '"' + off + '>Restore</button></div>';
  }
  return '<div class="card-acts">' + catMenu(r) + '<button type="button" class="btn small primary" data-addd="' + esc(r.id) + '"' +
    (canPlan() ? '' : ' aria-disabled="true" title="Faculty can comment and approve drafts, but can’t add to them"') + '>Add to draft…</button>' + voteBtn(r, 'data-id="' + esc(r.id) + '"') + '</div>';
}
const toggleHtml = (r, open) => { const id = esc(r.id); return '<button type="button" class="sug-toggle" id="tg-' + id + '" data-id="' + id + '" aria-expanded="' + open + '" aria-controls="sd-' + id + '">' + esc(r.group_name) + '</button>'; };
function cardHtml(r) {
  const open = V.open === r.id, id = esc(r.id);
  if (!open && compactOn()) return compactHtml(r);
  return '<article class="sug-card ' + tierClass(r) + (open ? ' open' : '') + '" data-id="' + id + '"><div class="sug-top b2">' +
    '<div class="b2-head"><h3 title="Suggested: ' + esc(TIER_WORDS[r.suggested_tier] || '?') + '">' + toggleHtml(r, open) + '</h3>' + schPill(r.school) + '</div>' +
    '<div class="b2-body">' + (open ? '' : clueList(r)) + attribHtml(r) + '</div>' +
    '<p class="card-use">' + useBits(r) + '</p>' + actsHtml(r) + '</div>' +
    '<div class="sug-detail' + (open && V.justOpened ? ' anim' : '') + '" id="sd-' + id + '" role="region" aria-labelledby="tg-' + id + '"' + (open ? '' : ' hidden') + '></div></article>';
}
/* Compact: name, small pill, small counts, ⋯ and a small Add (Restore in Trash). */
function compactHtml(r) {
  const u = useOf(r.id), id = esc(r.id), n = [];
  if (u.times_used) n.push('<span title="In ' + plural(u.times_used, 'published puzzle') + '">' + u.times_used + ' pub</span>');
  if (u.drafts_count) n.push('<span title="In ' + plural(u.drafts_count, 'draft') + '">' + plural(u.drafts_count, 'draft') + '</span>');
  n.push('<span title="' + esc(voteTip(r.id)) + '">👍 ' + voteN(r.id) + '</span>');
  const acts = r.status === 'trashed'
    ? '<button type="button" class="btn small primary" data-restore="' + id + '"' + (isCurator() ? '' : ' disabled title="Faculty can’t restore from Trash"') + '>Restore</button>'
    : catMenu(r) + '<button type="button" class="btn small" data-addd="' + id + '"' + (canPlan() ? '' : ' aria-disabled="true" title="Faculty can comment and approve drafts, but can’t add to them"') +
      ' aria-label="Add ' + esc(r.group_name) + ' to a draft">Add</button>';
  return '<article class="sug-card cmp ' + tierClass(r) + '" data-id="' + id + '"><div class="sug-top cmp-row"><h3>' + toggleHtml(r, false) + '</h3>' + schPill(r.school, true) +
    '<span class="cmp-n">' + n.join('<span aria-hidden="true"> · </span>') + '</span><div class="card-acts">' + acts + '</div></div>' +
    '<div class="sug-detail" id="sd-' + id + '" role="region" aria-labelledby="tg-' + id + '" hidden></div></article>';
}
export function densityHtml(cur) {
  return '<div class="dens" role="radiogroup" aria-label="Card size">' + [['comfortable', 'Comfortable'], ['compact', 'Compact']].map((o) =>
    '<button type="button" role="radio" data-dens="' + o[0] + '" aria-checked="' + (cur === o[0]) + '">' + o[1] + '</button>').join('') + '</div>';
}

/* ===== List ===== */
export function renderList(pending) {
  const el = $('#sug-list'); if (!el) return;
  el.setAttribute('aria-busy', String(!!pending));
  if (pending) return;
  const list = visibleRows(), trash = V.view === 'trash', total = trash ? inTrash() : V.rows.length - inTrash();
  $('#sug-n').textContent = V.err ? '' : 'Showing ' + list.length + ' of ' + total + (trash ? ' in Trash' : ' categories in the database');
  if (V.err) { el.innerHTML = '<div class="err-box">' + esc(V.err) + ' <button type="button" class="btn small" id="sug-retry">Try again</button></div>'; return; }
  // Cards glide to their new places; a trashed or restored card fades out where it was (ws-motion.js).
  const dens = list.length && el.classList.contains('compact') !== compactOn();
  const draw = () => {
    if (!list.length) {
      el.innerHTML = '<p class="empty">' + (trash ? (total ? 'Nothing in Trash matches these filters.' : 'Trash is empty.')
        : !total ? 'Nothing here yet. New categories show up here as students send them.' : 'Nothing matches these filters. Try clearing one.') + '</p>';
      return;
    }
    el.innerHTML = list.map(cardHtml).join('');
    el.classList.toggle('compact', compactOn());
  };
  if (dens) { draw(); enter(el); } else flip(el, '.sug-card[data-id]', (x) => x.dataset.id, draw, { exit: 'slide' });
  if (!list.length) return;
  fillImages(el);
  const fresh = V.justOpened; V.justOpened = false;
  const r = V.open && rowById(V.open), box = r && document.getElementById('sd-' + r.id);
  if (box) mountDetail(box, r, fresh);
  paintCats();
}
/* Re-draws everything that shows category data (after any change). */
export function redraw() { renderSubtabs(); renderFilters(); renderActive(); renderList(); }
export const hashFor = (id) => (id ? ROUTE + '/' + encodeURIComponent(id) : V.view === 'trash' ? ROUTE + '/trash' : ROUTE);
function focusToggle(id) { const t = document.getElementById('tg-' + id); if (t) t.focus(); return t; }
export function openCard(id) {
  V.open = id; V.justOpened = true;
  history.replaceState(null, '', location.pathname + location.search + hashFor(id));
  renderList(); presenceChanged();
  const t = document.getElementById('tg-' + id);
  if (t) t.closest('.sug-card').scrollIntoView({ block: 'nearest' });
}
export function closeCard(focus) {
  const id = V.open; if (!id) return;
  V.open = null;
  history.replaceState(null, '', location.pathname + location.search + hashFor(null));
  renderList(); presenceChanged();
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
    '<section aria-label="' + (V.view === 'trash' ? 'Trash' : 'Categories') + '">' + searchHtml(null, densityHtml(compactOn() ? 'compact' : 'comfortable')) +
    '<div class="active-f" id="active-f" aria-label="Active filters"></div><p class="result-n" id="sug-n" aria-live="polite"></p>' +
    '<div class="stack" style="--gap:10px" id="sug-list"></div></section></div>';
  wireFilters();
  wireListActions($('#sug-list'));
  $('#ws-main .dens').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dens]'); if (!b) return;
    prefSet(DENSITY_KEY, b.dataset.dens === 'compact' ? 'compact' : null);
    $$('#ws-main .dens [data-dens]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    renderList(); b.focus();
  });
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

/* ===== Live updates (ws-live.js notes, routed by ws-main) =====
   Fetches fresh data, then redraws in place. While someone is typing in the
   open card (a comment, tags, a fix) that card is left alone and only the
   other cards change; the rest catches up as soon as they are done. */
const cardEl = (id) => document.querySelector('#sug-list .sug-card[data-id="' + CSS.escape(id) + '"]');
const openBusy = () => {
  const box = V.open && document.getElementById('sd-' + V.open);
  return !!V.open && (DS.fixing === V.open || typingIn(box) || dirtyIn(box) || modalOpen() || !!$('#sug-list .mnu-pop:not([hidden])'));
};
function patchCard(id) {
  const el = cardEl(id), r = rowById(id); if (!el || !r || id === V.open) return;
  const tmp = document.createElement('div'); tmp.innerHTML = cardHtml(r);
  const n = tmp.firstElementChild; el.replaceWith(n); fillImages(n);
}
/* notes: [{ t, op, by, items }] from the bank/school channels. */
export async function liveCats(notes) {
  if (!V.loaded) return;
  const ids = new Map();
  notes.forEach((n) => (n.items || []).forEach((i) => {
    const id = n.t === 'submissions' ? i.id : n.t === 'comments' ? (i.type === 'submission' ? i.target : null) : i.sid;
    if (id) ids.set(id, { by: n.by, what: n.t === 'submissions' && n.op === 'insert' ? 'New' : n.t === 'comments' ? 'New comment' : n.t === 'votes' ? 'Vote' : 'Updated' });
  }));
  await reload();
  if (!$('#sug-list') || V.err) return;
  const before = new Set($$('#sug-list .sug-card[data-id]').map((x) => x.dataset.id));
  if (openBusy()) {
    renderSubtabs();
    const same = visibleRows().every((r) => before.has(r.id)) && before.size === visibleRows().length;
    ids.forEach((v, id) => patchCard(id));
    V.livePending = !same || ids.has(V.open) || ids.size === 0;
    if (V.livePending) whenIdle('cats', () => !$('#sug-list') || openBusy(), catchUp);
  } else {
    await keepFocus(() => {
      renderSubtabs(); renderActive();
      const f = $('#filters'); if (!(f && f.contains(document.activeElement))) renderFilters();
      renderList();
    });
    V.livePending = false;
  }
  ids.forEach((v, id) => flash(cardEl(id), v.by, v.what));
  paintCats();
}
/* Catch up once the person has finished (sent or cleared) what they were typing. */
function catchUp() {
  if (!V.livePending || !$('#sug-list')) return;
  V.livePending = false;
  keepFocus(() => { renderSubtabs(); renderActive(); renderList(); });
}
