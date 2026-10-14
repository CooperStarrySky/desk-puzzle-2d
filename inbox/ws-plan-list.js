/* Puzzle workspace: the Planner's list of drafts, and "New draft". */
import { S, $, $$, esc, busy, toast, openModal, av, person, ago, schName, schFull, TIER_WORDS } from './ws-core.js';
import { sealHtml } from './ws-plan-seal.js';
import { BLOCKS } from './ws-suggest.js';
import { PL, DSTATUS, slotsOf, latestJob, createDraft, loadPlanner } from './ws-plan-data.js';
import { releaseLabel, etToIso } from './ws-plan-time.js';

const ORDER = { ready: 0, planning: 1, scheduled: 2, published: 3 };
/* Draft list view state: sort (date | status | title) and, for the site owner, a school filter. */
export const DL = { sort: 'date', school: '' };
/* Schools I can make drafts for: all of them for the site owner, else where I'm a lead or admin. */
export const planSchools = () => (S.owner ? Array.from(S.schools.keys()) : Object.keys(S.roles).filter((k) => ['lead', 'admin'].includes(S.roles[k])));
export function draftWhen(d) {
  if (d.status === 'scheduled') return 'Goes live ' + releaseLabel(d.target_release);
  if (d.status === 'published') return 'Published' + (d.published_at ? ' ' + ago(d.published_at) : '');
  return d.target_release ? 'Target ' + releaseLabel(d.target_release) : 'No release date yet';
}
const whenIso = (d) => (d.status === 'published' ? d.published_at : d.target_release) || '';
/* Release (or target) date first, undated last, published at the bottom. */
function sortDrafts(a, b) {
  if (DL.sort === 'title') return a.title.localeCompare(b.title);
  if (DL.sort === 'status') return ORDER[a.status] - ORDER[b.status] || a.title.localeCompare(b.title);
  const pa = a.status === 'published', pb = b.status === 'published'; if (pa !== pb) return pa ? 1 : -1;
  const x = whenIso(a), y = whenIso(b); if (!x !== !y) return x ? -1 : 1;
  return (pa ? (x < y ? 1 : x > y ? -1 : 0) : (x < y ? -1 : x > y ? 1 : 0)) || a.title.localeCompare(b.title);
}
function cardHtml(d) {
  const sl = slotsOf(d.id), n = sl.filter(Boolean).length, job = latestJob(d.id);
  const jw = !job || d.status === 'published' ? '' : { queued: 'Publish queued', running: 'Publishing…', failed: 'Publishing failed' }[job.state] || '';
  return '<a class="draft-card" href="#/planner/' + encodeURIComponent(d.id) + '" data-did="' + esc(d.id) + '"><div class="row spread"><span class="st st-' + esc(d.status) + '">' + esc(DSTATUS[d.status] || d.status) + '</span>' +
    '<span class="muted dc-when">' + (d.status === 'ready' && !d.target_release ? '<span class="nudge">Needs a date</span>' : esc(draftWhen(d))) + '</span></div>' +
    '<h3>' + esc(d.title) + '</h3><div class="row dc-tags" style="--gap:6px">' + (S.owner ? '<span class="to-sch">' + esc(schName(d.school)) + '</span>' : '') +
    (d.block ? '<span class="tagchip">' + esc(d.block) + '</span>' : '') + sealHtml(d, 'sm') + '</div>' +
    '<div class="minislots" aria-hidden="true">' + [1, 2, 3, 4].map((t) => '<span class="t' + t + (sl[t] ? '' : ' off') + '"></span>').join('') + '</div>' +
    '<p class="muted dc-names">' + [1, 2, 3, 4].map((t) => (sl[t] ? esc(sl[t].item.name) + (sl[t].item.adapted ? ' <span class="faint">(adapted)</span>' : '') : '<i>' + TIER_WORDS[t] + ' empty</i>')).join(' · ') + '</p>' +
    '<div class="row spread"><span class="row" style="--gap:6px">' + av(d.owner_email) + '<span class="dc-owner">Owner: ' + esc(person(d.owner_email).name) + '</span></span>' +
    '<span class="fill-n">' + n + '/4 slots' + (jw ? ' · <b class="jw jw-' + esc(job.state) + '">' + jw + '</b>' : '') + '</span></div></a>';
}
function privacyHtml() {
  if (!S.owner) return '<p class="priv-note" id="priv-note">🔒 Only ' + esc(Object.keys(S.roles).map(schFull).join(' and ') || 'your school') + ' can see these drafts. Other schools’ drafts never show here.</p>';
  const schools = Array.from(new Set(PL.drafts.map((d) => d.school))).sort();
  return '<div class="row priv-note" id="priv-note" style="--gap:8px"><span>Site owner view: every school’s drafts.</span><span class="chips" role="group" aria-label="Filter drafts by school">' +
    [['', 'All schools']].concat(schools.map((k) => [k, schFull(k)])).map((o) => '<button type="button" class="chip" data-psch="' + esc(o[0]) + '" aria-pressed="' + (DL.school === o[0]) + '">' + esc(o[1]) +
      ' <span class="n">' + PL.drafts.filter((d) => !o[0] || d.school === o[0]).length + '</span></button>').join('') + '</span></div>';
}
export function renderDraftList() {
  const list = PL.drafts.filter((d) => !S.owner || !DL.school || d.school === DL.school).sort(sortDrafts), canNew = planSchools().length > 0;
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Planner</p><h1>Puzzle drafts</h1></div>' +
    '<div class="row" style="--gap:8px"><label class="sr" for="dsort">Sort drafts</label><select class="input" id="dsort">' +
    [['date', 'Release date (undated last)'], ['status', 'Status'], ['title', 'Title A–Z']].map((o) => '<option value="' + o[0] + '"' + (DL.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
    '<button class="btn" type="button" id="pl-refresh">Refresh</button>' + (canNew ? '<button class="btn primary" type="button" id="pl-new">New draft</button>' : '') + '</div></div>' + privacyHtml() +
    (PL.err ? '<div class="err-box">' + esc(PL.err) + ' <button type="button" class="btn small" id="pl-retry">Try again</button></div>'
      : list.length ? '<p class="result-n">' + list.length + (list.length === 1 ? ' draft' : ' drafts') + '</p><div class="drafts" id="draft-list">' + list.map(cardHtml).join('') + '</div>'
        : '<p class="empty">No drafts yet.' + (canNew ? ' Make one with <b>New draft</b>, then put categories into its four slots.' : '') + '</p>');
  const again = async (b, label) => busy(b, label, async () => { await loadPlanner(); renderDraftList(); if (!PL.err) toast('Up to date'); });
  $('#pl-refresh').addEventListener('click', (e) => again(e.currentTarget, 'Refreshing…'));
  const r = $('#pl-retry'); if (r) r.addEventListener('click', (e) => again(e.currentTarget, 'Loading…'));
  if (canNew) $('#pl-new').addEventListener('click', () => newDraftDialog());
  $('#dsort').addEventListener('change', (e) => { DL.sort = e.target.value; renderDraftList(); $('#dsort').focus(); });
  $$('[data-psch]').forEach((b) => b.addEventListener('click', () => { DL.school = b.dataset.psch; renderDraftList(); const n = $('[data-psch="' + CSS.escape(DL.school) + '"]'); if (n) n.focus(); }));
}
/* opts (from the Calendar): { school, date: 'YYYY-MM-DD' (a target, not a schedule), title }. */
export function newDraftDialog(opts) {
  const o = opts || {}, schools = planSchools(), pick = o.school && schools.includes(o.school) ? o.school : schools[0];
  openModal('<form class="stack" style="--gap:12px" id="nd-form" novalidate><h2 id="modal-h">New draft</h2>' +
    '<label class="field"><span>Title (players see it on the results screen)</span><input class="input" id="nd-title" maxlength="120" required placeholder="e.g. Holes, Haze, and Old Paint" value="' + esc(o.title || '') + '"></label>' +
    (schools.length > 1 ? '<label class="field"><span>School (only its members will see the draft)</span><select class="input" id="nd-school">' +
      schools.map((k) => '<option value="' + esc(k) + '"' + (k === pick ? ' selected' : '') + '>' + esc(schFull(k)) + '</option>').join('') + '</select></label>' : '') +
    '<label class="field"><span>Block (optional)</span><select class="input" id="nd-block"><option value="">No block</option>' + BLOCKS.map((b) => '<option>' + esc(b) + '</option>').join('') + '</select></label>' +
    (o.date ? '<p class="muted" id="nd-date">Target release: ' + esc(releaseLabel(etToIso(o.date, '06:00'))) + ' (you still schedule it when it’s Ready).</p>' : '') +
    '<p class="err" id="nd-err" role="alert" hidden></p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button>' +
    '<button class="btn primary" type="submit" id="nd-go">Make draft</button></div></form>',
  (m, close) => {
    $('#nd-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = $('#nd-title', m).value.trim().replace(/\s+/g, ' ');
      if (!title) { const x = $('#nd-err', m); x.hidden = false; x.textContent = 'Give the draft a title. You can change it later.'; $('#nd-title', m).focus(); return; }
      const sch = $('#nd-school', m) ? $('#nd-school', m).value : pick;
      await busy($('#nd-go', m), 'Making…', async () => {
        const id = await createDraft(title, $('#nd-block', m).value, sch, o.date ? etToIso(o.date, '06:00') : null);
        if (!id) return;
        close(); toast('Draft made: ' + title);
        await loadPlanner();
        location.hash = '#/planner/' + encodeURIComponent(id);
      });
    });
  });
}
