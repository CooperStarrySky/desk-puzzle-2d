/* Puzzle workspace: a draft as the build tool's spec (puzzles/_spec/<id>.yaml,
   read by tools/build_puzzle.py). Shared by the Planner's "Export puzzle spec"
   and the automatic publisher (tools/publish_drafts.mjs), so both write the
   same file. Pure: no page, no network (runs in the browser and in Node).

   Inputs are the raw database rows: the draft, its draft_slots rows, and the
   submissions they point at (a Map or a plain object keyed by id). */
import { etParts } from './ws-plan-time.js';

export const TIER_WORD = ['', 'Easy', 'Medium', 'Hard', 'Hardest'];
const ZONES = ['corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx'];
const EXTS = ['webp', 'jpg', 'jpeg', 'png', 'gif'];

/* Same rule as build_puzzle.py: lower case, a-z 0-9 and single hyphens. */
export function slugify(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
/* "<slug of the title>-YYYY-MM-DD"; a trailing word "Puzzle" is dropped, as the build tool does. */
export function puzzleIdFor(title, date) {
  const s = slugify(String(title || '').replace(/\s+puzzle\s*$/i, '')).slice(0, 100).replace(/-+$/, '');
  return (s || 'puzzle') + '-' + date;
}
/* The puzzle's date (Eastern): a scheduled run uses its release day, "Publish now" uses today. */
export function releaseDate(kind, targetRelease, now) {
  return etParts(kind === 'scheduled' && targetRelease ? targetRelease : (now || Date.now())).date;
}

function cleanCredit(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim(), line = String(c.line || '').trim();
  return name ? Object.assign({ name }, line ? { line } : {}) : null;
}
const subCredit = (r) => (r && r.credit_mode === 'named' ? cleanCredit({ name: r.credit_name, line: r.credit_line }) : null);

/* Where a clue's picture lives: storage (private bucket), the site itself (puzzles/...), inside the row (data:), or elsewhere. */
export function imageRef(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  v = v.trim();
  if (/^data:/.test(v)) return { kind: 'data', value: v };
  if (/^https?:/i.test(v)) {
    let p = ''; try { p = new URL(v).pathname; } catch (e) { p = ''; }
    const i = p.indexOf('/puzzles/');
    return i >= 0 ? { kind: 'site', path: decodeURIComponent(p.slice(i + 1)) } : { kind: 'url', value: v };
  }
  if (/^blob:/.test(v)) return { kind: 'url', value: v };
  if (/^\/?puzzles\//.test(v)) return { kind: 'site', path: v.replace(/^\/+/, '') };
  return { kind: 'storage', path: v.replace(/^\/+/, '') };
}
function extOf(ref) {
  const m = ref.kind === 'data' ? /^data:image\/([a-z0-9.+-]+)/i.exec(ref.value) : /\.([a-z0-9]+)$/i.exec(ref.path || ref.value || '');
  const e = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  return EXTS.includes(e) ? e : 'img';
}
function uniq(base, seen) {
  let id = base, n = 2;
  while (seen.has(id)) id = base + '-' + n++;
  seen.add(id);
  return id;
}
const getSub = (subs, id) => (subs instanceof Map ? subs.get(id) : subs && subs[id]) || null;

/* The group a slot holds, plus who sent it in. */
function slotGroup(slot, subs) {
  if (slot.custom_group) {
    const g = slot.custom_group;
    return { g, name: g.name, credit: cleanCredit(g.credit), sid: null };
  }
  const r = getSub(subs, slot.submission_id);
  if (!r) return null;
  if (r.kind === 'puzzle') {
    const groups = r.payload && Array.isArray(r.payload.groups) ? r.payload.groups : [];
    const g = groups[slot.group_index];
    return g ? { g, name: g.name, credit: subCredit(r), sid: r.id, full: true } : null;
  }
  const g = r.payload || {};
  return { g, name: r.group_name || g.name, credit: subCredit(r), sid: r.id };
}

/* draft + slot rows + submissions -> { id, date, spec, images, problems }.
   images: [{ file, ref, item, tier }] (file = the name inside the images folder).
   problems: plain-English reasons the draft cannot be built as it stands. */
export function draftSpec(draft, slots, subs, opts) {
  const o = opts || {}, date = o.date, id = o.id || puzzleIdFor(draft.title, date);
  const problems = [], images = [], groups = [], empty = [], gIds = new Set(), iIds = new Set(), from = [];
  const rows = (slots || []).filter((s) => s.draft_id == null || s.draft_id === draft.id);
  for (const t of [1, 2, 3, 4]) {
    const where = 'Tier ' + t + ' (' + TIER_WORD[t] + ')', slot = rows.find((s) => Number(s.tier) === t);
    if (!slot) { empty.push(t); problems.push(where + ' is empty.'); continue; }
    const sg = slotGroup(slot, subs);
    if (!sg) { empty.push(t); problems.push(where + ': the suggestion in this slot is gone (deleted?). Put another category there.'); continue; }
    from.push(sg);
    const name = String(sg.name || '').trim(), g = sg.g, items = Array.isArray(g.items) ? g.items : [];
    if (!name) problems.push(where + ' has no category name.');
    const explanation = String(g.explanation || '').trim();
    if (!explanation) problems.push(where + ' (' + (name || 'unnamed') + ') has no explanation.');
    if (items.length !== 4) problems.push(where + ' (' + (name || 'unnamed') + ') has ' + items.length + ' clues instead of 4.');
    const out = { id: uniq('g-' + (slugify(name) || 'group'), gIds), name, tier: t, explanation, credit: sg.credit, items: [] };
    const art = (Array.isArray(g.article) ? g.article : []).filter((b) => b && (b.type === 'heading' || b.type === 'text') && String(b.text || '').trim());
    if (art.length) out.article = art.map((b) => ({ type: b.type, text: String(b.text) }));
    const nids = g.anki && Array.isArray(g.anki.nids) ? g.anki.nids.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0).map(Number) : [];
    if (nids.length) out.anki = nids;
    items.forEach((c, i) => {
      const label = String((c && c.label) || '').trim(), zone = String((c && c.zone) || ''), info = (c && c.info) || {}, scope = (c && c.scope) || {};
      if (!label) problems.push(where + ': clue ' + (i + 1) + ' has no label.');
      if (!ZONES.includes(zone)) problems.push(where + ': clue "' + (label || i + 1) + '" has an unknown place on the desk (' + (zone || 'none') + ').');
      const x = { id: uniq(slugify(label) || 'clue', iIds), label, zone };
      if (typeof info.text === 'string' && info.text.trim()) x.text = info.text.trim();
      if (typeof c.note === 'string' && c.note.trim()) x.note = c.note.trim();
      const pic = zone === 'rack' ? scope.image || info.image : (zone === 'photo' || zone === 'tubes') ? info.image : null, ref = imageRef(pic);
      if (ref) {
        const key = zone === 'rack' ? 'scope_image' : 'image', file = x.id + (zone === 'rack' ? '-scope.' : '-info.') + extOf(ref);
        if (ref.kind === 'url') problems.push(where + ': the picture for "' + label + '" is a link to another website (' + ref.value.slice(0, 80) + '). Upload it instead.');
        x[key] = file; images.push({ file, ref, item: x.id, label, tier: t });
      }
      if (typeof c.source === 'string' && c.source.trim()) x.source = c.source.trim();
      out.items.push(x);
    });
    groups.push(out);
  }
  // A whole puzzle sent in by one person: "Puzzle by ..." once, not on each group.
  let credit = null;
  if (from.length === 4 && from.every((x) => x.full && x.sid === from[0].sid) && from[0].credit) {
    credit = from[0].credit; groups.forEach((g) => { g.credit = null; });
  }
  const spec = { title: String(draft.title || '').trim(), id, date, credit, groups, empty };
  return { id, date, spec, images, problems };
}

/* ===== YAML (JSON strings are valid YAML double-quoted scalars) ===== */
const q = (v) => JSON.stringify(String(v == null ? '' : v));
function creditLines(c, pad) {
  return c ? [pad + 'credit:', pad + '  name: ' + q(c.name)].concat(c.line ? [pad + '  line: ' + q(c.line)] : []) : [];
}
/* opts: { header: [comment lines], draftId, imagesDir, imageNote(img) -> extra comment } */
export function specToYaml(s, opts) {
  const o = opts || {}, L = [];
  (o.header || []).forEach((h) => L.push(h ? '# ' + h : '#'));
  if (o.draftId) L.push('# workspace-draft: ' + o.draftId);
  L.push('', 'title: ' + q(s.title), 'id: ' + q(s.id), 'date: ' + q(s.date));
  if (o.imagesDir) L.push('images: ' + q(o.imagesDir));
  L.push(...creditLines(s.credit, ''), '', 'groups:');
  const byTier = new Map(s.groups.map((g) => [g.tier, g]));
  [1, 2, 3, 4].forEach((t) => {
    const g = byTier.get(t);
    if (!g) { L.push('  # tier ' + t + ' (' + TIER_WORD[t] + '): EMPTY'); return; }
    L.push('  - id: ' + q(g.id), '    name: ' + q(g.name), '    tier: ' + t + '  # ' + TIER_WORD[t], '    explanation: ' + q(g.explanation));
    L.push(...creditLines(g.credit, '    '));
    if (g.article) { L.push('    article:'); g.article.forEach((b) => L.push('      - type: ' + q(b.type), '        text: ' + q(b.text))); }
    if (g.anki) L.push('    anki: [' + g.anki.join(', ') + ']');
    L.push('    items:');
    g.items.forEach((x) => {
      L.push('      - id: ' + q(x.id), '        label: ' + q(x.label), '        zone: ' + q(x.zone));
      if (x.text) L.push('        text: ' + q(x.text));
      if (x.note) L.push('        note: ' + q(x.note));
      ['image', 'scope_image'].forEach((k) => {
        if (!x[k]) return;
        const extra = o.imageNote ? o.imageNote(x, k) : '';
        L.push('        ' + k + ': ' + q(x[k]) + (extra ? '  # ' + String(extra).replace(/\s+/g, ' ') : ''));
      });
      if (x.source) L.push('        source: ' + q(x.source));
    });
  });
  return L.join('\n') + '\n';
}
