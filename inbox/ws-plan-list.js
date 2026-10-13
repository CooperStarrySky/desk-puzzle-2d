/* Puzzle workspace: the Planner's list of drafts, and "New draft". */
import { $, esc, busy, toast, openModal, av, person, ago, TIER_WORDS } from './ws-core.js';
import { BLOCKS } from './ws-suggest.js';
import { PL, DSTATUS, slotsOf, latestJob, createDraft, loadPlanner } from './ws-plan-data.js';
import { releaseLabel } from './ws-plan-time.js';

const ORDER = { scheduled: 0, ready: 1, planning: 2, published: 3 };
export function draftWhen(d) {
  if (d.status === 'scheduled') return 'Goes live ' + releaseLabel(d.target_release);
  if (d.status === 'published') return 'Published' + (d.published_at ? ' ' + ago(d.published_at) : '');
  return d.target_release ? 'Target ' + releaseLabel(d.target_release) : 'No release date yet';
}
function cardHtml(d) {
  const sl = slotsOf(d.id), n = sl.filter(Boolean).length, job = latestJob(d.id);
  const jw = !job || d.status === 'published' ? '' : { queued: 'Publish queued', running: 'Publishing…', failed: 'Publishing failed' }[job.state] || '';
  return '<a class="draft-card" href="#/planner/' + encodeURIComponent(d.id) + '" data-did="' + esc(d.id) + '"><div class="row spread"><span class="st st-' + esc(d.status) + '">' + esc(DSTATUS[d.status] || d.status) + '</span>' +
    '<span class="muted dc-when">' + esc(draftWhen(d)) + '</span></div>' +
    '<h3>' + esc(d.title) + '</h3>' + (d.block ? '<span class="tagchip">' + esc(d.block) + '</span>' : '') +
    '<div class="minislots" aria-hidden="true">' + [1, 2, 3, 4].map((t) => '<span class="t' + t + (sl[t] ? '' : ' off') + '"></span>').join('') + '</div>' +
    '<p class="muted dc-names">' + [1, 2, 3, 4].map((t) => (sl[t] ? esc(sl[t].item.name) : '<i>' + TIER_WORDS[t] + ' empty</i>')).join(' · ') + '</p>' +
    '<div class="row spread"><span class="row" style="--gap:6px">' + av(d.owner_email) + '<span class="dc-owner">Owner: ' + esc(person(d.owner_email).name) + '</span></span>' +
    '<span class="fill-n">' + n + '/4 slots' + (jw ? ' · <b class="jw jw-' + esc(job.state) + '">' + jw + '</b>' : '') + '</span></div></a>';
}
export function renderDraftList() {
  const list = PL.drafts.slice().sort((a, b) => (ORDER[a.status] - ORDER[b.status]) ||
    (a.status === 'scheduled' ? (a.target_release < b.target_release ? -1 : 1) : (a.updated_at < b.updated_at ? 1 : -1)));
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Planner</p><h1>Puzzle drafts</h1></div>' +
    '<div class="row" style="--gap:8px"><button class="btn" type="button" id="pl-refresh">Refresh</button><button class="btn primary" type="button" id="pl-new">New draft</button></div></div>' +
    (PL.err ? '<div class="err-box">' + esc(PL.err) + ' <button type="button" class="btn small" id="pl-retry">Try again</button></div>'
      : list.length ? '<p class="result-n">' + list.length + (list.length === 1 ? ' draft' : ' drafts') + '</p><div class="drafts" id="draft-list">' + list.map(cardHtml).join('') + '</div>'
        : '<p class="empty">No drafts yet. Make one with <b>New draft</b>, then drag shortlisted categories into its four slots.</p>');
  const again = async (b, label) => busy(b, label, async () => { await loadPlanner(); renderDraftList(); if (!PL.err) toast('Up to date'); });
  $('#pl-refresh').addEventListener('click', (e) => again(e.currentTarget, 'Refreshing…'));
  const r = $('#pl-retry'); if (r) r.addEventListener('click', (e) => again(e.currentTarget, 'Loading…'));
  $('#pl-new').addEventListener('click', newDraftDialog);
}
export function newDraftDialog() {
  openModal('<form class="stack" style="--gap:12px" id="nd-form" novalidate><h2 id="modal-h">New draft</h2>' +
    '<label class="field"><span>Title (players see it on the results screen)</span><input class="input" id="nd-title" maxlength="120" required placeholder="e.g. Holes, Haze, and Old Paint"></label>' +
    '<label class="field"><span>Block (optional)</span><select class="input" id="nd-block"><option value="">No block</option>' + BLOCKS.map((b) => '<option>' + esc(b) + '</option>').join('') + '</select></label>' +
    '<p class="err" id="nd-err" role="alert" hidden></p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button>' +
    '<button class="btn primary" type="submit" id="nd-go">Make draft</button></div></form>',
  (m, close) => {
    $('#nd-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = $('#nd-title', m).value.trim().replace(/\s+/g, ' ');
      if (!title) { const x = $('#nd-err', m); x.hidden = false; x.textContent = 'Give the draft a title. You can change it later.'; $('#nd-title', m).focus(); return; }
      await busy($('#nd-go', m), 'Making…', async () => {
        const id = await createDraft(title, $('#nd-block', m).value);
        if (!id) return;
        close(); toast('Draft made: ' + title);
        await loadPlanner();
        location.hash = '#/planner/' + encodeURIComponent(id);
      });
    });
  });
}
