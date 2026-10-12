/* Puzzle workspace: the Activity tab. Everything the group did, newest first,
   grouped by day, from the database's "activity" list. Lines meant for you
   (notify_email = you, e.g. your draft lost a category) are highlighted. */
import { S, $, $$, esc, lc, busy, toast, plainError, when, ago, dayKey, fmtDay, av, person } from './ws-core.js';

const TYPES = { submit: 'Sent in', shortlist: 'Shortlists', decline: 'Declines', restore: 'Back to new', used: 'Used', vote: '👍',
  comment: 'Comments', draft: 'Planner', schedule: 'Scheduling', publish: 'Published' };
const TYPE_OF = { submitted: 'submit', shortlist: 'shortlist', decline: 'decline', reopen: 'restore', used: 'used', vote: 'vote', unvote: 'vote',
  comment: 'comment', schedule: 'schedule', unschedule: 'schedule', publish: 'publish', publish_requested: 'publish' };
const SUB_SAID = { submitted: 'sent in', shortlist: 'shortlisted', decline: 'declined', reopen: 'moved back to New', used: 'marked as used',
  comment: 'commented on', vote: 'gave 👍 to', unvote: 'took back their 👍 on', add_to_draft: 'put in a draft:', remove_from_draft: 'took out of a draft:', publish: 'published' };
const DRAFT_SAID = { create: 'made the draft', rename: 'renamed the draft', status: 'changed the status of', schedule: 'scheduled', unschedule: 'unscheduled',
  deleted: 'deleted the draft', comment: 'commented on the draft', lost_slot: 'took a category from', reverted: 'reverted', publish_requested: 'asked to publish', publish: 'published' };
const A = { list: null, who: '', type: '', err: '', onCounts: () => {} };

export async function loadActivity() {
  const { data, error } = await S.sb.from('activity')
    .select('at, actor_email, subject, action, note, submission_id, draft_id, subject_name, notify_email').order('at', { ascending: false }).limit(500);
  if (error) { A.err = plainError(error); return false; }
  A.list = data || []; A.err = ''; A.onCounts(); return true;
}
/* Tab count: things meant for you in the last week. */
export function activityCount() {
  if (!A.list) return 0;
  const week = Date.now() - 7 * 864e5;
  return A.list.filter((a) => lc(a.notify_email) === S.me && new Date(a.at).getTime() > week).length;
}
const typeOf = (a) => (a.subject === 'draft' && !['schedule', 'unschedule', 'publish', 'publish_requested'].includes(a.action) ? 'draft' : TYPE_OF[a.action] || 'draft');

function lineHtml(a) {
  const mine = lc(a.notify_email) === S.me, name = esc(a.subject_name || 'a suggestion');
  const who = a.actor_email ? esc(person(a.actor_email).name) : a.subject === 'submission' ? 'A student' : 'The publishing robot';
  const subj = a.subject === 'submission' && a.submission_id ? '<a href="#s=' + encodeURIComponent(a.submission_id) + '">' + name + '</a>'
    : a.subject === 'draft' && a.draft_id && a.action !== 'deleted' ? '<a href="#/planner/' + encodeURIComponent(a.draft_id) + '">' + name + '</a>' : '<b>' + name + '</b>';
  const said = esc((a.subject === 'submission' ? SUB_SAID : DRAFT_SAID)[a.action] || a.action.replace(/_/g, ' '));
  const note = a.note && ['decline', 'comment', 'lost_slot', 'reverted', 'rename', 'status'].includes(a.action) ? ': <q>' + esc(a.note) + '</q>' : '';
  return '<li' + (mine ? ' class="notify"' : '') + '>' + av(a.actor_email, 1) + '<p class="what">' + (mine ? '<span class="for-you">For you</span>' : '') +
    '<b>' + who + '</b> ' + said + ' ' + subj + note + '</p><span class="when" title="' + esc(when(a.at)) + '">' + esc(ago(a.at)) + '</span></li>';
}
function renderFeed() {
  const list = (A.list || []).filter((a) => {
    if (A.type && typeOf(a) !== A.type) return false;
    if (A.who === 'ext') return !a.actor_email;
    return !A.who || lc(a.actor_email) === A.who;
  });
  $('#af-n').textContent = A.err ? '' : list.length + (list.length === 1 ? ' event' : ' events');
  if (A.err) { $('#feed').innerHTML = '<li class="day"><p class="err-box">' + esc(A.err) + '</p></li>'; return; }
  const today = dayKey(new Date().toISOString());
  let day = '', html = '';
  list.forEach((a) => {
    const d = dayKey(a.at);
    if (d !== day) { day = d; html += '<li class="day"><span class="eyebrow">' + (d === today ? 'Today · ' : '') + esc(fmtDay(a.at)) + '</span></li>'; }
    html += lineHtml(a);
  });
  $('#feed').innerHTML = html || '<li class="day"><p class="empty">Nothing here for these filters.</p></li>';
}
function renderView() {
  const people = Array.from(S.people.keys()).map((e) => [e, person(e).name]).sort((a, b) => a[1].localeCompare(b[1]));
  const n = activityCount();
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Activity</p><h1>What the group did</h1></div>' +
    '<div class="row" style="--gap:8px"><label class="sr" for="af-who">Person</label><select class="input" id="af-who" style="width:auto"><option value="">Everyone</option>' +
    people.map((p) => '<option value="' + esc(p[0]) + '"' + (A.who === p[0] ? ' selected' : '') + '>' + esc(p[1]) + (p[0] === S.me ? ' (you)' : '') + '</option>').join('') +
    '<option value="ext"' + (A.who === 'ext' ? ' selected' : '') + '>Students (sent in)</option></select>' +
    '<button class="btn" type="button" id="af-refresh">Refresh</button></div></div>' +
    (n ? '<p class="notify-banner">' + n + (n === 1 ? ' thing' : ' things') + ' this week ' + (n === 1 ? 'is' : 'are') + ' meant for you. They’re highlighted below.</p>' : '') +
    '<div class="chips" style="margin-bottom:12px" role="group" aria-label="Filter by type"><button type="button" class="chip" data-at="" aria-pressed="' + !A.type + '">All</button>' +
    Object.keys(TYPES).map((k) => '<button type="button" class="chip" data-at="' + k + '" aria-pressed="' + (A.type === k) + '">' + esc(TYPES[k]) + '</button>').join('') + '</div>' +
    '<p class="result-n" id="af-n" aria-live="polite"></p><ul class="feed panel" id="feed"></ul>';
  $('#af-who').addEventListener('change', (e) => { A.who = e.target.value; renderFeed(); });
  $$('[data-at]').forEach((b) => b.addEventListener('click', () => {
    A.type = b.dataset.at; $$('[data-at]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderFeed();
  }));
  $('#af-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => {
    if (await loadActivity()) toast('Up to date'); renderFeed();
  }));
  renderFeed();
}
export async function showActivity() {
  const first = !A.list;
  renderView();
  if (!first) { loadActivity().then(() => { if ($('#feed')) renderFeed(); }); return; }
  $('#feed').innerHTML = '<li class="day"><p class="muted">Loading…</p></li>';
  await loadActivity();
  if ($('#feed')) renderView(); // still on this tab
}
export function initActivity(onCounts) { A.onCounts = onCounts; }
export function resetActivity() { Object.assign(A, { list: null, who: '', type: '', err: '' }); }
