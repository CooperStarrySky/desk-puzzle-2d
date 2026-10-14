/* Puzzle workspace: one draft open in the Planner. The page is drawn once per
   draft; after any change (yours, or Refresh) update() redraws the parts that
   show data, keeping the preview frame and whatever field you are typing in.
   Other planner modules (slots, checks, preview, status) plug in with addPart(). */
import { S, $, esc, busy, toast, when, ago, av, person, roleIn, tipHtml, schFull } from './ws-core.js';
import { BLOCKS } from './ws-suggest.js';
import { fetchComments, commentsHtml, wireComments } from './ws-comments.js';
import { PL, DSTATUS, loadPlanner, draftById, eventsOf, patchDraft } from './ws-plan-data.js';
import { LIB, wireLib, renderLib, TOUCH, libSheet } from './ws-plan-lib.js';
import { renderDraftList } from './ws-plan-list.js';

/* parts: { mount(d), update(d) } — mount once per draw, update after every change. */
const parts = [];
export const ED = { id: null, cmSeq: 0 };
export function addPart(p) { parts.push(p); }
export const current = () => (ED.id ? draftById(ED.id) : null);
/* Published drafts are frozen; faculty read, comment and approve but never plan. */
export const readOnly = (d) => !!d && (d.status === 'published' || !['owner', 'lead', 'admin'].includes(roleIn(d.school)));

/* Who touched it last: the draft row, a slot change, or a history line. */
function lastTouch(d) {
  let best = { at: d.updated_at, who: d.updated_by };
  PL.slots.filter((s) => s.draft_id === d.id).forEach((s) => { if (s.placed_at > best.at) best = { at: s.placed_at, who: s.placed_by }; });
  const e = eventsOf(d.id)[0]; if (e && e.at > best.at) best = { at: e.at, who: e.actor_email };
  return best;
}
function metaHtml(d) {
  const t = lastTouch(d);
  return '<span class="st st-' + esc(d.status) + '">' + esc(DSTATUS[d.status]) + '</span> ' + av(t.who) +
    '<span>Last updated by <b>' + esc(t.who ? person(t.who).name : 'someone') + '</b>, <span title="' + esc(when(t.at)) + '">' + esc(ago(t.at)) + '</span></span>';
}
function ownerOptions(d) {
  // Owners come from the draft's own school (the database also checks they are a lead or admin there).
  const emails = Array.from(S.people.keys()).filter((e) => { const r = S.people.get(e); return !r.schools || r.schools.includes(d.school); });
  if (!emails.includes(d.owner_email)) emails.push(d.owner_email);
  return emails.map((e) => '<option value="' + esc(e) + '"' + (e === d.owner_email ? ' selected' : '') + '>' + esc(person(e).name) + '</option>').join('');
}
function shellHtml(d) {
  const ro = readOnly(d) ? ' disabled' : '';
  return '<p class="back"><a href="#/planner">← All drafts</a></p>' +
    '<div class="view-head"><div class="stack" style="--gap:4px"><p class="eyebrow">Draft' + (S.owner ? ' · ' + esc(schFull(d.school)) : '') + ' · owner <span id="ed-ownername">' + esc(person(d.owner_email).name) + '</span></p><h1 id="ed-h">' + esc(d.title) + '</h1>' +
    '<p class="ed-meta" id="ed-meta">' + metaHtml(d) + '</p></div><button class="btn" type="button" id="ed-refresh">Refresh</button></div>' +
    '<div id="ed-banner"></div>' +
    '<div class="ed-top panel"><label class="field"><span>Title</span><input class="input" id="ed-title" maxlength="120" value="' + esc(d.title) + '"' + ro + '></label>' +
    '<label class="field"><span>Owner</span><select class="input" id="ed-owner"' + ro + '>' + ownerOptions(d) + '</select></label>' +
    '<label class="field"><span>Block</span><select class="input" id="ed-block"' + ro + '><option value="">No block</option>' +
    BLOCKS.concat(d.block && !BLOCKS.includes(d.block) ? [d.block] : []).map((b) => '<option' + (b === d.block ? ' selected' : '') + '>' + esc(b) + '</option>').join('') + '</select></label>' +
    '<div class="field ed-flow"><span>Status</span><div class="flow" id="flow"></div></div></div>' +
    '<div class="appr-bar panel" id="appr" aria-label="Faculty approval" hidden></div>' +
    '<div class="editor" id="editor">' +
    '<section class="lib panel" id="lib" aria-labelledby="lib-h"><div class="row spread"><h2 id="lib-h">Category library</h2><button type="button" class="btn small primary lib-close" id="lib-close">Done</button></div>' +
    '<label class="sr" for="lib-q">Search the library</label><input class="input" id="lib-q" type="search" autocomplete="off" placeholder="Search names, clues, notes…">' +
    '<div id="lib-tools" class="stack" style="--gap:6px"></div>' +
    (readOnly(d) ? '' : TOUCH ? tipHtml('plan-tap', 'Tap “Add to draft…” on a category, then choose a tier.')
      : tipHtml('plan-drag', 'Drag a card onto a slot by its ⠿ handle, or use “Add to draft…”. Drag a slot back here to take it out. Drag the library’s right edge to widen it.')) +
    '<div class="lib-list" id="lib-list"></div>' +
    '<div class="lib-handle" id="lib-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="lib" aria-label="Resize the suggestion library (Left and Right arrows; double-click resets)" aria-valuemin="220" aria-valuemax="640"></div></section>' +
    '<section class="mid-a stack" aria-labelledby="slots-h"><h2 id="slots-h" class="sr">Tier slots</h2>' +
    (readOnly(d) ? '' : '<button type="button" class="btn primary add-cat" id="add-cat" aria-controls="lib" aria-expanded="false">＋ Add category</button>') + '<div class="slots" id="slots"></div><div class="panel stack" id="ck-panel" hidden></div></section>' +
    '<section class="pv-col panel stack" id="pv-col" aria-labelledby="pv-h" hidden></section>' +
    '<section class="mid-b panel stack" aria-labelledby="notes-h"><h3 id="notes-h">Draft notes</h3><label class="sr" for="ed-notes">Draft notes</label>' +
    '<textarea class="input" id="ed-notes" maxlength="4000" placeholder="Ideas, open questions, who is finding which image…"' + ro + '>' + esc(d.notes || '') + '</textarea>' +
    '<div id="ed-cm"><p class="muted">Loading comments…</p></div></section></div>';
}

async function saveField(d, patch, msg) {
  if (await patchDraft(d.id, patch)) { toast(msg); await refresh(); return true; }
  return false;
}
function wireShell(d) {
  const title = $('#ed-title');
  title.addEventListener('change', async () => {
    const v = title.value.trim().replace(/\s+/g, ' ');
    if (!v) { toast('A draft needs a title.'); title.value = current().title; return; }
    if (v !== current().title) await saveField(d, { title: v }, 'Renamed to ' + v);
  });
  $('#ed-owner').addEventListener('change', (e) => saveField(d, { owner_email: e.target.value }, 'Owner is now ' + person(e.target.value).name));
  $('#ed-block').addEventListener('change', (e) => saveField(d, { block: e.target.value || null }, e.target.value ? 'Block set to ' + e.target.value : 'Block cleared'));
  $('#ed-notes').addEventListener('change', (e) => saveField(d, { notes: e.target.value.trim() || null }, 'Notes saved'));
  const add = $('#add-cat'); if (add) add.addEventListener('click', () => libSheet(true));
  $('#lib-close').addEventListener('click', () => libSheet(false));
  $('#lib').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#lib').classList.contains('sheet-open') && !$('#modal-root .scrim')) { e.stopPropagation(); libSheet(false); } });
  $('#ed-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => { await refresh(); if (!PL.err) toast('Up to date'); }));
}
/* Draft comments use the same comment list as suggestions (target_type 'draft'). */
async function loadComments(d) {
  const seq = ++ED.cmSeq, box = $('#ed-cm');
  try {
    const list = await fetchComments(d.id, 'draft');
    if (seq !== ED.cmSeq || !box || !box.isConnected) return;
    box.innerHTML = commentsHtml({ id: d.id }, list).replace('<h4 class="sd-h">', '<h3 class="sd-h">').replace('</h4>', '</h3>');
    wireComments(box, { id: d.id }, list, async (sel) => { await refresh(); const el = sel && $(sel, $('#ed-cm')); if (el) el.focus(); }, 'draft');
  } catch (e) { if (box && box.isConnected) box.innerHTML = '<p class="err-box">Could not load comments. Press Refresh.</p>'; }
}

/* Redraws everything that shows data (after a change or Refresh). */
export async function refresh() {
  await loadPlanner();
  const d = current();
  if (!d) { if (ED.id && !PL.err) { toast('That draft is gone (someone deleted it).', 5000); location.hash = '#/planner'; } return; }
  update(d);
  await loadComments(d);
}
export function update(d) {
  if (!$('#editor')) return;
  LIB.draft = d; LIB.canEdit = !readOnly(d);
  $('#ed-meta').innerHTML = metaHtml(d);
  $('#ed-ownername').textContent = person(d.owner_email).name;
  const fields = { 'ed-title': d.title, 'ed-notes': d.notes || '' };
  Object.keys(fields).forEach((id) => { const el = $('#' + id); if (el && document.activeElement !== el) el.value = fields[id]; });
  $('#ed-h').textContent = d.title;
  renderLib();
  parts.forEach((p) => p.update && p.update(d));
}
function renderEditor(d) {
  ED.id = d.id; LIB.draft = d; LIB.canEdit = !readOnly(d); libSheet(false);
  $('#ws-main').innerHTML = shellHtml(d);
  document.title = d.title + ' · Planner · Puzzle workspace';
  wireShell(d); wireLib();
  parts.forEach((p) => p.mount && p.mount(d));
  update(d);
  loadComments(d);
}
/* Called by ws-main: #/planner (list) or #/planner/<id> (one draft). */
export async function showPlanner(id) {
  const fresh = !PL.loaded || id !== ED.id || !$('#editor');
  if (fresh) { $('#ws-main').innerHTML = '<p class="muted">Loading the planner…</p>'; await loadPlanner(); }
  if (!id) { ED.id = null; LIB.draft = null; renderDraftList(); return; }
  const d = draftById(id);
  if (!d) {
    if (PL.err) { renderDraftList(); return; }
    toast('That draft isn’t there any more.', 4000); history.replaceState(null, '', location.pathname + location.search + '#/planner'); ED.id = null; renderDraftList(); return;
  }
  if (fresh || ED.id !== id) renderEditor(d); else update(d);
}
export function resetPlanner() { ED.id = null; LIB.draft = null; PL.loaded = false; }
