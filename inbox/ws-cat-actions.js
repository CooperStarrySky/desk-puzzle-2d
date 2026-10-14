/* Puzzle workspace: Category database actions. The ⋯ menu on each category
   (Move to Trash, Fix the original…, Hide for my school), Trash in one tap
   with Undo and Add reason, Restore, "Add to draft…" (the Planner's draft and
   slot picker; drafts come back already filtered to your school by the row
   rules), and keyboard shortcuts: / j k v a ? (off while you type). */
import { S, $, $$, esc, busy, toast, toastAct, plainError, openModal, modalOpen, menuHtml, onMenu, isCurator, canPlan, canFix,
  schName, isPuzzle } from './ws-core.js';
import { V, rowById, reload, redraw, renderList, openCard, closeCard, hashFor } from './ws-suggest.js';
import { toggleVote, DS } from './ws-detail.js';
import { PL, loadPlanner, itemByKey } from './ws-plan-data.js';
import { openUse } from './ws-arch-dialogs.js';

const PLAN_OFF = 'Faculty can comment and approve drafts, but can’t add to them';
export function catMenu(r) {
  const fixOff = isPuzzle(r) ? 'Old full-puzzle suggestions can’t be edited here.'
    : canFix(r) ? null : 'Only ' + schName(r.school) + ' leads and admins and the site owner can fix the original. Edit a copy in a draft instead.';
  return menuHtml(r.group_name, [
    ['trash', 'Move to Trash', { arg: r.id, danger: 1, off: isCurator() ? null : 'Faculty can’t move categories to Trash' }],
    ['fix', 'Fix the original…', { arg: r.id, off: fixOff }],
    ['hide', 'Hide for my school', { arg: r.id, off: 'Comes with multi-school' }]]);
}

async function after(focusSel) {
  await reload(); redraw();
  if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
}
export async function trashNow(r) {
  if (!isCurator()) { toast('Faculty can comment and approve, but can’t move categories to Trash', 4500); return; }
  const { error } = await S.sb.rpc('trash_submission', { p_id: r.id });
  if (error) { toast('Could not move it to Trash: ' + plainError(error), 5000); return; }
  if (V.open === r.id) { V.open = null; history.replaceState(null, '', location.pathname + location.search + hashFor(null)); }
  await after('#sug-q');
  toastAct('Moved “' + r.group_name + '” to Trash', [['Undo', () => restore(r, true)], ['Add reason', () => reasonDialog(r.id)]]);
}
export async function restore(r, undo) {
  const { error } = await S.sb.rpc('restore_submission', { p_id: r.id });
  if (error) { toast('Could not restore it: ' + plainError(error), 5000); return; }
  await after(V.view === 'trash' ? '#sug-q' : null);
  toast(undo ? 'Undone. “' + r.group_name + '” is back.' : 'Restored. “' + r.group_name + '” is back in the database.');
}
const QUICK = ['Duplicate of another category', 'Junk or test submission', 'Copyright problem (copied images)', 'Overlaps with a past puzzle'];
export function reasonDialog(id) {
  const r = rowById(id); if (!r) return;
  openModal('<form class="stack" style="--gap:12px" id="why-form" novalidate><h2 id="modal-h">Why is “' + esc(r.group_name) + '” in Trash?</h2>' +
    '<p class="muted">Optional. Every school’s admins see it on the Trash tab; the student never does.</p><div class="chips">' +
    QUICK.map((q) => '<button type="button" class="chip qr">' + esc(q) + '</button>').join('') + '</div>' +
    '<label class="field"><span>Reason</span><textarea class="input" id="why" maxlength="2000">' + esc(r.trash_reason || '') + '</textarea></label>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="submit" id="why-go">Save reason</button></div></form>', (m, close) => {
    $$('.qr', m).forEach((b) => b.addEventListener('click', () => { $('#why', m).value = b.textContent; $('#why', m).focus(); }));
    $('#why-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('#why-go', m), 'Saving…', async () => {
        const v = $('#why', m).value.trim() || null;
        const { data, error } = await S.sb.from('submissions').update({ trash_reason: v }).eq('id', id).select('id');
        if (error || !data || !data.length) { toast('Could not save the reason: ' + plainError(error || 'no permission'), 5000); return; }
        close(); toast(v ? 'Reason saved' : 'Reason removed');
        await after('[data-why="' + id + '"]');
      });
    });
  });
}
export async function addToDraft(r) {
  if (!canPlan()) { toast(PLAN_OFF, 4500); return; }
  await loadPlanner();
  if (PL.err) { toast(PL.err, 5000); return; }
  const it = itemByKey(r.id);
  if (!it) { toast('Old full-puzzle suggestions go into drafts from the Planner.', 4500); return; }
  openUse({ name: r.group_name, it, tier: Number(r.suggested_tier) || 0, tags: r.tags || [] }, () => after(), loadPlanner);
}
export function startFix(id) {
  DS.fixing = id;
  if (V.open !== id) openCard(id); else renderList();
  const f = $('.fix-ed [data-fx="name"]'); if (f) f.focus();
}
onMenu('trash', (id) => { const r = rowById(id); if (r) trashNow(r); });
onMenu('fix', (id) => startFix(id));
onMenu('hide', () => {});

/* Clicks on the cards (the open card's inside is wired by ws-detail). */
export function wireListActions(list) {
  list.addEventListener('click', async (e) => {
    if (e.target.id === 'sug-retry') { renderList(true); await reload(); redraw(); return; }
    if (e.target.closest('.sug-detail')) return;
    const b = e.target.closest('button'); if (!b) return;
    const r = rowById(b.dataset.id || b.dataset.addd || b.dataset.restore || b.dataset.why);
    if (b.classList.contains('vote-btn') && r) {
      await busy(b, '…', () => toggleVote(r.id)); renderList();
      const again = $('#sug-list .card-acts .vote-btn[data-id="' + r.id + '"]'); if (again) again.focus();
    } else if (b.dataset.addd && r) addToDraft(r);
    else if (b.dataset.restore && r) busy(b, 'Restoring…', () => restore(r));
    else if (b.dataset.why && r) reasonDialog(r.id);
    else if (b.classList.contains('sug-toggle')) { if (V.open === b.dataset.id) closeCard(true); else openCard(b.dataset.id); }
  });
}

/* ===== Keyboard shortcuts ===== */
const KEYS = [['/', 'Search'], ['j', 'Next category'], ['k', 'Previous category'], ['v', '👍 the selected category'], ['a', 'Add the selected category to a draft'],
  ['?', 'Show these shortcuts'], ['Esc', 'Close a dialog, menu or open card']];
function shortcutSheet() {
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Keyboard shortcuts</h2><table class="tbl keys"><tbody>' +
    KEYS.map((k) => '<tr><td><kbd>' + esc(k[0]) + '</kbd></td><td>' + esc(k[1]) + '</td></tr>').join('') + '</tbody></table>' +
    '<p class="faint" style="font-size:.8rem">Shortcuts are off while you type in a box. j, k, v and a work in the Category database.</p>' +
    '<div class="modal-actions"><button class="btn primary" type="button" data-dismiss>Close</button></div></div>');
}
const cards = () => $$('#sug-list .sug-card');
function curCard() { const a = document.activeElement, c = a && a.closest && a.closest('#sug-list .sug-card'); return c || $('#sug-list .sug-card.kcur'); }
function markCard(c) { cards().forEach((x) => x.classList.toggle('kcur', x === c)); const t = c && $('.sug-toggle', c); if (t) { t.focus({ preventScroll: true }); c.scrollIntoView({ block: 'nearest' }); } }
export function initCatKeys() {
  document.addEventListener('keydown', async (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || $('.mnu-pop:not([hidden])') || !$('#sug-list')) return;
    if (e.key === '?') { e.preventDefault(); if (!modalOpen()) shortcutSheet(); return; }
    if (modalOpen()) return;
    if (e.key === '/') { const q = $('#sug-q'); if (q) { e.preventDefault(); q.focus(); q.select(); } return; }
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const all = cards(); if (!all.length) return;
      const i = all.indexOf(curCard()), n = i < 0 ? (e.key === 'j' ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, i + (e.key === 'j' ? 1 : -1)));
      markCard(all[n]); return;
    }
    const c = curCard(), r = c && rowById(c.dataset.id); if (!r) return;
    if (e.key === 'v' && r.status !== 'trashed') {
      e.preventDefault(); await toggleVote(r.id); renderList();
      markCard($('#sug-list .sug-card[data-id="' + r.id + '"]'));
    } else if (e.key === 'a' && r.status !== 'trashed') { e.preventDefault(); addToDraft(r); }
  });
}
