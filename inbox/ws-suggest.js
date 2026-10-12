/* Puzzle workspace: the Suggestions tab. Search + filters + sort, cards that show
   every clue, and one card at a time opening in place (#s=<id> is shareable).
   The server does the word search (the "search" column), kind, named/anonymous,
   dates, block tags and the order; status, difficulty and clue types are applied
   here so the status chips can show counts. */
import { S, $, $$, esc, busy, toast, plainError, ago, dayKey, av, avs, person, isPuzzle, groupsOf, itemsOf, allItems,
  ZONES, TIER_WORDS, STATUS_WORDS, modalOpen } from './ws-core.js';
import { mountDetail, toggleVote } from './ws-detail.js';
import { downloadShortlisted } from './ws-import.js';

export const COLS = 'id, created_at, kind, status, suggested_tier, group_name, payload, credit_mode, credit_name, credit_line, ' +
  'contact_email, consent, admin_note, used_in, receipt_code, reviewed_by, reviewed_at, tags';
export const BLOCKS = ['Cardio', 'Pulm', 'Renal', 'GI', 'Heme', 'Neuro', 'MSK', 'Endo', 'Repro', 'Derm', 'Micro', 'Pharm', 'Genetics'];
const CTYPES = [['slide', 'Slide'], ['xray', 'X-ray'], ['photo', 'Photo'], ['text', 'Text']];
const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['votes', 'Most 👍'], ['name', 'Name A–Z']];
const blankF = () => ({ q: '', st: [], kind: [], tier: [], ct: [], block: [], sub: 'all', from: '', to: '', sort: 'newest' });
const F = Object.assign(blankF(), { open: false });
/* rows = this search's results; votes: id -> [emails]; cmts: id -> count; last: id -> latest status event. */
const V = { rows: [], votes: new Map(), cmts: new Map(), last: new Map(), counts: { total: 0, new: 0 },
  open: null, pinned: null, seq: 0, err: '', loading: false, loaded: false, justOpened: false, onCounts: () => {} };

export const newCount = () => V.counts.new;
export const rowById = (id) => V.rows.find((r) => r.id === id) || (V.pinned && V.pinned.id === id ? V.pinned : null);
export const votesOf = (id) => V.votes.get(id) || [];
export const lastEvent = (id) => V.last.get(id) || null;

/* ===== Data ===== */
function nextDay(d) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + 1); return x; }
async function fetchRows() {
  let q = S.sb.from('submissions').select(COLS);
  const words = F.q.trim();
  if (words) q = q.textSearch('search', words, { type: 'websearch', config: 'english' });
  if (F.kind.length === 1) q = q.eq('kind', F.kind[0]);
  if (F.sub !== 'all') q = q.eq('credit_mode', F.sub === 'named' ? 'named' : 'anonymous');
  if (F.from) q = q.gte('created_at', new Date(F.from + 'T00:00:00').toISOString());
  if (F.to) q = q.lt('created_at', nextDay(F.to).toISOString());
  if (F.block.length) q = q.overlaps('tags', F.block);
  q = q.order(F.sort === 'name' ? 'group_name' : 'created_at', { ascending: F.sort === 'oldest' || F.sort === 'name' }).limit(1000);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
async function fetchMeta() {
  const [counts, votes, cmts, evs] = await Promise.all([
    S.sb.from('submissions').select('id, status').limit(5000),
    S.sb.from('votes').select('submission_id, voter_email').limit(10000),
    S.sb.from('comments').select('target_id').eq('target_type', 'submission').limit(10000),
    S.sb.from('review_events').select('submission_id, actor_email, action, note, at')
      .in('action', ['shortlist', 'decline', 'reopen', 'used']).order('at', { ascending: false }).limit(5000),
  ]);
  const bad = [counts, votes, cmts, evs].find((r) => r.error);
  if (bad) throw bad.error;
  V.counts = { total: counts.data.length, new: counts.data.filter((r) => r.status === 'new').length,
    shortlisted: counts.data.filter((r) => r.status === 'shortlisted').length };
  V.votes = new Map(); votes.data.forEach((v) => { const k = v.submission_id; if (!V.votes.has(k)) V.votes.set(k, []); V.votes.get(k).push(v.voter_email); });
  V.cmts = new Map(); cmts.data.forEach((c) => V.cmts.set(c.target_id, (V.cmts.get(c.target_id) || 0) + 1));
  V.last = new Map(); evs.data.forEach((e) => { if (!V.last.has(e.submission_id)) V.last.set(e.submission_id, e); });
}
/* meta: also reload votes/comments/history (after your own actions and Refresh). */
export async function reload(meta) {
  const seq = ++V.seq; V.loading = true;
  try {
    const [rows] = await Promise.all([fetchRows(), meta ? fetchMeta() : null]);
    if (seq !== V.seq) return;
    V.rows = rows; V.err = '';
    if (V.open && !V.rows.some((r) => r.id === V.open)) {
      const { data } = await S.sb.from('submissions').select(COLS).eq('id', V.open);
      V.pinned = data && data[0] ? data[0] : null;
      if (!V.pinned) V.open = null;
    } else V.pinned = null;
  } catch (e) {
    if (seq !== V.seq) return;
    V.err = plainError(e);
  } finally { if (seq === V.seq) V.loading = false; }
  V.onCounts();
}

/* ===== Matching done here (status, difficulty, clue types) ===== */
const clueKinds = (r) => new Set(allItems(r).map((it) => (ZONES[it.zone] || [])[2]).filter(Boolean));
function match(r, skip) {
  if (skip !== 'st' && F.st.length && !F.st.includes(r.status)) return false;
  if (F.kind.length && !F.kind.includes(r.kind)) return false;
  // A full puzzle holds all four difficulties, so it always passes this one.
  if (F.tier.length && !isPuzzle(r) && !F.tier.includes(String(r.suggested_tier))) return false;
  if (F.ct.length) { const k = clueKinds(r); if (!F.ct.some((c) => k.has(c))) return false; }
  return true;
}
function visibleRows() {
  const list = V.rows.filter((r) => match(r) || r.id === V.open);
  if (V.pinned && !list.some((r) => r.id === V.pinned.id)) list.unshift(V.pinned);
  if (F.sort === 'votes') list.sort((a, b) => votesOf(b.id).length - votesOf(a.id).length || (a.created_at < b.created_at ? 1 : -1));
  return list;
}

/* ===== Cards ===== */
export function attribHtml(r) {
  const e = lastEvent(r.id);
  const fresh = e && ({ shortlisted: 'shortlist', declined: 'decline', used: 'used', new: 'reopen' }[r.status] === e.action);
  const who = fresh ? e.actor_email : r.reviewed_by, at = fresh ? e.at : r.reviewed_at;
  if (!who && !at) return '';
  if (r.status === 'new' && !fresh) return '';
  const by = who ? esc(person(who).name) : 'someone', day = at ? ' · ' + esc(new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })) : '';
  const lead = '<p class="attrib ' + esc(r.status) + '">' + av(who);
  if (r.status === 'shortlisted') return lead + 'Shortlisted by ' + by + day + '</p>';
  if (r.status === 'declined') { const note = fresh ? e.note : r.admin_note; return lead + 'Declined by ' + by + day + (note ? ' — <q>' + esc(note) + '</q>' : '') + '</p>'; }
  if (r.status === 'used') return lead + 'Used in ' + (r.used_in ? '<span class="code">' + esc(r.used_in) + '</span>' : 'a puzzle') + ' · marked by ' + by + day + '</p>';
  return lead + 'Moved back to New by ' + by + day + '</p>';
}
export function tierClass(r) { return isPuzzle(r) ? 'tp' : 't' + (Number(r.suggested_tier) || 0); }
function inlineClues(r) {
  if (isPuzzle(r)) {
    const gs = groupsOf(r).slice().sort((a, b) => (Number(a.tier) || 9) - (Number(b.tier) || 9));
    const n = gs.reduce((a, g) => a + itemsOf(g).length, 0);
    return '<ul class="grp-inline">' + gs.map((g) => '<li><span class="tierdot t' + (Number(g.tier) || 0) + '" title="' + esc(TIER_WORDS[g.tier] || '') + '"></span>' + esc(g.name) + '</li>').join('') +
      '</ul><p class="faint" style="font-size:.76rem">' + gs.length + ' groups · ' + n + ' clues</p>';
  }
  return '<ul class="clue-inline">' + itemsOf(r.payload).map((it) => {
    const z = ZONES[it.zone] || ['Clue', '•'];
    return '<li title="' + esc(z[0]) + '"><span class="ki" aria-hidden="true">' + z[1] + '</span><span class="sr">' + esc(z[0]) + ': </span>' + esc(it.label) + '</li>';
  }).join('') + '</ul>';
}
function cardHtml(r) {
  const open = V.open === r.id, vs = votesOf(r.id), mine = vs.includes(S.me), n = V.cmts.get(r.id) || 0;
  const tier = isPuzzle(r) ? 'Full puzzle' : 'Suggested: ' + (TIER_WORDS[r.suggested_tier] || '?');
  return '<article class="sug-card ' + tierClass(r) + (open ? ' open' : '') + '" data-id="' + esc(r.id) + '"><div class="sug-top"><div class="stack" style="--gap:6px">' +
    '<h3><span class="tierdot" title="' + esc(tier) + '"></span><button type="button" class="sug-toggle" id="tg-' + esc(r.id) + '" data-id="' + esc(r.id) + '" aria-expanded="' + open + '" aria-controls="sd-' + esc(r.id) + '">' + esc(r.group_name) + '</button>' +
    (isPuzzle(r) ? '<span class="kind-tag puzzle">Full puzzle</span>' : '') + '</h3>' +
    '<div class="meta"><span>' + (r.credit_mode === 'named' && r.credit_name ? esc(r.credit_name) : '<i>Anonymous</i>') + '</span><span title="' + esc(new Date(r.created_at).toLocaleString()) + '">' + esc(ago(r.created_at)) + '</span>' +
    (r.tags || []).map((t) => '<span class="tagchip">' + esc(t) + '</span>').join('') + '</div>' + inlineClues(r) + '</div>' +
    '<div class="side"><span class="st st-' + esc(r.status) + '">' + esc(STATUS_WORDS[r.status] || r.status) + '</span>' +
    '<span class="vote"><button type="button" class="btn small vote-btn" data-id="' + esc(r.id) + '" aria-pressed="' + mine + '" aria-label="Thumbs up ' + esc(r.group_name) + ', ' + vs.length + ' so far">👍 ' + vs.length + '</button>' + avs(vs) + '</span>' +
    '<span class="faint" style="font-size:.78rem" title="Comments">💬 ' + n + '<span class="sr"> comments</span></span><span class="chev" aria-hidden="true"></span></div>' + attribHtml(r) + '</div>' +
    '<div class="sug-detail' + (open && V.justOpened ? ' anim' : '') + '" id="sd-' + esc(r.id) + '" role="region" aria-labelledby="tg-' + esc(r.id) + '"' + (open ? '' : ' hidden') + '></div></article>';
}

/* ===== Filters ===== */
function chipGroup(key, opts, label) {
  return '<fieldset class="fgroup"><legend class="eyebrow">' + label + '</legend><div class="chips">' + opts.map((o) =>
    '<button type="button" class="chip" data-f="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + F[key].includes(o[0]) + '">' + (o[2] || '') + esc(o[1]) +
    (o[3] != null ? ' <span class="n">' + o[3] + '</span>' : '') + '</button>').join('') + '</div></fieldset>';
}
function renderFilters() {
  const el = $('#filters'); if (!el) return;
  const stN = (st) => V.rows.filter((r) => r.status === st && match(r, 'st')).length;
  const blocks = BLOCKS.slice(); V.rows.forEach((r) => (r.tags || []).forEach((t) => { if (!blocks.includes(t)) blocks.push(t); }));
  F.block.forEach((t) => { if (!blocks.includes(t)) blocks.push(t); });
  el.innerHTML = chipGroup('st', Object.keys(STATUS_WORDS).map((s) => [s, STATUS_WORDS[s], '', stN(s)]), 'Status') +
    chipGroup('kind', [['category', 'Category'], ['puzzle', 'Full puzzle']], 'Kind') +
    chipGroup('tier', [1, 2, 3, 4].map((t) => [String(t), TIER_WORDS[t], '<span class="tierdot t' + t + '"></span>']), 'Suggested difficulty') +
    chipGroup('ct', CTYPES, 'Clue types') + chipGroup('block', blocks.map((b) => [b, b]), 'Block / system') +
    '<fieldset class="fgroup"><legend class="eyebrow">Submitter</legend><div class="chips">' + [['all', 'Anyone'], ['named', 'Named'], ['anon', 'Anonymous']].map((o) =>
      '<button type="button" class="chip" data-sub="' + o[0] + '" aria-pressed="' + (F.sub === o[0]) + '">' + o[1] + '</button>').join('') + '</div></fieldset>' +
    '<fieldset class="fgroup"><legend class="eyebrow">Submitted between</legend><div class="fdates">' +
    '<label class="field"><span>From</span><input class="input" type="date" id="f-from" value="' + esc(F.from) + '"></label>' +
    '<label class="field"><span>To</span><input class="input" type="date" id="f-to" value="' + esc(F.to) + '"></label></div></fieldset>' +
    '<button type="button" class="btn small" id="f-clear">Clear filters</button>';
}
const SERVER_KEYS = ['kind', 'block'];
async function changed(key, focusSel) {
  if (!key || SERVER_KEYS.includes(key) || key === 'sub' || key === 'date' || key === 'all') { renderList(true); await reload(false); }
  renderFilters(); renderList();
  if (focusSel) { const b = $(focusSel); if (b) b.focus(); }
}

/* ===== List ===== */
function renderList(pending) {
  const el = $('#sug-list'); if (!el) return;
  el.setAttribute('aria-busy', String(!!pending));
  if (pending) return;
  const list = visibleRows(), q = F.q.trim();
  $('#sug-n').textContent = V.err ? '' : list.length + (list.length === 1 ? ' suggestion' : ' suggestions') + (q ? ' for “' + q + '”' : '');
  const dl = $('#btn-dl-short'); if (dl && !dl.textContent.startsWith('Downloading')) dl.disabled = !V.counts.shortlisted;
  if (V.err) { el.innerHTML = '<div class="err-box">' + esc(V.err) + ' <button type="button" class="btn small" id="sug-retry">Try again</button></div>'; return; }
  if (!list.length) {
    el.innerHTML = '<p class="empty">' + (!V.counts.total ? 'Nothing here yet. New categories and puzzles show up here as students send them.'
      : q ? 'No suggestions match “' + esc(q) + '”. Try fewer or different words.' : 'Nothing matches these filters.') + '</p>';
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
  V.justOpened = false;
  const r = V.open && rowById(V.open), box = r && document.getElementById('sd-' + r.id);
  if (box) mountDetail(box, r);
}
/* Re-draws everything that shows suggestion data (after any change). */
export function redraw() { renderFilters(); renderList(); }
function focusToggle(id) { const t = document.getElementById('tg-' + id); if (t) t.focus(); return t; }
export function openCard(id) {
  V.open = id; V.justOpened = true;
  history.replaceState(null, '', location.pathname + location.search + '#s=' + encodeURIComponent(id));
  renderList();
  const t = document.getElementById('tg-' + id);
  if (t) t.closest('.sug-card').scrollIntoView({ block: 'nearest' });
}
export function closeCard(focus) {
  const id = V.open; if (!id) return;
  V.open = null; V.pinned = null;
  history.replaceState(null, '', location.pathname + location.search + '#/suggestions');
  renderList();
  if (focus) focusToggle(id);
}

/* ===== The tab ===== */
function renderView() {
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Suggestions</p><h1>Categories and full puzzles</h1></div>' +
    '<div class="row" style="--gap:8px"><button class="btn" type="button" id="btn-refresh">Refresh</button>' +
    '<button class="btn" type="button" id="btn-dl-short">Download all shortlisted</button></div></div>' +
    '<div class="searchbar" role="search"><label class="sr" for="sug-q">Search suggestions</label>' +
    '<input class="input" type="search" id="sug-q" autocomplete="off" placeholder="Search names, clues, explanations…" value="' + esc(F.q) + '">' +
    '<label class="sr" for="sug-sort">Sort</label><select class="input" id="sug-sort">' +
    SORTS.map((o) => '<option value="' + o[0] + '"' + (F.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
    '<button class="btn ftoggle" type="button" id="f-toggle" aria-controls="filters" aria-expanded="' + F.open + '">Filters</button></div>' +
    '<div class="sug-layout"><div class="filters' + (F.open ? ' open' : '') + '" id="filters" role="group" aria-label="Filters"></div>' +
    '<div><p class="result-n" id="sug-n" aria-live="polite"></p><div class="stack" style="--gap:10px" id="sug-list"></div></div></div>';
  let timer = 0;
  $('#sug-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { F.q = e.target.value; changed('all'); }, 300); });
  $('#sug-sort').addEventListener('change', (e) => { F.sort = e.target.value; changed(F.sort === 'votes' ? 'st' : 'all'); });
  $('#f-toggle').addEventListener('click', (e) => { F.open = !F.open; $('#filters').classList.toggle('open', F.open); e.currentTarget.setAttribute('aria-expanded', String(F.open)); });
  $('#btn-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => {
    await reload(true); redraw(); if (!V.err) toast('Up to date');
  }));
  $('#btn-dl-short').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const { data, error } = await S.sb.from('submissions').select(COLS).eq('status', 'shortlisted').order('created_at', { ascending: false }).limit(1000);
    if (error) { toast(plainError(error), 5000); return; }
    await downloadShortlisted(data || [], b);
  });
  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-f]');
    if (c) { const a = F[c.dataset.f], i = a.indexOf(c.dataset.v); if (i < 0) a.push(c.dataset.v); else a.splice(i, 1); changed(c.dataset.f, '[data-f="' + c.dataset.f + '"][data-v="' + c.dataset.v + '"]'); return; }
    const s = e.target.closest('[data-sub]');
    if (s) { F.sub = s.dataset.sub; changed('sub', '[data-sub="' + F.sub + '"]'); return; }
    if (e.target.id === 'f-clear') { Object.assign(F, blankF(), { open: F.open }); $('#sug-q').value = ''; $('#sug-sort').value = 'newest'; changed('all', '#f-clear'); }
  });
  $('#filters').addEventListener('change', (e) => {
    if (e.target.id === 'f-from') F.from = e.target.value; else if (e.target.id === 'f-to') F.to = e.target.value; else return;
    changed('date', '#' + e.target.id);
  });
  $('#sug-list').addEventListener('click', async (e) => {
    if (e.target.id === 'sug-retry') { renderList(true); await reload(true); redraw(); return; }
    const vb = e.target.closest('.vote-btn');
    if (vb && !vb.closest('.sug-detail')) {
      const id = vb.dataset.id;
      await busy(vb, '…', () => toggleVote(id));
      renderList(); const again = $('.sug-top .vote-btn[data-id="' + id + '"]'); if (again) again.focus();
      return;
    }
    const t = e.target.closest('.sug-toggle');
    if (t) { if (V.open === t.dataset.id) closeCard(true); else openCard(t.dataset.id); }
  });
}

/* Called by ws-main when the Suggestions tab shows; id = a card to open (#s=<id>). */
export async function showSuggestions(id) {
  if (id) { V.open = id; V.justOpened = true; }
  renderView();
  if (!V.loaded || id) {
    renderList(true);
    await reload(!V.loaded); V.loaded = !V.err;
    if (id && !V.open && !V.err) { toast('That suggestion isn’t in the inbox any more.', 4000); history.replaceState(null, '', location.pathname + location.search + '#/suggestions'); }
  }
  redraw();
  if (id && V.open) { const t = focusToggle(id); if (t) t.closest('.sug-card').scrollIntoView({ block: 'center' }); }
}
export function initSuggest(onCounts) {
  V.onCounts = onCounts;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !V.open || modalOpen() || !$('#sug-list')) return;
    const t = e.target;
    if ((t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.value) return; // don't throw away typing
    closeCard(true);
  });
}
/* Sign-out: forget everything. */
export function resetSuggest() {
  Object.assign(F, blankF(), { open: false });
  Object.assign(V, { rows: [], votes: new Map(), cmts: new Map(), last: new Map(), counts: { total: 0, new: 0 }, open: null, pinned: null, err: '', loaded: false });
}
