/* Puzzle workspace: the Activity tab. Everything your school did (the site
   owner: every school), newest first, grouped by day, from the database's
   "activity" list; the row rules decide what each reader gets. A run of
   events by the same person on the same draft (or category) on the same day
   collapses into one line with "Show all". Type chips: Submissions, Drafts,
   Comments, Publishing, Admin. The tab badge counts what is new since your
   last visit (remembered on this device). Lines meant for you
   (notify_email = you) are highlighted. */
import { S, $, $$, esc, lc, busy, toast, plainError, when, ago, dayKey, fmtDay, av, person, schName, prefGet, prefSet } from './ws-core.js';

const GROUPS = { sub: 'Submissions', draft: 'Drafts', comment: 'Comments', publish: 'Publishing', admin: 'Admin' };
const SUB_GROUP = { submitted: 'sub', comment: 'comment', vote: 'comment', unvote: 'comment', add_to_draft: 'draft', remove_from_draft: 'draft', adapt: 'draft',
  edit: 'draft', undo_edit: 'draft', used: 'publish', publish: 'publish', trash: 'admin', restore: 'admin', decline: 'admin', reopen: 'admin', shortlist: 'admin' };
const DRAFT_GROUP = { comment: 'comment', schedule: 'publish', unschedule: 'publish', publish_requested: 'publish', publish: 'publish', approve: 'publish', unapprove: 'publish' };
const SUB_SAID = { submitted: 'sent in', shortlist: 'shortlisted', decline: 'declined', reopen: 'moved back to New', used: 'marked as used',
  comment: 'commented on', vote: 'gave 👍 to', unvote: 'took back their 👍 on', add_to_draft: 'put in a draft:', remove_from_draft: 'took out of a draft:', publish: 'published',
  trash: 'moved to Trash', restore: 'restored from Trash', edit: 'fixed the original of', undo_edit: 'undid a fix to', adapt: 'adapted' };
const DRAFT_SAID = { create: 'made the draft', rename: 'renamed the draft', status: 'changed the status of', schedule: 'scheduled', unschedule: 'unscheduled',
  deleted: 'deleted the draft', comment: 'commented on the draft', lost_slot: 'took a category from', reverted: 'reverted', publish_requested: 'asked to publish',
  publish: 'published', approve: 'gave faculty approval to', unapprove: 'took back faculty approval of' };
const MEMBER_SAID = { member_add: 'added', member_role: 'changed the role of', member_move: 'moved', member_remove: 'removed the access of', member_restore: 'gave back access to' };
const NOTE_FOR = ['decline', 'trash', 'comment', 'lost_slot', 'reverted', 'rename', 'status', 'adapt', 'add_to_draft', 'remove_from_draft', 'member_role', 'member_move'];
const A = { list: null, who: '', type: '', err: '', seenAt: '', open: new Set(), onCounts: () => {} };

const seenKey = () => 'dp2d:ws-act-seen:' + (S.me || '');
/* When I last opened the tab (first time ever: a week ago). */
function lastSeen() { return prefGet(seenKey()) || new Date(Date.now() - 7 * 864e5).toISOString(); }
export async function loadActivity() {
  const { data, error } = await S.sb.from('activity')
    .select('at, actor_email, subject, action, note, submission_id, draft_id, subject_name, notify_email, school').order('at', { ascending: false }).limit(500);
  if (error) { A.err = plainError(error); return false; }
  A.list = data || []; A.err = ''; A.onCounts(); return true;
}
/* Tab badge: other people's events since my last visit. */
export function activityCount() {
  if (!A.list) return 0;
  const since = lastSeen();
  return A.list.filter((a) => a.at > since && lc(a.actor_email) !== S.me).length;
}
export const groupOf = (a) => (a.subject === 'member' ? 'admin' : a.subject === 'submission' ? SUB_GROUP[a.action] || 'sub' : DRAFT_GROUP[a.action] || 'draft');
/* Same person, same draft (or category), same group, same day: one line. */
const runKey = (a) => [lc(a.actor_email), a.draft_id || a.submission_id || a.subject_name, groupOf(a), dayKey(a.at)].join('|');

function subjHtml(a) {
  const name = esc(a.subject_name || 'a suggestion');
  if (a.subject === 'member') return '<b>' + esc(person(a.subject_name).name) + '</b>';
  if (a.subject === 'submission' && a.submission_id) return '<a href="#/categories/' + encodeURIComponent(a.submission_id) + '">' + name + '</a>';
  if (a.subject === 'draft' && a.draft_id && a.action !== 'deleted') return '<a href="#/planner/' + encodeURIComponent(a.draft_id) + '">' + name + '</a>';
  return '<b>' + name + '</b>';
}
function said(a) {
  const words = a.subject === 'member' ? MEMBER_SAID : a.subject === 'submission' ? SUB_SAID : DRAFT_SAID;
  const note = a.note && NOTE_FOR.includes(a.action) ? ': <q>' + esc(a.note) + '</q>' : '';
  return esc(words[a.action] || String(a.action).replace(/_/g, ' ')) + ' ' + subjHtml(a) + note;
}
function runText(r) {
  const a = r[0];
  if (r.every((x) => x.subject === 'submission' && x.action === 'add_to_draft') && a.draft_id) {
    const m = r.map((x) => /^added to draft (.+) as \w+$/.exec(x.note || '')).find(Boolean);
    return 'put ' + r.length + ' categories in <a href="#/planner/' + encodeURIComponent(a.draft_id) + '">' + esc(m ? m[1] : 'a draft') + '</a>';
  }
  return said(a) + ' and ' + (r.length - 1) + ' more like ' + (r.length === 2 ? 'it' : 'them');
}
function renderFeed() {
  const list = (A.list || []).filter((a) => {
    if (A.type && groupOf(a) !== A.type) return false;
    if (A.who === 'ext') return !a.actor_email;
    return !A.who || lc(a.actor_email) === A.who;
  });
  const runs = [];
  list.forEach((a) => { const r = runs[runs.length - 1]; if (r && a.actor_email && runKey(r[0]) === runKey(a)) r.push(a); else runs.push([a]); });
  $('#af-n').textContent = A.err ? '' : list.length + (list.length === 1 ? ' event' : ' events') + (runs.length < list.length ? ' in ' + runs.length + ' lines' : '');
  if (A.err) { $('#feed').innerHTML = '<li class="day"><p class="err-box">' + esc(A.err) + '</p></li>'; return; }
  const today = dayKey(new Date().toISOString());
  let day = '', html = '';
  runs.forEach((r, i) => {
    const a = r[0], d = dayKey(a.at), mine = r.some((x) => lc(x.notify_email) === S.me), fresh = A.seenAt && a.at > A.seenAt && lc(a.actor_email) !== S.me;
    const who = a.actor_email ? esc(person(a.actor_email).name) : a.subject === 'submission' ? 'A student' : 'The publishing robot', k = runKey(a) + '|' + a.at, open = A.open.has(k);
    if (d !== day) { day = d; html += '<li class="day"><span class="eyebrow">' + (d === today ? 'Today · ' : '') + esc(fmtDay(a.at)) + '</span></li>'; }
    html += '<li class="' + [mine ? 'notify' : '', fresh ? 'fresh' : ''].join(' ').trim() + '"' + (r.length > 1 ? ' data-run="' + r.length + '"' : '') + '>' + av(a.actor_email, 1) +
      '<div class="what">' + (mine ? '<span class="for-you">For you</span>' : '') + (S.owner && a.school ? '<span class="to-sch">' + esc(schName(a.school)) + '</span> ' : '') + '<b>' + who + '</b> ' +
      (r.length === 1 ? said(a) : runText(r) + ' <button type="button" class="linkish run-tg" data-rk="' + esc(k) + '" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Show all ' + r.length) + '</button>' +
        (open ? '<ul class="run">' + r.map((x) => '<li>' + said(x) + ' <span class="faint">' + esc(ago(x.at)) + '</span></li>').join('') + '</ul>' : '')) +
      (fresh ? ' <span class="new-dot">new</span>' : '') + '</div><span class="when" title="' + esc(when(a.at)) + '">' + esc(ago(a.at)) + '</span></li>';
  });
  $('#feed').innerHTML = html || '<li class="day"><p class="empty">Nothing here for these filters.</p></li>';
}
function renderView() {
  const people = Array.from(S.people.keys()).map((e) => [e, person(e).name]).sort((a, b) => a[1].localeCompare(b[1]));
  const n = (A.list || []).filter((a) => lc(a.notify_email) === S.me && Date.now() - new Date(a.at).getTime() < 7 * 864e5).length;
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Activity</p><h1>What the group did</h1></div>' +
    '<div class="row" style="--gap:8px"><label class="sr" for="af-who">Person</label><select class="input" id="af-who" style="width:auto"><option value="">Everyone</option>' +
    people.map((p) => '<option value="' + esc(p[0]) + '"' + (A.who === p[0] ? ' selected' : '') + '>' + esc(p[1]) + (p[0] === S.me ? ' (you)' : '') + '</option>').join('') +
    '<option value="ext"' + (A.who === 'ext' ? ' selected' : '') + '>Students (sent in)</option></select>' +
    '<button class="btn" type="button" id="af-refresh">Refresh</button></div></div>' +
    (n ? '<p class="notify-banner">' + n + (n === 1 ? ' thing' : ' things') + ' this week ' + (n === 1 ? 'is' : 'are') + ' meant for you. They’re highlighted below.</p>' : '') +
    '<div class="chips af-chips" role="group" aria-label="Filter by type"><button type="button" class="chip" data-at="" aria-pressed="' + !A.type + '">All</button>' +
    Object.keys(GROUPS).map((k) => '<button type="button" class="chip" data-at="' + k + '" aria-pressed="' + (A.type === k) + '">' + esc(GROUPS[k]) + '</button>').join('') + '</div>' +
    '<p class="result-n" id="af-n" aria-live="polite"></p><ul class="feed panel" id="feed"></ul>';
  $('#af-who').addEventListener('change', (e) => { A.who = e.target.value; renderFeed(); });
  $$('[data-at]').forEach((b) => b.addEventListener('click', () => {
    A.type = b.dataset.at; $$('[data-at]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderFeed();
  }));
  $('#feed').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rk]'); if (!b) return;
    const k = b.dataset.rk; if (A.open.has(k)) A.open.delete(k); else A.open.add(k);
    renderFeed(); const nb = $('[data-rk="' + CSS.escape(k) + '"]'); if (nb) nb.focus();
  });
  $('#af-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => {
    if (await loadActivity()) toast('Up to date'); renderFeed();
  }));
  renderFeed();
}
/* Opening the tab: highlight what's new since the last visit, then mark it all seen. */
function markSeen() {
  A.seenAt = lastSeen();
  prefSet(seenKey(), new Date().toISOString()); A.onCounts();
}
export async function showActivity() {
  const first = !A.list;
  if (!first) { markSeen(); renderView(); loadActivity().then(() => { if ($('#feed')) renderFeed(); }); return; }
  renderView();
  $('#feed').innerHTML = '<li class="day"><p class="muted">Loading…</p></li>';
  await loadActivity();
  markSeen();
  if ($('#feed')) renderView(); // still on this tab
}
export function initActivity(onCounts) { A.onCounts = onCounts; }
export function resetActivity() { Object.assign(A, { list: null, who: '', type: '', err: '', seenAt: '' }); A.open.clear(); }
