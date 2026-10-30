/* Puzzle workspace: see inside a Database card without adding it. Hovering a
   card (desktop, short delay) shows a preview: name, suggested tier, the four
   clues (image clues with a thumbnail), the explanation, the usage line and 👍.
   "👁 View" opens the same content in a dialog with "Add to draft…" and Close,
   which also works on touch screens. Neither changes the draft. */
import { $, esc, openModal, fillImages, hasImage, schName, TIER_WORDS, ZONES } from './ws-core.js';
import { itemByKey, tierOfKey, votesFor } from './ws-plan-data.js';
import { textPieceHtml } from './ws-clues.js';
import { LIB, TOUCH, useOfItem, ST_LABEL, alsoFlags, DND } from './ws-plan-lib.js';

const picOf = (c) => { const info = c.info || {}, sc = c.scope || {}; return c.zone === 'rack' ? sc.image || info.image : c.zone === 'photo' || c.zone === 'tubes' ? info.image : ''; };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
/* "Used 2× (1 adapted) · CMSRU · in 1 draft · 👍 3" */
export function usageText(it) {
  const u = useOfItem(it), b = [], vs = votesFor(it).length;
  if (u.times_used) b.push('Used ' + u.times_used + '×' + (u.adapted ? ' (' + u.adapted + ' adapted)' : ''), (u.schools || []).map(schName).join(', '));
  else b.push(it.status === 'used' ? 'Used' : 'Never used');
  if (u.drafts_count) b.push('in ' + plural(u.drafts_count, 'draft'));
  b.push('👍 ' + vs);
  return b.filter(Boolean).join(' · ');
}
export function peekHtml(it, big) {
  const t = LIB.draft ? tierOfKey(LIB.draft.id, it.key) : 0;
  const clues = it.items.map((c) => {
    const z = ZONES[c.zone] || ['Clue', '•'], p = picOf(c);
    const th = hasImage(p) ? '<img class="pk-th" alt="' + esc(z[0] + ' for ' + c.label) + '" data-path="' + esc(p) + '">'
      : (textPieceHtml(c, 'pk-th', true) || '<span class="pk-th none" title="' + esc(z[0]) + '" aria-hidden="true">' + z[1] + '</span>');
    return '<li>' + th + '<span class="pk-l"><span class="sr">' + esc(z[0]) + ': </span>' + esc(c.label) + '</span></li>';
  }).join('');
  return '<div class="pk' + (big ? ' big' : '') + '"><p class="pk-tier"><span class="tierdot t' + (it.tier || 0) + '"></span>Suggested ' + esc(TIER_WORDS[it.tier] || 'tier not set') +
    ' · ' + esc(ST_LABEL(it)) + (it.tags.length ? ' · ' + esc(it.tags.join(', ')) : '') + '</p>' +
    (it.kind === 'group' ? '<p class="faint pk-from">Group from the full puzzle “' + esc(it.parent) + '”</p>' : '') +
    '<ul class="pk-clues" aria-label="Clues">' + (clues || '<li class="faint">No clues</li>') + '</ul>' +
    '<p class="pk-ex">' + (it.explanation.trim() ? esc(it.explanation) : '<i class="faint">No explanation yet</i>') + '</p>' +
    '<p class="pk-use">' + esc(usageText(it)) + '</p>' + (t ? '<p class="badge in-draft">In this draft · ' + esc(TIER_WORDS[t]) + '</p>' : '') + alsoFlags(it.key) + '</div>';
}

/* ===== Hover preview ===== */
const HV = { t: 0, h: 0, key: '', card: null };
function el() {
  let p = $('#lib-peek');
  if (!p) {
    p = document.createElement('div'); p.id = 'lib-peek'; p.className = 'lib-peek panel'; p.setAttribute('role', 'tooltip'); p.hidden = true;
    p.addEventListener('mouseenter', () => clearTimeout(HV.h));
    p.addEventListener('mouseleave', () => hideSoon());
    document.body.appendChild(p);
  }
  return p;
}
export function hidePeek() {
  clearTimeout(HV.t); clearTimeout(HV.h);
  const p = $('#lib-peek'); if (p) p.hidden = true;
  if (HV.card) HV.card.removeAttribute('aria-describedby');
  HV.key = ''; HV.card = null;
}
function hideSoon() { clearTimeout(HV.h); HV.h = setTimeout(hidePeek, 160); }
function show(card) {
  const it = itemByKey(card.dataset.key); if (!it || !card.isConnected || DND.v) return;
  const p = el();
  p.innerHTML = '<h3 class="pk-h">' + esc(it.name) + '</h3>' + peekHtml(it);
  p.hidden = false; fillImages(p);
  const r = card.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight, vw = innerWidth, vh = innerHeight;
  let x = r.right + 10; if (x + w > vw - 8) x = Math.max(8, r.left - w - 10);
  p.style.left = x + 'px'; p.style.top = Math.max(8, Math.min(r.top, vh - h - 8)) + 'px';
  HV.key = it.key; HV.card = card; card.setAttribute('aria-describedby', 'lib-peek');
}
export function wirePeek(lib) {
  if (TOUCH) return;
  lib.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.lib-card'); if (!c || !lib.contains(c)) return;
    clearTimeout(HV.h);
    if (HV.card === c) return;
    clearTimeout(HV.t);
    const wait = $('#lib-peek') && !$('#lib-peek').hidden ? 120 : 450; // moving between cards feels instant once one is open
    HV.t = setTimeout(() => show(c), wait);
  });
  lib.addEventListener('mouseout', (e) => {
    const c = e.target.closest('.lib-card'); if (!c || c.contains(e.relatedTarget)) return;
    clearTimeout(HV.t); if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#lib-peek'))) hideSoon();
  });
  ['dragstart', 'mousedown', 'wheel'].forEach((ev) => lib.addEventListener(ev, hidePeek, { passive: true }));
  const list = $('#lib-list', lib); if (list) list.addEventListener('scroll', hidePeek, { passive: true });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && HV.key) hidePeek(); });
window.addEventListener('hashchange', hidePeek);

/* ===== 👁 View: the same content, pinned in a dialog ===== */
export function viewDialog(key) {
  const it = itemByKey(key); if (!it) return;
  hidePeek();
  const t = LIB.draft ? tierOfKey(LIB.draft.id, key) : 0;
  openModal('<div class="stack view-dlg" style="--gap:12px"><div class="row spread"><h2 id="modal-h">' + esc(it.name) + '</h2>' +
    '<button class="btn ghost small" type="button" data-dismiss aria-label="Close">✕</button></div>' + peekHtml(it, true) +
    '<p class="hint">Viewing doesn’t change the draft.</p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss id="view-close">Close</button>' +
    (LIB.canEdit && LIB.onAdd ? '<button class="btn primary" type="button" id="view-add">' + (t ? 'Move…' : 'Add to draft…') + '</button>' : '') + '</div></div>',
  (m, close) => {
    fillImages(m);
    const b = $('#view-add', m); if (b) b.addEventListener('click', () => { close(); LIB.onAdd(key); });
  });
}
