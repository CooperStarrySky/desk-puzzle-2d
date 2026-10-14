/* Puzzle workspace: one draft open in the Planner. The page is drawn once per
   draft; after any change (yours, or Refresh) update() redraws the parts that
   show data, keeping the preview frame and whatever field you are typing in.
   Other planner modules (slots, checks, preview, status) plug in with addPart().
   Layout A: Database rail | tier slots | Live preview rail (ws-plan-rails.js);
   Checks and Faculty approval are small pills in the header. */
import { S, $, esc, busy, toast, when, ago, av, person, roleIn, tipHtml, schFull } from './ws-core.js';
import { BLOCKS } from './ws-suggest.js';
import { fetchComments, commentsHtml, wireComments } from './ws-comments.js';
import { PL, DSTATUS, loadPlanner, draftById, eventsOf, patchDraft } from './ws-plan-data.js';
import { LIB, wireLib, renderLib, TOUCH, libHtml, resetLib } from './ws-plan-lib.js';
import { mountRails, closeSheets } from './ws-plan-rails.js';
import { renderDraftList } from './ws-plan-list.js';
import { presenceChanged, typingIn, dirtyIn, whenIdle, keepFocus, flash } from './ws-live.js';
import { editing } from './ws-plan-adapt.js';

/* parts: { mount(d), update(d) } — mount once per draw, update after every change. */
const parts = [];
export const ED = { id: null, cmSeq: 0, live: false };
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
const strip = (n, ic, label, arrow, ctl) => '<button type="button" class="strip" id="' + n + '-strip" aria-controls="' + ctl + '" aria-expanded="false" title="Open the ' + label + '">' +
  '<span class="ic" aria-hidden="true">' + ic + '</span><span class="vl">' + label + '</span>' + (n === 'db' ? '<span class="cnt" id="db-cnt"></span>' : '') + '<span class="ar" aria-hidden="true">' + arrow + '</span></button>';
const handle = (n, ctl, label) => '<div class="rail-handle" id="' + n + '-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="' + ctl + '" title="Drag to resize · double-click to reset" ' +
  'aria-label="' + label + ' width (Left and Right arrows, Shift for bigger steps; double-click resets)"></div>';
function shellHtml(d) {
  const ro = readOnly(d) ? ' disabled' : '';
  const tip = readOnly(d) ? '' : TOUCH ? tipHtml('plan-tap', 'Tap 👁 View on a category (or tap its name in Compact), then “Add to draft…” and choose a tier.')
    : tipHtml('plan-drag', 'Drag a card onto a tier by its ⠿ handle, or open 👁 View and use “Add to draft…”. Hover a card to see inside it. Drag a tier back here to take it out.');
  return '<p class="back"><a href="#/planner">← All drafts</a></p>' +
    '<div class="view-head ed-head"><div class="stack" style="--gap:4px"><p class="eyebrow">Draft' + (S.owner ? ' · ' + esc(schFull(d.school)) : '') + ' · owner <span id="ed-ownername">' + esc(person(d.owner_email).name) + '</span></p><h1 id="ed-h">' + esc(d.title) + '</h1>' +
    '<p class="ed-meta" id="ed-meta">' + metaHtml(d) + '</p><p class="ed-pres" id="ed-pres" aria-live="polite" hidden></p></div>' +
    '<div class="ed-pills" id="ed-pills"><div class="pw" id="ck-wrap"><button type="button" class="pill" id="ck-pill" aria-expanded="false" aria-controls="ck-panel">Checks</button>' +
    '<div class="pop ck-pop panel" id="ck-panel" role="dialog" aria-label="Checks" tabindex="-1" hidden></div></div>' +
    '<div class="pw" id="appr-wrap" hidden><button type="button" class="pill appr" id="appr-pill" aria-expanded="false" aria-controls="appr">Faculty approval</button>' +
    '<div class="pop appr-pop panel" id="appr" role="dialog" aria-label="Faculty approval" tabindex="-1" hidden></div></div>' +
    '<button class="btn" type="button" id="ed-refresh">Refresh</button></div></div>' +
    '<div id="ed-banner"></div>' +
    '<div class="ed-top panel"><label class="field"><span>Title</span><input class="input" id="ed-title" maxlength="120" value="' + esc(d.title) + '"' + ro + '></label>' +
    '<label class="field"><span>Owner</span><select class="input" id="ed-owner"' + ro + '>' + ownerOptions(d) + '</select></label>' +
    '<label class="field"><span>Block</span><select class="input" id="ed-block"' + ro + '><option value="">No block</option>' +
    BLOCKS.concat(d.block && !BLOCKS.includes(d.block) ? [d.block] : []).map((b) => '<option' + (b === d.block ? ' selected' : '') + '>' + esc(b) + '</option>').join('') + '</select></label>' +
    '<div class="field ed-flow"><span>Status</span><div class="flow" id="flow"></div></div></div>' +
    '<div class="editor la" id="editor" data-db="closed" data-pv="closed">' +
    '<div class="rail rail-l" id="rail-db">' + strip('db', '🔍', 'Database', '»', 'lib') +
    '<section class="lib panel" id="lib" aria-labelledby="lib-h" tabindex="-1">' + libHtml(tip) + '</section>' + handle('db', 'lib', 'Database') + '</div>' +
    '<div class="center"><section class="mid-a stack" aria-labelledby="slots-h"><h2 id="slots-h" class="sr">Tier slots</h2><div class="slots" id="slots"></div></section>' +
    '<section class="mid-b panel stack" aria-labelledby="notes-h"><h3 id="notes-h">Draft notes</h3><label class="sr" for="ed-notes">Draft notes</label>' +
    '<textarea class="input" id="ed-notes" maxlength="4000" placeholder="Ideas, open questions, who is finding which image…"' + ro + '>' + esc(d.notes || '') + '</textarea>' +
    '<div id="ed-cm"><p class="muted">Loading comments…</p></div></section></div>' +
    '<div class="rail rail-r" id="rail-pv">' + handle('pv', 'pv-col', 'Live preview') + strip('pv', '▦', 'Live preview', '«', 'pv-col') +
    '<section class="pv-col panel stack" id="pv-col" aria-labelledby="pv-h" tabindex="-1" hidden></section></div></div>' +
    '<nav class="pbar" id="pbar" aria-label="Planner panels"><button type="button" class="btn" data-sheet="db" id="pb-db" aria-controls="lib" aria-expanded="false">🔍 Database</button>' +
    '<button type="button" class="btn" data-sheet="pv" id="pb-pv" aria-controls="pv-col" aria-expanded="false">▦ Preview</button>' +
    '<button type="button" class="btn" data-sheet="ck" id="pb-ck" aria-controls="ck-panel" aria-expanded="false">Checks</button></nav>';
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
  ED.id = d.id; LIB.draft = d; LIB.canEdit = !readOnly(d); closeSheets();
  $('#ws-main').innerHTML = shellHtml(d);
  document.title = d.title + ' · Planner · Puzzle workspace';
  wireShell(d); wireLib();
  parts.forEach((p) => p.mount && p.mount(d));
  mountRails(!PL.slots.some((s) => s.draft_id === d.id));
  update(d);
  loadComments(d);
  presenceChanged();
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
/* ===== Live updates (notes routed by ws-main) =====
   Same as Refresh, but: a slot you are editing keeps your typing (ws-plan-slots
   leaves it in place and shows "X changed this slot" if theirs changed), and
   draft comments wait while you are writing one. */
const cmBusy = () => typingIn($('#ed-cm')) || dirtyIn($('#ed-cm'));
export async function livePlanner(notes) {
  if (!$('#editor')) {
    if (ED.id || !$('#draft-list, #ws-main .empty')) return;
    const busyList = () => typingIn($('#ws-main'));
    if (busyList()) { whenIdle('plist', busyList, () => livePlanner([])); return; }
    await loadPlanner();
    await keepFocus(() => { if (!ED.id && !$('#editor')) renderDraftList(); });
    notes.forEach((n) => (n.t === 'drafts' ? n.items || [] : []).forEach((i) => flash(document.querySelector('[data-did="' + CSS.escape(i.id) + '"]'), n.by)));
    return;
  }
  const id = ED.id;
  ED.live = true;
  try {
    await keepFocus(async () => {
      await loadPlanner();
      const d = current();
      if (!d || ED.id !== id) {
        if (!d && ED.id === id && !PL.err) { const by = (notes.find((n) => n.t === 'drafts' && n.op === 'delete') || {}).by;
          toast((by ? person(by).name + ' deleted this draft.' : 'That draft is gone (someone deleted it).'), 6000); location.hash = '#/planner'; }
        return;
      }
      update(d);
    });
  } finally { ED.live = false; }
  const d = current(); if (!d || !$('#editor')) return;
  const mine = (n) => (n.items || []).some((i) => i.d === d.id || i.id === d.id || i.target === d.id);
  if (notes.some((n) => n.t === '*' || (n.t === 'comments' && mine(n)))) {
    if (cmBusy()) whenIdle('dcm', cmBusy, () => { const x = current(); if (x) loadComments(x); });
    else await loadComments(d);
  }
  notes.forEach((n) => {
    if (n.t === 'draft_slots') (n.items || []).filter((i) => i.d === d.id).forEach((i) => {
      if (editing(d, i.t)) SLOT_HOOKS.conflict(i.t, n.by);
      else flash(document.querySelector('#slots .slot[data-t="' + Number(i.t) + '"]'), n.by, 'Changed');
    });
    if (n.t === 'drafts' && mine(n)) flash($('.ed-head'), n.by);
    if (n.t === 'comments' && mine(n)) flash($('#ed-cm'), n.by, 'New comment');
  });
  presenceChanged();
}
/* ws-plan-slots fills this in (it owns the slot editor's DOM). */
export const SLOT_HOOKS = { conflict: () => {} };
export function resetPlanner() { ED.id = null; LIB.draft = null; PL.loaded = false; resetLib(); }
