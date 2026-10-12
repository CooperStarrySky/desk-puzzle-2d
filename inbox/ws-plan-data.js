/* Puzzle workspace: Planner data. Loads drafts, their slots, history and
   publish requests, plus every suggestion (the library), and saves changes.
   A library item is one category: a single-category suggestion (key = its id)
   or one of the four groups of a full-puzzle suggestion (key = "id:groupIndex").
   The database holds the rules (4 slots before Ready, owner in the group, no
   "published" from the website); this file only asks and reports. */
import { S, toast, plainError, isPuzzle, groupsOf, itemsOf } from './ws-core.js';
import { COLS } from './ws-suggest.js';

export const DSTATUS = { planning: 'Planning', ready: 'Ready', scheduled: 'Scheduled', published: 'Published' };
export const IMAGE_ZONES = ['rack', 'tubes', 'photo'];
const DCOLS = 'id, title, block, target_release, status, owner_email, notes, dismissed_warnings, published_puzzle_id, published_at, created_at, updated_at, updated_by';
export const PL = { drafts: [], slots: [], events: [], jobs: [], subs: new Map(), votes: new Map(), loaded: false, err: '', seq: 0 };

export async function loadPlanner() {
  const seq = ++PL.seq;
  try {
    const res = await Promise.all([
      S.sb.from('drafts').select(DCOLS).order('updated_at', { ascending: false }).limit(500),
      S.sb.from('draft_slots').select('draft_id, tier, submission_id, group_index, custom_group, placed_by, placed_at').limit(5000),
      S.sb.from('draft_events').select('id, draft_id, draft_title, actor_email, action, note, notify_email, at').order('at', { ascending: false }).limit(3000),
      S.sb.from('publish_jobs').select('id, draft_id, requested_by, requested_at, kind, state, step, error, finished_at').order('requested_at', { ascending: false }).limit(500),
      S.sb.from('submissions').select(COLS).order('created_at', { ascending: false }).limit(2000),
      S.sb.from('votes').select('submission_id, voter_email').limit(10000)]);
    const bad = res.find((r) => r.error);
    if (bad) throw bad.error;
    if (seq !== PL.seq) return;
    const [d, sl, ev, jb, su, vo] = res.map((r) => r.data || []);
    PL.drafts = d; PL.slots = sl; PL.events = ev; PL.jobs = jb;
    PL.subs = new Map(su.map((r) => [r.id, r]));
    PL.votes = new Map(); vo.forEach((v) => { if (!PL.votes.has(v.submission_id)) PL.votes.set(v.submission_id, []); PL.votes.get(v.submission_id).push(v.voter_email); });
    PL.err = ''; PL.loaded = true;
  } catch (e) { if (seq === PL.seq) PL.err = plainError(e); }
}
export const draftById = (id) => PL.drafts.find((d) => d.id === id) || null;
export const eventsOf = (id) => PL.events.filter((e) => e.draft_id === id);
export const latestJob = (id) => PL.jobs.find((j) => j.draft_id === id) || null;

/* ===== Library items ===== */
export const keyOf = (sid, gi) => (gi == null ? String(sid) : sid + ':' + gi);
function credit(r) { return r.credit_mode === 'named' && r.credit_name ? { name: r.credit_name, line: r.credit_line || '' } : null; }
function itemFrom(r, gi) {
  const g = gi == null ? (r.payload || {}) : (groupsOf(r)[gi] || {});
  return { key: keyOf(r.id, gi), sid: r.id, gi: gi == null ? null : gi, sub: r, kind: gi == null ? 'category' : 'group',
    name: String((gi == null ? r.group_name : g.name) || g.name || 'Untitled'), tier: Number(gi == null ? r.suggested_tier : g.tier) || 0,
    explanation: String(g.explanation || ''), items: itemsOf(g), article: g.article, anki: g.anki, credit: credit(r),
    status: r.status, created_at: r.created_at, shortAt: r.status === 'shortlisted' ? r.reviewed_at || '' : '',
    parent: gi == null ? '' : String(r.group_name || (r.payload && r.payload.title) || ''), tags: r.tags || [] };
}
export function itemByKey(key) {
  const [sid, gi] = String(key).split(':'); const r = PL.subs.get(sid);
  if (!r) return null;
  if (isPuzzle(r) !== (gi != null)) return null;
  return itemFrom(r, gi == null ? null : Number(gi));
}
/* Every placeable category: singles, plus each group of each full puzzle. */
export function libraryPool() {
  const out = [];
  PL.subs.forEach((r) => { if (isPuzzle(r)) groupsOf(r).forEach((g, i) => out.push(itemFrom(r, i))); else out.push(itemFrom(r, null)); });
  return out;
}
export const votesFor = (it) => PL.votes.get(it.sid) || [];
export const imageCount = (it) => it.items.filter((c) => IMAGE_ZONES.includes(c.zone)).length;

/* ===== Slots ===== */
/* [null, slot1, slot2, slot3, slot4]; each filled slot = { tier, row, item }. */
export function slotsOf(draftId) {
  const out = [null, null, null, null, null];
  PL.slots.filter((s) => s.draft_id === draftId).forEach((s) => {
    const item = s.custom_group ? Object.assign({ key: 'custom:' + s.tier, kind: 'custom', sid: null, gi: null, items: [], explanation: '', credit: null, status: 'shortlisted', tags: [] },
      s.custom_group, { items: itemsOf(s.custom_group), name: String(s.custom_group.name || 'Custom group') })
      : itemByKey(keyOf(s.submission_id, s.group_index));
    out[s.tier] = { tier: s.tier, row: s, item: item || { key: keyOf(s.submission_id, s.group_index), kind: 'missing', name: 'A suggestion you can’t see', items: [], explanation: '', credit: null, tags: [] } };
  });
  return out;
}
export const filledCount = (draftId) => PL.slots.filter((s) => s.draft_id === draftId).length;
export function tierOfKey(draftId, key) {
  const s = PL.slots.find((x) => x.draft_id === draftId && keyOf(x.submission_id, x.group_index) === key && x.submission_id);
  return s ? s.tier : 0;
}
/* Unpublished drafts (other than this one) that hold this item. */
export function otherDrafts(key, draftId) {
  const ids = new Set(PL.slots.filter((s) => s.submission_id && keyOf(s.submission_id, s.group_index) === key && s.draft_id !== draftId).map((s) => s.draft_id));
  return PL.drafts.filter((d) => ids.has(d.id) && d.status !== 'published');
}

/* ===== Saving ===== */
function fail(what, error) {
  const m = String((error && error.message) || error || '');
  const nice = error && error.code === '23505' ? (/publish_jobs/.test(m) ? 'A publish request for this draft is already waiting.' : 'That slot or suggestion changed meanwhile. Press Refresh and try again.')
    : plainError(error || 'no permission');
  toast(what + ': ' + nice, 6000);
  return false;
}
export async function createDraft(title, block) {
  const { data, error } = await S.sb.from('drafts').insert({ title, block: block || null }).select('id');
  if (error || !data || !data[0]) return fail('Could not make the draft', error);
  return data[0].id;
}
export async function patchDraft(id, patch, what) {
  const { data, error } = await S.sb.from('drafts').update(patch).eq('id', id).select('id');
  if (error || !data || !data.length) return fail(what || 'Could not save that', error);
  return true;
}
/* Put a library item in a tier. Already in this draft -> move (or swap). Tier taken -> replace. */
export async function placeItem(draftId, tier, key) {
  const from = tierOfKey(draftId, key);
  if (from) return from === tier ? true : moveSlot(draftId, from, tier);
  const [sid, gi] = key.split(':');
  const row = { submission_id: sid, group_index: gi == null ? null : Number(gi), custom_group: null };
  const taken = PL.slots.some((s) => s.draft_id === draftId && s.tier === tier);
  const { error } = taken ? await S.sb.from('draft_slots').update(row).eq('draft_id', draftId).eq('tier', tier).select('tier')
    : await S.sb.from('draft_slots').insert(Object.assign({ draft_id: draftId, tier }, row)).select('tier');
  return error ? fail('Could not place it', error) : true;
}
/* Slot a -> tier b: a plain move into an empty tier, or a swap through the database. */
export async function moveSlot(draftId, a, b) {
  if (a === b) return true;
  const taken = PL.slots.some((s) => s.draft_id === draftId && s.tier === b);
  const { error } = taken ? await S.sb.rpc('swap_draft_slots', { p_draft_id: draftId, p_tier_a: a, p_tier_b: b })
    : await S.sb.from('draft_slots').update({ tier: b }).eq('draft_id', draftId).eq('tier', a).select('tier');
  return error ? fail(taken ? 'Could not swap them' : 'Could not move it', error) : true;
}
export async function removeSlot(draftId, tier) {
  const { error } = await S.sb.from('draft_slots').delete().eq('draft_id', draftId).eq('tier', tier).select('tier');
  return error ? fail('Could not take it out', error) : true;
}
export async function requestPublish(draftId) {
  const { error } = await S.sb.from('publish_jobs').insert({ draft_id: draftId, kind: 'now' }).select('id');
  return error ? fail('Could not ask to publish', error) : true;
}
