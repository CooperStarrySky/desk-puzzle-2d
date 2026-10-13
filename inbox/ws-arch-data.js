/* Puzzle workspace: Archive data. Published puzzles come from the site's own
   files (puzzles/index.json + each puzzle); class numbers from puzzle_stats.
   The category bank = every category ever sent in (each single suggestion and
   each group of a full-puzzle suggestion) plus every published category that
   no suggestion accounts for (older puzzles built by hand). A suggestion is
   "used" only when it really was: it sat in a slot of a published draft, or
   its own used_in names the puzzle. Names only merge published hand-made
   groups with each other (the same category in two old puzzles = used 2x);
   a never-used suggestion that shares a name with a used category gets a
   hint ("Same name as a used category") instead of a count.
   School: a missing value means CMSRU (lead, 2026-10-12: B5's publish step
   will write "school" into index.json entries; keep this fallback; school is
   not settable from the site for now). */
import { S, lc, toast, plainError } from './ws-core.js';
import { PL, loadPlanner, libraryPool, keyOf, placeItem, votesFor } from './ws-plan-data.js';
import { ARCH, loadArchive } from './ws-plan-checks.js';

export const SCHOOLS = { cmsru: 'CMSRU' };
export const schoolName = (c) => SCHOOLS[c] || String(c || 'cmsru').toUpperCase();
export const norm = (s) => lc(s).replace(/[^a-z0-9]+/g, ' ').trim();
export const AR = { stats: new Map(), statsErr: '', schools: new Map(), loaded: false };
export const BANK = { puzzles: [], cats: [], byKey: new Map() };

/* The extras: class totals and each row's school (the column may not exist yet). */
async function loadExtras() {
  const safe = (q) => Promise.resolve(q).then((r) => r, (e) => ({ data: null, error: e }));
  const [st, ss] = await Promise.all([
    safe(S.sb.from('puzzle_stats').select('puzzle_id, plays, std_finishes, std_wins, mistakes_hist, hint_any, rating_n, rating_hist, updated_at').limit(1000)),
    safe(S.sb.from('submissions').select('id, school').limit(5000))]);
  AR.statsErr = st.error ? plainError(st.error) : '';
  AR.stats = new Map(((!st.error && st.data) || []).map((r) => [r.puzzle_id, r]));
  AR.schools = new Map(((!ss.error && ss.data) || []).map((r) => [r.id, String(r.school || 'cmsru')]));
}
export async function loadBank() {
  await Promise.all([loadPlanner(), loadArchive(), loadExtras()]);
  build(); AR.loaded = true;
}

const hay = (r) => [r.name, r.explanation].concat(r.items.map((c) => [c.label, c.info && c.info.title, c.info && c.info.text].join(' '))).join('\n').toLowerCase();
function build() {
  const pub = PL.drafts.filter((d) => d.status === 'published' && d.published_puzzle_id);
  const P = ARCH.list.map((p) => Object.assign({}, p, { drafts: pub.filter((d) => d.published_puzzle_id === p.id), stats: AR.stats.get(p.id) || null, cats: [] }));
  const byId = new Map(P.map((p) => [p.id, p])), claimed = new Map(), cats = [];
  const groupOf = (p, nm, tier) => { const g = p.full.find((x) => norm(x.name) === nm) || (tier ? p.full.find((x) => x.tier === tier) : null); return g ? g.gi : null; };
  const use = (row, p, gi) => {
    if (!row.uses.has(p.id) || row.uses.get(p.id) == null) row.uses.set(p.id, gi);
    if (gi != null && !claimed.has(p.id + '#' + gi)) claimed.set(p.id + '#' + gi, row);
  };
  libraryPool().forEach((it) => {
    const nm = norm(it.name);
    const row = { key: it.key, it, name: it.name, tier: it.tier, explanation: it.explanation, items: it.items, credit: it.credit, tags: it.tags.slice(),
      school: AR.schools.get(it.sid) || String(it.sub.school || 'cmsru'), status: it.status, date: it.created_at, votes: votesFor(it).length, uses: new Map(), parent: it.parent };
    PL.slots.forEach((s) => {
      if (!s.submission_id || keyOf(s.submission_id, s.group_index) !== it.key) return;
      const d = pub.find((x) => x.id === s.draft_id), p = d && byId.get(d.published_puzzle_id);
      if (p) use(row, p, groupOf(p, nm, s.tier));
    });
    // category_uses (multischool): every puzzle that published this category, including imported ones.
    // (Matched by name, else by 2+ shared clue labels, since names can change at build time.)
    (PL.uses.get(it.sid) || []).forEach((x) => {
      const p = byId.get(x.puzzle_id); if (!p || row.uses.has(p.id)) return;
      let gi = groupOf(p, nm, 0);
      if (gi == null) { const mine = it.items.map((c) => norm(c.label)), g = p.full.find((f) => f.items.filter((c) => mine.includes(norm(c.label))).length >= 2); gi = g ? g.gi : null; }
      if (gi != null) use(row, p, gi);
    });
    const u = it.sub.used_in && byId.get(it.sub.used_in);
    if (u && !row.uses.has(u.id)) { const gi = groupOf(u, nm, 0); if (gi != null || it.gi == null) use(row, u, gi); }
    cats.push(row);
  });
  const byName = new Map();
  P.forEach((p) => p.full.forEach((g) => {
    if (claimed.has(p.id + '#' + g.gi)) return;
    const nm = norm(g.name); let row = byName.get(nm);
    if (!row) {
      row = { key: 'pub:' + p.id + ':' + g.gi, it: null, name: g.name, tier: g.tier, explanation: g.explanation, items: g.items, credit: g.credit, tags: [],
        school: p.school, status: 'used', date: p.date, votes: 0, uses: new Map(), src: { p, g }, parent: '' };
      byName.set(nm, row); cats.push(row);
    }
    use(row, p, g.gi);
  }));
  cats.forEach((r) => {
    const ps = Array.from(r.uses.keys()).map((id) => byId.get(id)).sort((a, b) => (a.date < b.date ? 1 : -1));
    r.usedIn = ps; r.usedN = ps.length; r.last = ps.length ? ps[0].date : '';
    const g = ps.length && r.uses.get(ps[0].id) != null ? ps[0].full[r.uses.get(ps[0].id)] : null;
    if (g && g.tier) r.tier = g.tier;
    ps.forEach((p) => p.drafts.forEach((d) => { if (d.block && !r.tags.includes(d.block)) r.tags.push(d.block); }));
    // The search also finds a category by the name and clues it was published with (names can change at build time).
    r.hay = hay(r) + ps.map((p) => { const x = r.uses.get(p.id); return x == null ? '' : '\n' + hay(p.full[x]); }).join('');
  });
  // Never-used suggestion, same name as a used category: a hint, not a count.
  const usedByName = new Map(); cats.forEach((r) => { if (r.usedN && !usedByName.has(norm(r.name))) usedByName.set(norm(r.name), r); });
  cats.forEach((r) => { const u = r.it && !r.usedN ? usedByName.get(norm(r.name)) : null; r.same = u ? { name: u.name, n: u.usedN, key: u.key } : null; });
  P.forEach((p) => {
    p.cats = p.full.map((g) => claimed.get(p.id + '#' + g.gi) || null);
    p.blocks = []; p.drafts.forEach((d) => { if (d.block && !p.blocks.includes(d.block)) p.blocks.push(d.block); });
    p.cats.forEach((r) => r && r.tags.forEach((t) => { if (!p.blocks.includes(t)) p.blocks.push(t); }));
    const em = []; p.drafts.forEach((d) => { [d.owner_email].concat(PL.slots.filter((s) => s.draft_id === d.id).map((s) => s.placed_by)).forEach((e) => { if (e && !em.includes(lc(e))) em.push(lc(e)); }); });
    p.people = em;
    const names = []; const add = (c) => { const n = c && c.name && String(c.name).trim(); if (n && !names.includes(n)) names.push(n); };
    add(p.credit); p.full.forEach((g, i) => add(g.credit || (p.cats[i] && p.cats[i].it && p.cats[i].credit)));
    p.credits = names;
  });
  BANK.puzzles = P.sort((a, b) => (a.date < b.date ? 1 : -1)); BANK.cats = cats; BANK.byKey = new Map(cats.map((r) => [r.key, r]));
}

/* ===== Making drafts from the archive ===== */
const PIC = /^(data:|https?:|blob:)/;
/* A published group as a custom slot: site images become full links; images stored inside the puzzle file stay there. */
export function customFrom(p, g) {
  const abs = (v) => new URL('../' + String(v).replace(/^\/+/, ''), location.href).href;
  const items = g.items.map((c) => {
    const x = { label: c.label, zone: c.zone }, info = c.info ? Object.assign({}, c.info) : null, scope = c.scope ? Object.assign({}, c.scope) : null;
    let inside = false;
    [info, scope].forEach((o) => { if (!o || !o.image) return; if (/^data:/.test(o.image)) { delete o.image; inside = true; } else if (!PIC.test(o.image)) o.image = abs(o.image); });
    if (info) x.info = info; if (scope && scope.image) x.scope = scope;
    if (c.labelScale) x.labelScale = c.labelScale;
    if (inside) x.note = 'The image for this clue is inside the published puzzle “' + p.title + '”.';
    return x;
  });
  const cg = { name: g.name, tier: g.tier, explanation: g.explanation, items, credit: g.credit || null, anki: g.anki || null, article: g.article || [], from: { puzzle: p.id, group: g.id || String(g.gi) } };
  if (JSON.stringify(cg).length > 90000) cg.article = [];
  return cg;
}
async function putCustom(draftId, tier, cg) {
  const taken = PL.slots.some((s) => s.draft_id === draftId && s.tier === tier);
  const row = { submission_id: null, group_index: null, custom_group: cg };
  const { error } = taken ? await S.sb.from('draft_slots').update(row).eq('draft_id', draftId).eq('tier', tier).select('tier')
    : await S.sb.from('draft_slots').insert(Object.assign({ draft_id: draftId, tier }, row)).select('tier');
  if (error) { toast('Could not place it: ' + plainError(error), 6000); return false; }
  return true;
}
/* A bank row into a draft's tier: a suggestion goes in as itself, a hand-made published group as a copy. */
export async function useInDraft(row, draftId, tier) {
  if (row.it) return placeItem(draftId, tier, row.it.key);
  return putCustom(draftId, tier, customFrom(row.src.p, row.src.g));
}
export async function newDraft(title, block, notes) {
  const { data, error } = await S.sb.from('drafts').insert({ title, block: block || null, notes: notes || null }).select('id');
  if (error || !data || !data[0]) { toast('Could not make the draft: ' + plainError(error || 'no permission'), 6000); return null; }
  return data[0].id;
}
