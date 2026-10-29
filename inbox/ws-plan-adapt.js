/* Puzzle workspace: "Edit for this puzzle". A slot can hold an adapted copy of
   its category (draft_slots.adapted) that lives only in this draft; the
   original in the Category database is never touched. Per clue: the text on
   the piece, its type, a replacement image (uploaded under drafts/<draft id>/),
   or a clue swapped in from another category. The slot then shows
   "Adapted · N changes"; tapping it lists original vs copy with Reset per
   change and Reset all. Pickers (image, swap) are in ws-plan-adapt-pick.js. */
import { S, BUCKET, esc, isStoragePath, isSitePath, siteUrl, ZONES, ZONE_NAMES } from './ws-core.js';
import { slotsOf, saveAdapted } from './ws-plan-data.js';
import { presenceChanged } from './ws-live.js';

export const IMG_ZONES = ['rack', 'tubes', 'photo'];
export const isImg = (z) => IMG_ZONES.includes(z);
const TYPE_GROUPS = [['Image', ['rack', 'tubes', 'photo']], ['Text', ['corkboard', 'folder', 'rx']]];
const short = (z) => (ZONES[z] || [z || '?'])[0];
export const clone = (x) => JSON.parse(JSON.stringify(x == null ? null : x));
/* AD.edit = "<draft id>:<tier>" being edited, AD.w = the work copy, AD.diff = the open "what changed" panel,
   AD.up = pictures uploaded during this edit (tidied away if the edit is cancelled). */
export const AD = { edit: null, w: null, diff: null, up: [] };

export function picOf(c) {
  if (!c || !isImg(c.zone)) return '';
  return (c.zone === 'rack' ? (c.scope && c.scope.image) || (c.info && c.info.image) : c.info && c.info.image) || '';
}
/* Put a picture where the game reads it for this type (slides: scope.image; photos, X-rays: info.image). */
export function setPic(c, p) {
  c.info = Object.assign({}, c.info || {}); delete c.info.image;
  if (c.scope) { c.scope = Object.assign({}, c.scope); delete c.scope.image; if (!Object.keys(c.scope).length) delete c.scope; }
  if (!p || !isImg(c.zone)) return;
  if (c.zone === 'rack') c.scope = Object.assign({}, c.scope || {}, { image: p }); else c.info.image = p;
}
export const origOf = (it) => (it && it.orig) || it;
/* A fresh work copy: the saved copy, or the original's name, explanation and clues. */
export function workFrom(it) {
  const o = origOf(it), a = it.adapted ? clone(it.adapted) : { name: o.name, explanation: o.explanation, items: clone(o.items) };
  a.items = (a.items || []).slice(0, 4).map((c) => Object.assign({ info: {} }, c));
  return a;
}
/* What changed in one clue, as short phrases. */
function clueDiff(o, a) {
  if (!o || !a) return [];
  if (a.swap) return ['swapped in ‘' + a.label + '’ (' + short(a.zone) + ') from “' + a.swap.name + '”'];
  const out = [];
  if (String(a.label) !== String(o.label)) out.push('text ‘' + o.label + '’ → ‘' + a.label + '’');
  if (a.zone !== o.zone) out.push('type ' + short(o.zone) + ' → ' + short(a.zone));
  if (isImg(a.zone) && picOf(a) !== picOf(o)) out.push(picOf(a) ? 'new image' : 'needs an image');
  return out;
}
/* [{ key: 'name' | 'ex' | 'c0'..'c3', label, parts }] */
export function changes(o, a) {
  const out = [];
  if (!a) return out;
  if (String(a.name).trim() !== String(o.name).trim()) out.push({ key: 'name', label: 'Name', parts: ['‘' + o.name + '’ → ‘' + a.name + '’'] });
  (o.items || []).forEach((c, i) => { const p = clueDiff(c, (a.items || [])[i]); if (p.length) out.push({ key: 'c' + i, label: 'Clue ' + (i + 1), parts: p }); });
  if (String(a.explanation || '').trim() !== String(o.explanation || '').trim()) out.push({ key: 'ex', label: 'Explanation', parts: ['changed'] });
  return out;
}
export function revertPart(a, o, key) {
  if (key === 'name') a.name = o.name;
  else if (key === 'ex') a.explanation = o.explanation;
  else { const i = Number(key.slice(1)); a.items[i] = clone(o.items[i]); }
}
/* Trim, fall back to the original where a box was emptied, keep info.title = label. */
export function tidy(w, o) {
  const a = clone(w);
  a.name = String(a.name || '').trim().slice(0, 120) || o.name;
  a.explanation = String(a.explanation || '').trim();
  a.items = a.items.map((c, i) => { const x = Object.assign({}, c); x.label = String(x.label || '').trim().slice(0, 80) || o.items[i].label; x.info = Object.assign({}, x.info, { title: x.label }); return x; });
  return a;
}
/* A small picture (or the piece's text) for one clue. */
export function thumb(c, extra) {
  const p = picOf(c), cls = 'ph mini ' + (isImg(c.zone) ? c.zone : 'text') + (extra ? ' ' + extra : '');
  if (p && isStoragePath(p)) return '<span class="' + cls + ' pic" data-path="' + esc(p) + '" aria-hidden="true"></span>';
  if (p) return '<span class="' + cls + ' pic" style="background-image:url(&quot;' + esc((isSitePath(p) ? siteUrl(p) : p).replace(/["\\\n]/g, '')) + '&quot;)" aria-hidden="true"></span>';
  return '<span class="' + cls + '" aria-hidden="true">' + esc(isImg(c.zone) ? short(c.zone) : c.label) + '</span>';
}
const side = (c) => '<div class="dv-side">' + thumb(c) + '<span class="stack" style="--gap:2px"><b>' + esc(c.label) + '</b><span class="faint">' + esc(ZONE_NAMES[c.zone] || c.zone) +
  (isImg(c.zone) ? (picOf(c) ? ' · image' : ' · no image') : '') + '</span></span></div>';

/* "Adapted · N changes" and, when open, original vs this puzzle per change. */
export function badgeHtml(d, t, it, ro) {
  const o = origOf(it), a = it.adapted, ch = changes(o, a), open = AD.diff === d.id + ':' + t;
  return '<div class="adapted"><p class="row" style="--gap:6px"><button type="button" class="adapt-badge" data-diff="' + t + '" aria-expanded="' + open + '">Adapted · ' + ch.length + ' change' + (ch.length === 1 ? '' : 's') +
    '<span class="chev" aria-hidden="true"></span></button><span class="faint adapted-from">from <i>' + esc(o.name) + '</i></span></p>' +
    (open ? '<div class="diff2" id="diff-' + t + '">' + ch.map((c) => {
      const i = c.key[0] === 'c' ? Number(c.key.slice(1)) : -1;
      const body = i >= 0 ? '<div class="dv-pair"><div><span class="eyebrow">Original</span>' + side(o.items[i]) + '</div><div><span class="eyebrow">This puzzle</span>' + side(a.items[i]) + '</div></div>' +
        '<p class="faint dv-what">' + esc(c.parts.join('; ')) + '</p>'
        : '<p class="dv-txt"><del>' + esc(c.key === 'name' ? o.name : o.explanation) + '</del> → <ins>' + esc(c.key === 'name' ? a.name : a.explanation) + '</ins></p>';
      return '<div class="dv-row"><div class="row spread"><b>' + esc(c.label) + '</b>' + (ro ? '' : '<button type="button" class="btn small ghost" data-rv="' + t + '|' + c.key + '" aria-label="Reset ' + esc(c.label) + ' to the original">Reset</button>') + '</div>' + body + '</div>';
    }).join('') + (ro ? '' : '<div><button type="button" class="btn small" data-revert="' + t + '">Reset all to the original</button></div>') + '</div>' : '') + '</div>';
}
function typeSelect(i, z) {
  return '<select class="input" data-adz="' + i + '" aria-label="Clue ' + (i + 1) + ' type">' + TYPE_GROUPS.map((g) => '<optgroup label="' + g[0] + '">' +
    g[1].map((k) => '<option value="' + k + '"' + (k === z ? ' selected' : '') + '>' + esc(ZONE_NAMES[k]) + '</option>').join('') + '</optgroup>').join('') + '</select>';
}
export function editorHtml(d, t, it) {
  const o = origOf(it), w = AD.w;
  return '<div class="slot-body adapt-ed" data-ed="' + t + '"><p class="eyebrow">Edit for this puzzle only</p><p class="faint ad-intro">Changes stay in this draft. The original “' + esc(o.name) + '” in the Category database is untouched.</p>' +
    '<label class="field"><span>Name</span><input class="input" data-ad="name" maxlength="120" value="' + esc(w.name) + '"></label>' +
    w.items.map((c, i) => {
      const p = clueDiff(o.items[i], c);
      return '<fieldset class="ad-clue' + (p.length ? ' changed' : '') + '" data-clue="' + i + '"><legend>Clue ' + (i + 1) + (p.length ? ' <span class="kind-tag adapted-tag">Changed</span>' : '') + '</legend>' +
        '<div class="ad-row">' + thumb(c) + '<div class="stack" style="--gap:6px"><label class="field"><span>Text on the piece</span><input class="input" data-adl="' + i + '" maxlength="80" value="' + esc(c.label) + '"></label>' +
        '<label class="field"><span>Type</span>' + typeSelect(i, c.zone) + '</label></div></div>' +
        (isImg(c.zone) ? '<p class="ad-img">' + (picOf(c) ? (picOf(c) === picOf(o.items[i]) ? 'Image: same as the original' : c.swap ? 'Image: comes with the swapped-in clue' : 'Image: new for this puzzle')
          : isImg(o.items[i].zone) && !picOf(o.items[i]) ? 'No image (the original has none either)' : '<span class="err ad-need">Needs an image</span>') + '</p>' : '') +
        (c.swap ? '<p class="faint ad-sw">Swapped in from “' + esc(c.swap.name) + '”</p>' : '') +
        '<div class="row" style="--gap:6px">' + (isImg(c.zone) ? '<button type="button" class="btn small" data-adimg="' + i + '">Replace image…</button>' : '') +
        '<button type="button" class="btn small" data-adsw="' + i + '">Swap in a clue…</button>' + (p.length ? '<button type="button" class="btn small ghost" data-adrv="' + i + '">Revert clue</button>' : '') + '</div></fieldset>';
    }).join('') +
    '<label class="field"><span>Explanation</span><textarea class="input" data-ad="explanation" maxlength="1500">' + esc(w.explanation || '') + '</textarea></label>' +
    '<div class="row" style="--gap:6px"><button type="button" class="btn small primary" data-adsave="' + t + '">Save for this puzzle</button><button type="button" class="btn small" data-adcancel="' + t + '">Cancel</button></div></div>';
}
export const editing = (d, t) => !!AD.w && AD.edit === d.id + ':' + t;
export function startEdit(d, t) {
  const s = slotsOf(d.id)[t]; if (!s || !s.item || !s.item.sid) return false;
  if (AD.w) stopEdit(); // another slot's edit was still open: it counts as cancelled
  AD.edit = d.id + ':' + t; AD.w = workFrom(s.item); AD.diff = null; AD.up = []; presenceChanged(); return true;
}
/* Ends the edit. saved = the copy that was saved (null when cancelled or reset).
   Pictures uploaded during this edit that the saved copy does not use are
   deleted again (best effort; the database only lets you delete your own). */
export function stopEdit(saved) {
  const draftId = AD.edit ? AD.edit.split(':')[0] : '';
  const keep = new Set(saved ? imagesOf(saved) : []);
  const drop = (AD.up || []).filter((p) => !keep.has(p));
  AD.edit = null; AD.w = null; AD.up = [];
  if (drop.length && draftId) dropUploads(draftId, drop);
  presenceChanged();
}
const imagesOf = (a) => ((a && a.items) || []).reduce((l, c) => l.concat([c && c.info && c.info.image, c && c.scope && c.scope.image]), []).filter(Boolean);
async function dropUploads(draftId, paths) {
  // Never delete a picture some saved copy in this draft still points at.
  const used = new Set();
  slotsOf(draftId).forEach((s) => { if (s && s.item && s.item.adapted) imagesOf(s.item.adapted).forEach((p) => used.add(p)); });
  const mine = paths.filter((p) => p.startsWith('drafts/' + draftId + '/') && !used.has(p));
  if (!mine.length) return;
  try { await S.sb.storage.from(BUCKET).remove(mine); } catch (e) { /* best effort: an unused file costs nothing */ }
}
/* Save (or reset, when nothing differs) the copy in one slot. Returns a toast message or '' on failure. */
export async function commit(d, t, a) {
  const s = slotsOf(d.id)[t]; if (!s) return '';
  const o = origOf(s.item), ch = changes(o, a);
  if (!ch.length && !s.item.adapted) return 'No differences from the original, so nothing was saved.';
  if (!(await saveAdapted(d.id, t, ch.length ? a : null))) return '';
  return ch.length ? 'Saved for this puzzle only (' + ch.length + (ch.length === 1 ? ' change' : ' changes') + '). The original is untouched.' : 'Back to the original “' + o.name + '”.';
}
