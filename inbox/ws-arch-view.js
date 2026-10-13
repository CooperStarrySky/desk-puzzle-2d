/* Puzzle workspace: the Archive tab. Two views: "By puzzle" (every published
   puzzle with its four categories, credits and class numbers) and
   "Categories" (the category bank: one row per category, how often it was
   used, 👍, status; searchable, filterable, sortable). Clicking a category
   opens it (ws-arch-dialogs.js). Routes: #/archive, #/archive/categories. */
import { $, $$, esc, busy, toast, avs, person, TIER_WORDS, STATUS_WORDS } from './ws-core.js';
import { BLOCKS } from './ws-suggest.js';
import { AR, BANK, loadBank, schoolName } from './ws-arch-data.js';
import { ARCH } from './ws-plan-checks.js';
import { dayLabel } from './ws-plan-time.js';
import { classSummary, isStatsEligible } from '../src/stats-core.js';
import { openCategory, openReuse } from './ws-arch-dialogs.js';

const STEP = 60;
export const AF = { view: 'puzzles', q: '', school: '', block: '', use: 'any', votes: '0', status: '', sort: 'used', shown: STEP };
const SORTS = [['used', 'Most used'], ['votes', 'Most 👍'], ['newest', 'Newest'], ['name', 'Name A–Z']];
const USES = [['any', 'Used or not'], ['used', 'Used'], ['never', 'Never used']];
const VOTES = [['0', 'Any 👍'], ['1', '1+ 👍'], ['2', '2+ 👍'], ['3', '3+ 👍']];
const q = () => AF.q.trim().toLowerCase();

export function hl(text, needle) {
  const t = String(text == null ? '' : text), i = needle ? t.toLowerCase().indexOf(needle) : -1;
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + needle.length)) + '</mark>' + esc(t.slice(i + needle.length));
}
const fmt = (d) => (d ? dayLabel(String(d).slice(0, 10), true) : '');
const catOk = (r) => (!AF.school || r.school === AF.school) && (!AF.block || r.tags.includes(AF.block)) && (!q() || r.hay.includes(q()));
export function filteredCats() {
  const n = Number(AF.votes) || 0;
  const out = BANK.cats.filter((r) => catOk(r) && (AF.use === 'any' || (AF.use === 'used' ? r.usedN > 0 : r.usedN === 0)) && r.votes >= n && (!AF.status || r.status === AF.status));
  const by = { used: (a, b) => b.usedN - a.usedN || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0), votes: (a, b) => b.votes - a.votes || b.usedN - a.usedN,
    newest: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0), name: () => 0 }[AF.sort];
  return out.sort((a, b) => by(a, b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
export function filteredPuzzles() {
  return BANK.puzzles.filter((p) => (!AF.school || p.school === AF.school) && (!AF.block || p.blocks.includes(AF.block)) &&
    (!q() || p.title.toLowerCase().includes(q()) || p.cats.some((r) => r && r.hay.includes(q()))));
}

/* ===== By puzzle ===== */
function statsHtml(p) {
  if (AR.statsErr) return '<p class="arch-note">Class stats could not be loaded: ' + esc(AR.statsErr) + '</p>';
  const s = classSummary(p.stats);
  if (!s || !s.plays) return '<p class="arch-note">' + (isStatsEligible(p.id) ? 'No plays recorded yet. Class stats start counting from the first finish.' : 'Stats start with puzzles after Oct 11.') + '</p>';
  const stat = (k, v) => '<div class="stat"><span class="eyebrow">' + k + '</span><b>' + esc(v) + '</b></div>';
  return '<div class="stats" aria-label="Class stats">' + stat('Plays', String(s.plays)) +
    stat('Solved', s.stdFinishes ? s.solvedPct + '%' : '–') + stat('Avg wrong guesses', s.stdFinishes ? s.avgMistakes.toFixed(1) : '–') +
    stat('Rated', s.ratingN ? s.ratingLabel + ' · ' + s.ratingN : 'No ratings') + '</div>' +
    (s.stdFinishes < 10 ? '<p class="hint">Fewer than 10 standard finishes so far, so these numbers will still move. (Players see them from 10.)</p>' : '');
}
function puzzleCard(p) {
  const n = q();
  return '<article class="arch-card" data-pid="' + esc(p.id) + '"><div class="row spread arch-top"><div class="stack" style="--gap:3px"><p class="eyebrow">Released ' + esc(fmt(p.date)) +
    (p.id === ARCH.current ? ' · <span class="live">Live now</span>' : '') + '</p><h2>' + hl(p.title, n) + '</h2>' +
    '<div class="row" style="--gap:6px"><span class="badge school">' + esc(schoolName(p.school)) + '</span>' + p.blocks.map((b) => '<span class="tagchip">' + esc(b) + '</span>').join('') + '</div></div>' +
    '<div class="row" style="--gap:8px">' + (p.people.length ? avs(p.people) : '') + '<button type="button" class="btn small" data-reuse="' + esc(p.id) + '">Reuse as starting point</button></div></div>' +
    '<div class="arch-cats">' + p.full.map((g, i) => {
      const r = p.cats[i], cr = g.credit || (r && r.it && r.credit), uses = r ? r.usedN : 1;
      return '<button type="button" class="arch-cat t' + (g.tier || 0) + '" data-cat="' + esc(r ? r.key : '') + '"><b><span class="tierdot" aria-hidden="true"></span>' + hl(g.name, n) + '</b>' +
        '<small>' + esc(TIER_WORDS[g.tier] || 'Tier ?') + (cr && cr.name ? ' · by ' + esc(cr.name) : '') + (uses > 1 ? ' · used ' + uses + '×' : '') + '</small>' +
        '<small>' + g.items.map((c) => hl(c.label, n)).join(' · ') + '</small></button>';
    }).join('') + '</div>' +
    '<p class="arch-credits"><span class="faint">Credits:</span> ' + (p.credits.length ? esc(p.credits.join(', ')) : 'none recorded') +
    (p.people.length ? ' <span class="faint">· Built by</span> ' + esc(p.people.map((e) => person(e).name).join(', ')) : '') + '</p>' + statsHtml(p) + '</article>';
}

/* ===== Categories ===== */
function catRow(r) {
  const n = q(), clues = r.items.map((c) => c.label);
  const hit = n && !r.name.toLowerCase().includes(n) ? clues.filter((c) => c.toLowerCase().includes(n)) : [];
  return '<li><button type="button" class="cat-row t' + (r.tier || 0) + '" data-cat="' + esc(r.key) + '">' +
    '<span class="cr-name"><b>' + hl(r.name, n) + '</b>' + (r.parent ? '<small class="faint">from full puzzle “' + esc(r.parent) + '”</small>' : '') +
    (r.same ? '<small class="same-hint">Same name as a used category: ' + esc(r.same.name) + ' (used ' + r.same.n + '×)</small>' : '') +
    '<small class="muted">' + (hit.length ? 'Clue: ' + hit.map((c) => hl(c, n)).join(' · ') : clues.map((c) => hl(c, n)).join(' · ')) + '</small></span>' +
    '<span class="cr-tier"><span class="tierdot" aria-hidden="true"></span>' + esc(TIER_WORDS[r.tier] || 'No tier') + '</span>' +
    '<span class="cr-tags">' + (r.tags.length ? r.tags.map((t) => '<span class="tagchip">' + esc(t) + '</span>').join('') : '<span class="faint">No block</span>') + '</span>' +
    '<span class="cr-school"><span class="badge school">' + esc(schoolName(r.school)) + '</span></span>' +
    '<span class="cr-used' + (r.usedN ? ' on' : '') + '">' + (r.usedN ? 'Used ' + r.usedN + '×' : 'Never used') + '</span>' +
    '<span class="cr-votes"><span aria-hidden="true">👍</span> ' + r.votes + '<span class="sr"> votes</span></span>' +
    '<span class="cr-last">' + (r.last ? '<span class="sr">Last used </span>' + esc(fmt(r.last)) : '<span class="faint">–</span>') + '</span>' +
    '<span class="cr-st"><span class="st st-' + esc(r.status) + '">' + esc(r.it ? STATUS_WORDS[r.status] || r.status : 'Published') + '</span></span></button></li>';
}
const HEAD = '<div class="cat-head" aria-hidden="true"><span>Category</span><span>Tier</span><span>Block</span><span>School</span><span>Used</span><span>👍</span><span>Last used</span><span>Status</span></div>';

function renderList() {
  const out = $('#ar-out'); if (!out) return;
  if (AF.view === 'categories') {
    const rows = filteredCats(), show = rows.slice(0, AF.shown);
    $('#ar-n').textContent = rows.length + ' of ' + BANK.cats.length + (BANK.cats.length === 1 ? ' category' : ' categories') + ' match';
    out.innerHTML = rows.length ? HEAD + '<ul class="cat-list">' + show.map(catRow).join('') + '</ul>' +
      (rows.length > show.length ? '<p class="more"><button type="button" class="btn" id="ar-more">Show ' + Math.min(STEP, rows.length - show.length) + ' more</button> <span class="faint">' + show.length + ' of ' + rows.length + ' shown</span></p>' : '')
      : '<p class="empty">No category matches. If you searched for an idea, it looks fresh.</p>';
  } else {
    const ps = filteredPuzzles();
    $('#ar-n').textContent = ps.length + ' of ' + BANK.puzzles.length + ' published puzzles match';
    out.innerHTML = ARCH.err ? '<div class="err-box">' + esc(ARCH.err) + '</div>' : ps.length ? '<div class="arch-list">' + ps.map(puzzleCard).join('') + '</div>'
      : '<p class="empty">No published puzzle matches.</p>';
  }
}
const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
const sel = (id, label, list, cur) => '<label class="sr" for="' + id + '">' + label + '</label><select class="input" id="' + id + '">' + list.map((o) => opt(o[0], o[1], cur)).join('') + '</select>';
function toolsHtml() {
  const schools = ['cmsru']; BANK.cats.concat(BANK.puzzles).forEach((x) => { if (!schools.includes(x.school)) schools.push(x.school); });
  const blocks = BLOCKS.slice(); BANK.cats.forEach((r) => r.tags.forEach((t) => { if (!blocks.includes(t)) blocks.push(t); }));
  const cats = AF.view === 'categories';
  return '<div class="arch-tools"><label class="sr" for="ar-q">Search categories, explanations and clues</label><input class="input" id="ar-q" type="search" autocomplete="off" placeholder="' +
    (cats ? 'Search categories, explanations and clues…' : 'Search puzzles, categories and clues…') + '" value="' + esc(AF.q) + '">' +
    sel('ar-school', 'School', [['', 'Any school']].concat(schools.map((s) => [s, schoolName(s)])), AF.school) +
    sel('ar-block', 'Block', [['', 'Any block']].concat(blocks.map((b) => [b, b])), AF.block) +
    (cats ? sel('ar-use', 'Used or not', USES, AF.use) + sel('ar-votes', 'Minimum 👍', VOTES, AF.votes) +
      sel('ar-status', 'Status', [['', 'Any status']].concat(Object.keys(STATUS_WORDS).map((k) => [k, STATUS_WORDS[k]])), AF.status) +
      sel('ar-sort', 'Sort', SORTS, AF.sort) : '') + '</div>';
}
function render() {
  const cats = AF.view === 'categories';
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Archive</p><h1>' + (cats ? 'Category bank' : 'Published puzzles') + '</h1></div>' +
    '<div class="row" style="--gap:6px"><nav class="chips" aria-label="Archive view"><a class="chip" href="#/archive"' + (cats ? '' : ' aria-current="page"') + '>By puzzle</a>' +
    '<a class="chip" href="#/archive/categories"' + (cats ? ' aria-current="page"' : '') + '>Categories</a></nav><button class="btn" type="button" id="ar-refresh">Refresh</button></div></div>' +
    (cats ? '<p class="muted arch-intro">Every category sent in or published. “Used” counts published puzzles that hold it (a suggestion counts only if it was in a published draft or marked used there; older hand-made categories are matched by name).</p>' : '') +
    toolsHtml() + '<p class="result-n" id="ar-n" aria-live="polite"></p><div id="ar-out"></div>';
  const set = (id, k) => $('#' + id) && $('#' + id).addEventListener(id === 'ar-q' ? 'input' : 'change', (e) => { AF[k] = e.target.value; AF.shown = STEP; renderList(); });
  [['ar-q', 'q'], ['ar-school', 'school'], ['ar-block', 'block'], ['ar-use', 'use'], ['ar-votes', 'votes'], ['ar-status', 'status'], ['ar-sort', 'sort']].forEach((x) => set(x[0], x[1]));
  $('#ar-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => { await loadBank(); renderList(); toast('Up to date'); }));
  $('#ar-out').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]'), r = e.target.closest('[data-reuse]');
    if (e.target.id === 'ar-more') { AF.shown += STEP; const i = AF.shown - STEP; renderList(); const b = $$('.cat-row')[i]; if (b) b.focus(); return; }
    if (r) { const p = BANK.puzzles.find((x) => x.id === r.dataset.reuse); if (p) openReuse(p); return; }
    if (c && c.dataset.cat) openCategory(c.dataset.cat, renderList);
  });
  renderList();
}
export async function showArchive(sub) {
  const view = sub === 'categories' ? 'categories' : 'puzzles';
  const same = AR.loaded && $('#ar-out') && AF.view === view;
  AF.view = view;
  if (same) return;
  // Coming from another tab: fetch again (drafts, votes and stats change); switching views reuses the data.
  if (!AR.loaded || !$('#ar-out')) { $('#ws-main').innerHTML = '<p class="muted">Loading the archive…</p>'; await loadBank(); }
  render();
}
export function resetArchive() { AR.loaded = false; Object.assign(AF, { view: 'puzzles', q: '', school: '', block: '', use: 'any', votes: '0', status: '', sort: 'used', shown: STEP }); }
