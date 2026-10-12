/* Puzzle workspace: a draft's four tier slots. Real drag and drop (library
   card -> slot, slot -> slot swaps through the database, slot -> library
   removes) plus buttons for everyone without a mouse: "Add to slot…",
   "Move to slot…", "Remove", "Pick a category…". "Details" opens the
   suggestion in a dialog, so the planner never leaves the page. */
import { $, $$, esc, busy, toast, openModal, fillImages, person, TIER_WORDS, STATUS_WORDS } from './ws-core.js';
import { contentHtml } from './ws-clues.js';
import { slotsOf, itemByKey, tierOfKey, placeItem, moveSlot, removeSlot, votesFor } from './ws-plan-data.js';
import { LIB, DND, alsoFlags, libItems } from './ws-plan-lib.js';
import { addPart, refresh, current, readOnly } from './ws-plan-editor.js';

const STAIN = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3', 4: 'Tier 4' };
const byLine = (it) => (it.credit ? 'Category by ' + it.credit.name + (it.credit.line ? ', ' + it.credit.line : '') : 'Category by an anonymous player');

function slotHtml(d, t, s) {
  const ro = readOnly(d), it = s && s.item;
  const band = '<div class="slot-band"><b>' + TIER_WORDS[t] + '</b><span>' + STAIN[t] + '</span></div>';
  if (!it) {
    return '<div class="slot t' + t + '" data-t="' + t + '" role="group" aria-label="' + TIER_WORDS[t] + ' slot, empty">' + band +
      '<div class="slot-body slot-empty"><span>Drop a category here</span>' + (ro ? '' : '<button type="button" class="btn small" data-fill="' + t + '">Pick a category…</button>') + '</div></div>';
  }
  const flags = it.key ? alsoFlags(it.key) : '';
  return '<div class="slot t' + t + ' filled" data-t="' + t + '" role="group" aria-label="' + TIER_WORDS[t] + ' slot: ' + esc(it.name) + '">' + band +
    '<div class="slot-body"' + (ro ? '' : ' draggable="true" data-from="' + t + '"') + '><h4>' + esc(it.name) + '</h4>' +
    (it.kind === 'group' ? '<p class="faint slot-from"><span class="kind-tag puzzle">Group</span> from “' + esc(it.parent) + '”</p>' : '') +
    (flags ? '<p class="row" style="--gap:6px">' + flags + '</p>' : '') +
    '<p class="muted slot-ex">' + (it.explanation.trim() ? esc(it.explanation) : '<i>No explanation yet</i>') + '</p>' +
    '<p class="faint slot-by">' + esc(byLine(it)) + (it.tier && it.tier !== t ? ' · suggested as ' + esc(TIER_WORDS[it.tier]) : '') + '</p>' +
    (ro ? '' : '<div class="row slot-btns"><button type="button" class="btn small" data-move="' + t + '">Move to slot…</button>' +
      '<button type="button" class="btn small danger" data-rm="' + t + '">Remove</button>' +
      (it.sid ? '<button type="button" class="btn small ghost" data-det="' + esc(it.key) + '">Details</button>' : '') + '</div>') + '</div></div>';
}
function render(d) {
  const el = $('#slots'); if (!el) return;
  const sl = slotsOf(d.id);
  el.innerHTML = [1, 2, 3, 4].map((t) => slotHtml(d, t, sl[t])).join('');
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
  await after(await placeItem(d.id, t, key), msg, '[data-move="' + t + '"]');
}
async function swap(a, b) {
  const d = current(); if (!d || a === b) return;
  const had = slotsOf(d.id)[b];
  await after(await moveSlot(d.id, a, b), had ? 'Swapped ' + TIER_WORDS[a] + ' and ' + TIER_WORDS[b] : 'Moved to ' + TIER_WORDS[b], '[data-move="' + b + '"]');
}
export async function remove(t) {
  const d = current(); if (!d) return;
  const s = slotsOf(d.id)[t], wasReady = d.status === 'ready' || d.status === 'scheduled';
  await after(await removeSlot(d.id, t), 'Took “' + (s ? s.item.name : 'it') + '” out of ' + TIER_WORDS[t] + (wasReady ? '. The draft is back to Planning.' : ''), '[data-fill="' + t + '"]');
}

/* "Add to slot…" / "Move to slot…": which of the four tiers. */
function slotPicker(key) {
  const d = current(); if (!d || readOnly(d)) return;
  const it = itemByKey(key), sl = slotsOf(d.id), from = tierOfKey(d.id, key);
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">' + (from ? 'Move' : 'Put') + ' “' + esc(it ? it.name : 'this') + '” in which slot?</h2><ul class="pick-list">' +
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
    (d && !readOnly(d) ? '<button class="btn primary" type="button" id="det-add">' + (t ? 'Move to slot…' : 'Add to slot…') + '</button>' : '') + '</div></div>',
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
    const b = e.target.closest('button'); if (!b || readOnly(current())) { if (b && b.dataset.det) detailsDialog(b.dataset.det); return; }
    if (b.dataset.move) { const s = slotsOf(d.id)[Number(b.dataset.move)]; if (s) slotPicker(s.item.key); }
    else if (b.dataset.rm) busy(b, 'Removing…', () => remove(Number(b.dataset.rm)));
    else if (b.dataset.fill) fillPicker(Number(b.dataset.fill));
    else if (b.dataset.det) detailsDialog(b.dataset.det);
  });
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
addPart({ mount, update: render });
