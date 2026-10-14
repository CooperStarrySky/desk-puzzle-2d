/* Puzzle workspace: how a suggestion's content is drawn when it opens: the
   little desk, each clue with its pictures and notes, and the teaching note.
   Moved from the old single-file inbox's detail page. */
import { esc, isPuzzle, itemsOf, nidsOf, groupsOf, hasImage, ZONE_NAMES, TIER_WORDS } from './ws-core.js';

function pieceHtml(it, i) {
  const info = it.info || {}; const scope = it.scope || {};
  const pic = it.zone === 'rack' ? (scope.image || info.image) : (it.zone === 'photo' || it.zone === 'tubes') ? info.image : '';
  return '<div class="mp mp-' + esc(it.zone) + '" style="--rot:' + (((i * 37) % 5) - 2) + 'deg" title="' + esc((ZONE_NAMES[it.zone] || '') + ': ' + (it.label || '')) + '">' +
    (hasImage(pic) ? '<span class="pic" data-path="' + esc(pic) + '"></span>' : '') + '<b>' + esc(it.label) + '</b></div>';
}
function clueHtml(it, i) {
  const info = it.info || {}; const scope = it.scope || {};
  const thumbs = [];
  if (hasImage(scope.image)) thumbs.push('<img class="scope" alt="Microscope view for clue ' + (i + 1) + '" data-path="' + esc(scope.image) + '">');
  if (hasImage(info.image)) thumbs.push('<img alt="Image for clue ' + (i + 1) + '" data-path="' + esc(info.image) + '">');
  if (!thumbs.length) thumbs.push('<div class="none">' + (['photo', 'tubes', 'rack'].includes(it.zone) ? 'No image sent' : 'Text clue') + '</div>');
  return '<div class="clue-row"><div class="thumbs">' + thumbs.join('') + '</div><div class="stack" style="--gap:5px">' +
    '<div class="row" style="--gap:8px"><span class="clue-num">Clue ' + (i + 1) + '</span><span class="badge">' + esc(ZONE_NAMES[it.zone] || it.zone) + '</span></div>' +
    '<b>' + esc(it.label) + '</b>' + (info.title && info.title !== it.label ? '<span class="muted">Title: ' + esc(info.title) + '</span>' : '') +
    (info.text ? '<p style="font-size:.92rem">' + esc(info.text) + '</p>' : '') +
    (typeof it.note === 'string' && it.note.trim() ? '<p class="clue-note" style="font-size:.92rem"><span class="eyebrow">Results note</span> ' + esc(it.note) + '</p>' : '') +
    (it.source ? '<p class="hint">Image source: ' + esc(it.source) + '</p>' : '') + '</div></div>';
}
function articleHtml(blocks) {
  if (!blocks || !blocks.length) return '';
  return '<div class="stack article" style="--gap:8px"><span class="eyebrow">Teaching note</span>' +
    blocks.map((b) => (b.type === 'heading' ? '<h3>' + esc(b.text) + '</h3>' : b.type === 'text' ? '<p>' + esc(b.text) + '</p>' : '')).join('') + '</div>';
}
const explain = (t) => (t && String(t).trim() ? '<p>' + esc(t) + '</p>'
  : '<p><i class="muted">No explanation yet. The results screen needs one before this can be used.</i></p>');
function groupBody(g) {
  const items = itemsOf(g); const nids = nidsOf(g);
  return '<div class="desk"><div class="pieces">' + items.map(pieceHtml).join('') + '</div></div>' + items.map(clueHtml).join('') +
    articleHtml(g.article) + (nids.length ? '<p class="hint">Anki: <span class="code">' + nids.map(esc).join(', ') + '</span></p>' : '');
}
/* Just the clues of one category (the desk, then each clue with its pictures). */
export const cluesHtml = (g) => groupBody(g);
/* Explanation + clues for either shape: a category, or a full puzzle's 4 groups. */
export function contentHtml(r) {
  if (!isPuzzle(r)) {
    const g = r.payload || {};
    return '<section><h4 class="sd-h">Explanation</h4>' + explain(g.explanation) + '</section>' +
      '<section><h4 class="sd-h">Clues</h4>' + groupBody(g) + '</section>';
  }
  const gs = groupsOf(r).map((g, i) => [g, i]).sort((a, b) => (Number(a[0].tier) || 9) - (Number(b[0].tier) || 9));
  return '<section><h4 class="sd-h">The four groups</h4>' + gs.map(([g, i]) => {
    const t = Number(g.tier) || 0;
    return '<div class="pz-group stack t' + t + '" style="--gap:10px"><h5 class="sd-g"><span class="tierdot t' + t + '"></span> Group ' + (i + 1) + ' · ' + esc(TIER_WORDS[t] || '?') + ': ' + esc(g.name) + '</h5>' +
      explain(g.explanation) + groupBody(g) + '</div>';
  }).join('') + '</section>';
}
