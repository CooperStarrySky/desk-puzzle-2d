/* Puzzle workspace: a draft's four tier slots. Each filled slot has one main
   action, "✎ Edit for this puzzle" (an adapted copy, ws-plan-adapt.js), and a
   ⋯ menu: Move…, Details, Remove from draft (with Undo). Desktop: drag cards
   by their ⠿ handle onto a slot, slot onto slot (swap), slot back onto the
   library (remove). Touch screens: tap "Add to draft…" and choose a tier. */
import { $, $$, esc, busy, toast, toastAct, openModal, fillImages, person, menuHtml, onMenu, TIER_WORDS, STATUS_WORDS } from './ws-core.js';
import { contentHtml } from './ws-clues.js';
import { slotsOf, itemByKey, tierOfKey, placeItem, moveSlot, removeSlot, restoreSlot, votesFor } from './ws-plan-data.js';
import { LIB, DND, alsoFlags, libItems, TOUCH, libSheet } from './ws-plan-lib.js';
import { addPart, refresh, current, readOnly, ED, SLOT_HOOKS } from './ws-plan-editor.js';
import { editing, editorHtml, badgeHtml, startEdit, stopEdit } from './ws-plan-adapt.js';
import { wireAdapt } from './ws-plan-adapt-pick.js';

const STAIN = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3', 4: 'Tier 4' };
const byLine = (it) => (it.credit && it.credit.name ? 'Category by ' + it.credit.name + (it.credit.line ? ', ' + it.credit.line : '') : 'Category by an anonymous player');

function slotHtml(d, t, s) {
  const ro = readOnly(d), it = s && s.item;
  const band = '<div class="slot-band"><div class="sb-in"><b>' + TIER_WORDS[t] + '</b><span>' + STAIN[t] + '</span></div></div>';
  if (!it) {
    return '<div class="slot t' + t + '" data-t="' + t + '" role="group" aria-label="' + TIER_WORDS[t] + ' slot, empty">' + band +
      '<div class="slot-body slot-empty"><span>' + (TOUCH || ro ? 'Empty' : 'Drop a category here') + '</span>' + (ro ? '' : '<button type="button" class="btn small" data-fill="' + t + '">Add category…</button>') + '</div></div>';
  }
  if (!ro && editing(d, t)) return '<div class="slot t' + t + ' filled editing" data-t="' + t + '" role="group" aria-label="' + TIER_WORDS[t] + ' slot: editing ' + esc(it.name) + '">' + band + editorHtml(d, t, it) + '</div>';
  const flags = it.key ? alsoFlags(it.key) : '', drag = !ro && !TOUCH;
  const menu = menuHtml(TIER_WORDS[t] + ' slot', [['slotMove', 'Move…', { arg: t }], ['slotDet', 'Details', { arg: it.key, off: it.sid ? null : 'Made by hand, not in the Category database' }],
    ['slotRm', 'Remove from draft', { arg: t, danger: true }]]);
  return '<div class="slot t' + t + ' filled" data-t="' + t + '" role="group" aria-label="' + TIER_WORDS[t] + ' slot: ' + esc(it.name) + '">' + band +
    '<div class="slot-body"' + (drag ? ' draggable="true" data-from="' + t + '"' : '') + '><h4>' + (drag ? '<span class="grip" title="Drag to another slot" aria-hidden="true">⠿</span>' : '') + esc(it.name) + '</h4>' +
    (it.adapted ? badgeHtml(d, t, it, ro) : '') +
    (it.kind === 'group' ? '<p class="faint slot-from"><span class="kind-tag puzzle">Group</span> from “' + esc(it.parent) + '”</p>' : '') +
    (flags ? '<p class="row" style="--gap:6px">' + flags + '</p>' : '') +
    '<p class="muted slot-ex">' + (it.explanation.trim() ? esc(it.explanation) : '<i>No explanation yet</i>') + '</p>' +
    '<p class="faint slot-by">' + esc(byLine(it)) + (it.tier && it.tier !== t ? ' · suggested as ' + esc(TIER_WORDS[it.tier]) : '') + '</p>' +
    (ro ? (it.sid ? '<div class="row slot-btns"><button type="button" class="btn small ghost" data-det="' + esc(it.key) + '">Details</button></div>' : '')
      : '<div class="row slot-btns">' + (it.sid ? '<button type="button" class="btn small primary" data-adapt="' + t + '">✎ Edit for this puzzle</button>' : '') + menu + '</div>') + '</div></div>';
}
function render(d) {
  const el = $('#slots'); if (!el) return;
  const sl = slotsOf(d.id);
  // A live update never redraws the slot you are editing (your typing stays).
  const keep = ED.live ? $('.slot.editing', el) : null;
  if (keep && editing(d, Number(keep.dataset.t))) {
    [1, 2, 3, 4].forEach((t) => {
      const cur = $('.slot[data-t="' + t + '"]', el); if (cur === keep) return;
      const tmp = document.createElement('div'); tmp.innerHTML = slotHtml(d, t, sl[t]);
      if (cur) cur.replaceWith(tmp.firstElementChild); else el.appendChild(tmp.firstElementChild);
    });
  } else el.innerHTML = [1, 2, 3, 4].map((t) => slotHtml(d, t, sl[t])).join('');
  fillImages(el);
}
/* Someone else changed the slot I'm editing: say so, and let me choose. */
function showConflict(t, by) {
  const ed = $('#slots .slot.editing[data-t="' + Number(t) + '"] .adapt-ed'); if (!ed) return;
  let n = $('.live-conflict', ed);
  if (!n) { n = document.createElement('div'); n.className = 'live-conflict'; n.setAttribute('role', 'alert'); ed.prepend(n); }
  n.innerHTML = '<p><b>' + esc(person(by).name) + '</b> changed this slot while you were editing it.</p>' +
    '<div class="row" style="--gap:6px"><button type="button" class="btn small primary" data-lc="reload" data-lct="' + Number(t) + '">Reload slot</button>' +
    '<button type="button" class="btn small" data-lc="keep">Keep mine</button></div>';
}
SLOT_HOOKS.conflict = showConflict;
function conflictChoice(b) {
  const d = current(); if (!d) return;
  if (b.dataset.lc === 'keep') {
    const n = b.closest('.live-conflict'), ed = n && n.closest('.adapt-ed'); if (n) n.remove();
    toast('Keeping your version. Saving will replace theirs.', 4000);
    const f = ed && $('input, textarea', ed); if (f) f.focus();
    return;
  }
  const t = Number(b.dataset.lct);
  stopEdit();
  const s = slotsOf(d.id)[t], again = !!(s && s.item && s.item.sid && !readOnly(d)) && startEdit(d, t);
  render(d);
  toast(again ? 'Reloaded ' + TIER_WORDS[t] + ' with the latest version.' : TIER_WORDS[t] + ' changed; your edit was closed.', 4500);
  const f = $('.slot[data-t="' + t + '"] ' + (again ? '.adapt-ed input' : '.mnu-btn, button')); if (f) f.focus();
}
/* After a save: reload, redraw, and put focus somewhere sensible. */
async function after(ok, msg, focusSel) {
  if (!ok) return;
  if (msg) toast(msg);
  await refresh();
  const f = focusSel && $(focusSel); if (f) f.focus();
}
export async function place(key, t) {
  const d = current(); if (!d) return;
  const it = itemByKey(key), from = tierOfKey(d.id, key), had = slotsOf(d.id)[t];
  const msg = from ? (had ? 'Swapped ' + TIER_WORDS[from] + ' and ' + TIER_WORDS[t] : 'Moved to ' + TIER_WORDS[t])
    : (had ? 'Replaced “' + had.item.name + '” with “' + (it ? it.name : 'it') + '” in ' : 'Placed “' + (it ? it.name : 'it') + '” in ') + TIER_WORDS[t];
  if (await placeItem(d.id, t, key)) libSheet(false);
  await after(true, msg, '.slot[data-t="' + t + '"] .mnu-btn');
}
async function swap(a, b) {
  const d = current(); if (!d || a === b) return;
  const had = slotsOf(d.id)[b];
  await after(await moveSlot(d.id, a, b), had ? 'Swapped ' + TIER_WORDS[a] + ' and ' + TIER_WORDS[b] : 'Moved to ' + TIER_WORDS[b], '.slot[data-t="' + b + '"] .mnu-btn');
}
export async function remove(t) {
  const d = current(); if (!d) return;
  const s = slotsOf(d.id)[t], wasReady = d.status === 'ready' || d.status === 'scheduled';
  if (!s || !(await removeSlot(d.id, t))) return;
  const row = Object.assign({}, s.row), name = s.item.name, did = d.id;
  await after(true, '', '[data-fill="' + t + '"]');
  toastAct('Removed “' + name + '” from ' + TIER_WORDS[t] + (wasReady ? '. The draft is back to Planning.' : ''), [['Undo', async () => {
    if (!(await restoreSlot(did, row))) return;
    toast('Put back in ' + TIER_WORDS[t]); const cur = current(); if (cur && cur.id === did) await after(true, '', '.slot[data-t="' + t + '"] .mnu-btn');
  }]]);
}

/* "Add to slot…" / "Move to slot…": which of the four tiers. */
function slotPicker(key) {
  const d = current(); if (!d || readOnly(d)) return;
  const it = itemByKey(key), sl = slotsOf(d.id), from = tierOfKey(d.id, key);
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">' + (from ? 'Move' : 'Add') + ' “' + esc(it ? it.name : 'this') + '” to which tier?</h2><ul class="pick-list">' +
    [1, 2, 3, 4].map((t) => {
      const s = sl[t], note = t === from ? 'here now' : !s ? 'empty' : from ? 'swaps with “' + s.item.name + '”' : 'replaces “' + s.item.name + '”';
      return '<li><button type="button" class="btn" data-pick="' + t + '"' + (t === from ? ' disabled' : '') + '><span class="row" style="--gap:8px"><span class="tierdot t' + t + '"></span>' + TIER_WORDS[t] + '</span><span class="muted">' + esc(note) + '</span></button></li>';
    }).join('') + '</ul><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button></div></div>',
  (m, close) => { $$('[data-pick]', m).forEach((b) => b.addEventListener('click', () => busy(b, 'Saving…', async () => { close(); await place(key, Number(b.dataset.pick)); }))); });
}
/* "Pick a category…" on an empty slot: what the library currently shows, minus this draft's. */
function fillPicker(t) {
  const d = current(); if (!d) return;
  const opts = libItems().filter((it) => !tierOfKey(d.id, it.key)).slice(0, 60);
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Fill the ' + TIER_WORDS[t] + ' slot</h2><p class="muted">From the library as it’s filtered now (' + opts.length + (opts.length === 60 ? '+' : '') + ').</p>' +
    (opts.length ? '<ul class="pick-list">' + opts.map((it) => '<li><button type="button" class="btn" data-key="' + esc(it.key) + '"><span class="row" style="--gap:8px"><span class="tierdot t' + (it.tier || 0) + '"></span>' + esc(it.name) + '</span>' +
      '<span class="muted">' + esc(it.kind === 'group' ? 'group of ' + it.parent : (TIER_WORDS[it.tier] || '')) + '</span></button></li>').join('') + '</ul>'
      : '<p class="empty">Nothing to pick. Clear some library filters first.</p>') +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button></div></div>',
  (m, close) => { $$('[data-key]', m).forEach((b) => b.addEventListener('click', async () => { close(); await place(b.dataset.key, t); })); });
}
/* The suggestion's full content, in place. */
export function detailsDialog(key) {
  const it = itemByKey(key); if (!it) { toast('That suggestion isn’t in the inbox any more.'); return; }
  const d = current(), r = it.sub, vs = votesFor(it), t = d ? tierOfKey(d.id, key) : 0;
  const pseudo = it.kind === 'group' ? { kind: 'category', payload: r.payload.groups[it.gi] } : r;
  openModal('<div class="stack det-dlg" style="--gap:14px"><div class="row spread"><h2 id="modal-h">' + esc(it.name) + '</h2><span class="st st-' + esc(it.status) + '">' + esc(STATUS_WORDS[it.status] || it.status) + '</span></div>' +
    '<p class="muted">' + (it.kind === 'group' ? 'Group ' + (it.gi + 1) + ' of the full puzzle “' + esc(it.parent) + '” · ' : '') + esc(byLine(it)) +
    ' · suggested ' + esc(TIER_WORDS[it.tier] || '?') + ' · 👍 ' + vs.length + (vs.length ? ' (' + esc(vs.map((e) => person(e).name).join(', ')) + ')' : '') + (it.tags.length ? ' · ' + esc(it.tags.join(', ')) : '') + '</p>' +
    (t ? '<p class="badge in-draft">In this draft · ' + TIER_WORDS[t] + '</p>' : '') + (d ? alsoFlags(key) : '') + contentHtml(pseudo) +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Close</button>' +
    (d && !readOnly(d) ? '<button class="btn primary" type="button" id="det-add">' + (t ? 'Move…' : 'Add to draft…') + '</button>' : '') + '</div></div>',
  (m, close) => {
    m.classList.add('wide'); fillImages(m);
    const b = $('#det-add', m); if (b) b.addEventListener('click', () => { close(); slotPicker(key); });
  });
}
function readDrag(e) { let v = ''; try { v = e.dataTransfer.getData('text/plain'); } catch (x) { /* */ } return v || DND.v || ''; }
function mount(d) {
  const el = $('#slots'); if (!el) return;
  LIB.onAdd = (key) => slotPicker(key);
  LIB.onDetails = (key) => detailsDialog(key);
  LIB.onRemove = (t) => remove(t);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.lc) { conflictChoice(b); return; }
    if (b.dataset.det) { detailsDialog(b.dataset.det); return; }
    if (readOnly(current())) return;
    if (b.dataset.fill) fillPicker(Number(b.dataset.fill));
  });
  wireAdapt(el, () => { const c = current(); if (c) render(c); });
  el.addEventListener('dragstart', (e) => {
    const b = e.target.closest && e.target.closest('[data-from]'); if (!b) return;
    DND.v = 'slot:' + b.dataset.from; b.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', DND.v); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* */ }
  });
  el.addEventListener('dragend', (e) => { const b = e.target.closest && e.target.closest('[data-from]'); if (b) b.classList.remove('dragging'); DND.v = ''; });
  el.addEventListener('dragover', (e) => { const sl = e.target.closest('.slot'); if (!sl || readOnly(current())) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (x) { /* */ } sl.classList.add('over'); });
  el.addEventListener('dragleave', (e) => { const sl = e.target.closest('.slot'); if (sl && !sl.contains(e.relatedTarget)) sl.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    const sl = e.target.closest('.slot'); if (!sl) return;
    e.preventDefault(); sl.classList.remove('over');
    const v = readDrag(e), t = Number(sl.dataset.t); DND.v = '';
    if (v.startsWith('lib:')) place(v.slice(4), t); else if (v.startsWith('slot:')) swap(Number(v.slice(5)), t);
  });
}
onMenu('slotMove', (t) => { const d = current(), s = d && slotsOf(d.id)[Number(t)]; if (s && !readOnly(d)) slotPicker(s.item.key); });
onMenu('slotDet', (key) => detailsDialog(key));
onMenu('slotRm', (t) => { const d = current(); if (d && !readOnly(d)) remove(Number(t)); });
addPart({ mount, update: render });
