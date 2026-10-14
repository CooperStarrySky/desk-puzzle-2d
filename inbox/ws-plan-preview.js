/* Puzzle workspace: the draft's live preview. It reuses the Puzzle Studio's
   preview frame (studio/preview.html), which draws with the game's own code
   (buildPieces, buildResultPlacard), so the desk and the results screen look
   exactly like the real game. The draft is turned into puzzle JSON here and
   posted to the frame after every change. Also: "Preview as player" (big) and
   "Export puzzle spec" (the YAML that tools/build_puzzle.py reads). */
import { $, $$, esc, toast, openModal, isStoragePath, signedUrl } from './ws-core.js';
import { PL, slotsOf } from './ws-plan-data.js';
import { draftSpec, specToYaml } from './ws-publish-spec.js';
import { addPart, current } from './ws-plan-editor.js';
import { etParts, nextThursday, releaseLabel } from './ws-plan-time.js';

const FRAME_SRC = '../studio/preview.html';
const frames = new Set(); // { el, view, ready }
let view = 'desk';

/* The draft as the game would load it (filled slots only). Images get short-lived signed links. */
async function urlFor(p) { return isStoragePath(p) ? signedUrl(p) : p || ''; }
export async function puzzleOf(d) {
  const sl = slotsOf(d.id), groups = [], items = [];
  for (const t of [1, 2, 3, 4]) {
    const it = sl[t] && sl[t].item; if (!it) continue;
    const ids = it.items.map((c, i) => 't' + t + '-' + (i + 1));
    const g = { id: 'g-t' + t, name: it.name, tier: t, explanation: it.explanation.trim() || 'No explanation yet.', itemIds: ids };
    const art = (Array.isArray(it.article) ? it.article : []).filter((b) => b && (b.type === 'heading' || b.type === 'text'));
    if (art.length) g.article = art;
    if (it.credit) g.credit = Object.assign({ name: it.credit.name }, it.credit.line ? { line: it.credit.line } : {});
    groups.push(g);
    for (let i = 0; i < it.items.length; i++) {
      const c = it.items[i], info = c.info || {}, scope = c.scope || {};
      const x = { id: ids[i], label: String(c.label || 'Clue ' + (i + 1)), zone: c.zone, info: { title: String(c.label || '') } };
      if ((c.zone === 'photo' || c.zone === 'tubes') && info.image) { const u = await urlFor(info.image); if (u) x.info.image = u; }
      if (c.zone === 'rack' && (scope.image || info.image)) { const u = await urlFor(scope.image || info.image); if (u) x.scope = { image: u }; }
      if (typeof c.note === 'string' && c.note.trim()) x.note = c.note.trim();
      items.push(x);
    }
  }
  const machines = [];
  if (items.some((i) => i.zone === 'rack')) machines.push('scope');
  if (items.some((i) => i.zone === 'tubes')) machines.push('lightbox');
  return { id: 'draft-preview', title: d.title, date: d.target_release ? etParts(d.target_release).date : '', machines, groups, items };
}
const theme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
async function post(f) {
  const d = current();
  if (!d || !f.ready || !f.el.isConnected || !f.el.contentWindow) return;
  const pz = await puzzleOf(d);
  if (!f.el.isConnected) return;
  f.el.contentWindow.postMessage({ type: 'dp-studio-preview', view: f.view, puzzle: pz, theme: theme(), expand: false }, location.origin);
  f.el.dataset.groups = String(pz.groups.length);
}
function postAll() {
  frames.forEach((f) => { if (!f.el.isConnected) frames.delete(f); else post(f); });
  const d = current(), n = d ? slotsOf(d.id).filter(Boolean).length : 0, empty = $('#pv-empty');
  if (empty) { empty.hidden = n > 0; $('#pv-frame').hidden = n === 0; }
}
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || !ev.data) return;
  frames.forEach((f) => {
    if (ev.source !== f.el.contentWindow) return;
    if (ev.data.type === 'dp-studio-preview-ready') { f.ready = true; post(f); }
    if (ev.data.type === 'dp-studio-preview-size') f.el.style.height = Math.max(140, ev.data.h) + 'px';
  });
});
new MutationObserver(() => postAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function addFrame(el, v) {
  const f = { el, view: v, ready: false }; frames.add(f);
  el.addEventListener('load', () => { try { el.contentWindow.postMessage({ type: 'dp-studio-preview-hello' }, location.origin); } catch (e) { /* not ready */ } });
  return f;
}
const tabsHtml = (attr, v) => '<div class="pv-tabs" role="tablist" aria-label="Preview">' + [['desk', 'Desk'], ['results', 'Results screen']].map((o) =>
  '<button type="button" role="tab" class="chip" ' + attr + '="' + o[0] + '" aria-selected="' + (v === o[0]) + '" aria-pressed="' + (v === o[0]) + '">' + o[1] + '</button>').join('') + '</div>';
function setTabs(root, attr, v) { $$('[' + attr + ']', root).forEach((b) => { const on = b.getAttribute(attr) === v; b.setAttribute('aria-selected', on); b.setAttribute('aria-pressed', on); }); }

function playerPreview() {
  const d = current(); if (!d) return;
  let v = view;
  openModal('<div class="stack" style="--gap:10px"><div class="row spread"><h2 id="modal-h">Preview as player · ' + esc(d.title) + '</h2><button class="btn ghost small" type="button" data-dismiss>Close</button></div>' +
    tabsHtml('data-pp', v) + '<p class="hint" id="pp-hint">The desk players get (each category on its own row here; the game shuffles all 16).</p>' +
    '<iframe class="pv-frame big" id="pp-frame" title="Full-size preview of the puzzle" src="' + FRAME_SRC + '"></iframe></div>',
  (m) => {
    m.classList.add('full');
    const f = addFrame($('#pp-frame', m), v);
    $$('[data-pp]', m).forEach((b) => b.addEventListener('click', () => {
      v = f.view = b.dataset.pp; setTabs(m, 'data-pp', v); post(f);
      $('#pp-hint', m).textContent = v === 'desk' ? 'The desk players get (each category on its own row here; the game shuffles all 16).' : 'The results screen, easiest first. Click a placard to open its teaching note.';
    }));
  });
}

/* ===== Export: the repo's spec format (puzzles/_spec/*.yaml for tools/build_puzzle.py) =====
   Same file the automatic publisher writes (shared code: ws-publish-spec.js). */
export function specYaml(d) {
  const date = d.target_release ? etParts(d.target_release).date : nextThursday();
  const r = draftSpec(d, PL.slots.filter((s) => s.draft_id === d.id), PL.subs, { date });
  const where = new Map(r.images.map((im) => [im.file, im.ref.kind === 'storage' ? 'in the inbox: ' + im.ref.path : im.ref.kind === 'site' ? 'on the site: ' + im.ref.path
    : im.ref.kind === 'data' ? 'inside the suggestion' : 'a link: ' + String(im.ref.value).slice(0, 80)]));
  const header = ['Desk Puzzle spec, exported from the puzzle workspace (draft "' + String(d.title).replace(/\s+/g, ' ') + '").',
    'Date: ' + (d.target_release ? releaseLabel(d.target_release) : 'not scheduled yet, so next Thursday') + '.',
    'Images: download them from the inbox ("Download for import") and save them in',
    '../' + r.id + '-src/ under the names below.',
    'Check it with: python3 tools/build_puzzle.py puzzles/_spec/' + r.id + '.yaml'];
  return specToYaml(r.spec, { header, imagesDir: '../' + r.id + '-src/', imageNote: (x, k) => where.get(x[k]) || '' });
}
function exportDialog() {
  const d = current(); if (!d) return;
  const y = specYaml(d), empty = slotsOf(d.id).slice(1).filter((x) => !x).length;
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Export puzzle spec</h2>' +
    (empty ? '<p class="err">' + empty + (empty > 1 ? ' slots are' : ' slot is') + ' still empty. The spec marks them EMPTY.</p>' : '') +
    '<p class="muted">The file the build tool reads. Copy it, or hand it to whoever builds the week.</p>' +
    '<pre class="yaml" id="yaml" tabindex="0" aria-label="Puzzle spec (YAML)">' + esc(y) + '</pre>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Close</button><button class="btn primary" type="button" id="yaml-copy">Copy YAML</button></div></div>',
  (m) => {
    m.classList.add('wide');
    $('#yaml-copy', m).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(y); toast('Copied the spec'); } catch (e) {
        const r = document.createRange(); r.selectNodeContents($('#yaml', m)); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        toast('Copy was blocked here. The text is selected: press Ctrl+C (⌘C on a Mac).', 5000);
      }
    });
  });
}

function mount() {
  const col = $('#pv-col'); if (!col) return;
  col.hidden = false;
  col.innerHTML = '<div class="pv-head"><h2 id="pv-h">Live preview</h2><button type="button" class="btn small ghost rail-x" id="pv-fold" aria-controls="pv-col" aria-label="Fold the Live preview" title="Fold the Live preview">»</button>' +
    '<button type="button" class="btn small primary sheet-done" data-sheet-x>Done</button></div>' +
    '<div class="row pv-acts" style="--gap:6px"><button type="button" class="btn small" id="pv-player">Preview as player</button>' +
    '<button type="button" class="btn small" id="pv-export">Export puzzle spec</button></div>' + tabsHtml('data-pv', view) +
    '<p class="empty" id="pv-empty" hidden>Put a category in a slot to see the desk and the results screen.</p>' +
    '<iframe class="pv-frame" id="pv-frame" title="Live preview of the puzzle" src="' + FRAME_SRC + '"></iframe>' +
    '<p class="hint pv-hint">Drawn by the game itself. Slides show a letter until they go under the microscope; films are shown lit.</p>';
  const f = addFrame($('#pv-frame', col), view);
  $$('[data-pv]', col).forEach((b) => b.addEventListener('click', () => { view = f.view = b.dataset.pv; setTabs(col, 'data-pv', view); post(f); }));
  $('#pv-player', col).addEventListener('click', playerPreview);
  $('#pv-export', col).addEventListener('click', exportDialog);
}
addPart({ mount, update: postAll });
