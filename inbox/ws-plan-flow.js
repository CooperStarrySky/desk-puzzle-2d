/* Puzzle workspace: a draft's status. Planning -> Ready (blocking checks must
   pass) -> Scheduled (a release moment, default Thursday 6:00 AM Eastern) ->
   Published. "Publish now" only asks: it adds a publish_jobs row that the
   publisher (a GitHub job, later step) picks up; the state shows here. The
   banner says when the database moved this draft back (a category of it was
   published in another puzzle). */
import { $, esc, busy, toast, openModal, ago, person } from './ws-core.js';
import { PL, DSTATUS, slotsOf, eventsOf, latestJob, patchDraft, requestPublish } from './ws-plan-data.js';
import { addPart, refresh, current, readOnly } from './ws-plan-editor.js';
import { blockers } from './ws-plan-checks.js';
import { etParts, etToIso, nextThursday, releaseLabel, weekOf, todayEt, shortDay } from './ws-plan-time.js';

const JOB_WORDS = { queued: 'Queued — the publisher will pick it up', running: 'Publishing now', done: 'Published by the publisher', failed: 'Publishing failed' };
const openJob = (j) => !!j && (j.state === 'queued' || j.state === 'running');
const btn = (id, label, cls, off) => '<button type="button" class="btn small ' + (cls || '') + '" id="' + id + '"' + (off ? ' disabled' : '') + '>' + label + '</button>';

function jobHtml(j) {
  if (!j) return '';
  return '<p class="job job-' + esc(j.state) + '" id="job" role="status"><span class="dot" aria-hidden="true"></span><b>' + esc(JOB_WORDS[j.state] || j.state) + '</b>' +
    (j.step && j.state === 'running' ? ': ' + esc(j.step) : '') + (j.error && j.state === 'failed' ? ': ' + esc(j.error) : '') +
    ' <span class="faint">· asked by ' + esc(person(j.requested_by).name) + ' ' + esc(ago(j.requested_at)) + '</span></p>';
}
function render(d) {
  const el = $('#flow'); if (!el) return;
  const nb = blockers(d).length, j = latestJob(d.id), busyJob = openJob(j);
  const why = nb ? '<span class="why">Fix ' + nb + ' blocking check' + (nb > 1 ? 's' : '') + ' first</span>' : '';
  let h = '<span class="st st-' + esc(d.status) + '">' + esc(DSTATUS[d.status]) + '</span>';
  if (d.status === 'planning') h += btn('f-ready', 'Mark ready', 'primary', nb) + why;
  else if (d.status === 'ready') h += btn('f-sched', 'Schedule…', 'primary', nb) + btn('f-pub', 'Publish now…', '', nb || busyJob) + btn('f-plan', 'Back to planning', 'ghost') + why;
  else if (d.status === 'scheduled') h += '<span class="when">Goes live ' + esc(releaseLabel(d.target_release)) + '</span>' + btn('f-sched', 'Change time…', '', nb) +
    btn('f-pub', 'Publish now…', '', nb || busyJob) + btn('f-unsched', 'Unschedule', 'ghost') + why;
  else h += '<span class="when">Published' + (d.published_puzzle_id ? ' as <span class="code">' + esc(d.published_puzzle_id) + '</span>' : '') + (d.published_at ? ' · ' + esc(ago(d.published_at)) : '') + '</span>';
  el.innerHTML = h + jobHtml(j);
  banner(d);
}
/* "Moved back" banner, from the newest status-type history line of this draft. */
const SEEN = 'dp2d:ws-banner-seen';
function seen() { try { return JSON.parse(sessionStorage.getItem(SEEN) || '[]'); } catch (e) { return []; } }
function banner(d) {
  const el = $('#ed-banner'); if (!el) return;
  const e = eventsOf(d.id).find((x) => ['reverted', 'lost_slot', 'status', 'schedule', 'unschedule', 'publish'].includes(x.action));
  if (!e || (e.action !== 'reverted' && e.action !== 'lost_slot') || seen().includes(e.id)) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="banner" role="status"><span>' + esc(e.note || 'This draft lost a category to another puzzle.') + ' <span class="faint">(' + esc(ago(e.at)) + '. ' +
    (e.notify_email ? esc(person(e.notify_email).name) + ', the owner, was notified.' : '') + ')</span></span><button type="button" class="btn small ghost" id="banner-x">Dismiss</button></div>';
  $('#banner-x').addEventListener('click', () => { try { sessionStorage.setItem(SEEN, JSON.stringify(seen().concat(e.id))); } catch (x) { /* */ } el.innerHTML = ''; $('#ed-title').focus(); });
}
async function setStatus(d, patch, msg, focusId) {
  if (!(await patchDraft(d.id, patch, 'Could not change the status'))) return;
  toast(msg); await refresh();
  const f = (focusId && $('#' + focusId)) || $('#flow button:not([disabled])'); if (f) f.focus();
}

function scheduleDialog(d) {
  const keep = d.target_release && new Date(d.target_release) > new Date(), e0 = keep ? etParts(d.target_release) : null;
  openModal('<form class="stack" style="--gap:12px" id="sch-form" novalidate><h2 id="modal-h">Schedule “' + esc(d.title) + '”</h2>' +
    '<p class="muted">Pick when it goes live, in Eastern time. Puzzles usually go out Thursday mornings.</p><div class="fdates">' +
    '<label class="field"><span>Release date</span><input class="input" type="date" id="sch-d" required value="' + (e0 ? e0.date : nextThursday()) + '" min="' + todayEt() + '"></label>' +
    '<label class="field"><span>Time (ET)</span><input class="input" type="time" id="sch-t" required value="' + (e0 ? e0.time : '06:00') + '"></label></div>' +
    '<p class="when" id="sch-live" aria-live="polite"></p><p class="note-box" id="sch-warn" hidden></p><p class="err" id="sch-err" role="alert" hidden></p>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="submit" id="sch-go">Schedule</button></div></form>',
  (m, close) => {
    const D = $('#sch-d', m), T = $('#sch-t', m);
    const upd = () => {
      const iso = D.value ? etToIso(D.value, T.value || '06:00') : null, w = $('#sch-warn', m);
      $('#sch-err', m).hidden = true;
      $('#sch-live', m).textContent = iso ? 'Goes live ' + releaseLabel(iso) : 'Pick a date.';
      const clash = iso ? PL.drafts.filter((o) => o.id !== d.id && o.status === 'scheduled' && o.target_release && weekOf(o.target_release) === weekOf(D.value)) : [];
      w.hidden = !clash.length;
      w.textContent = clash.length ? 'Heads up: ' + clash.map((o) => '“' + o.title + '” (' + releaseLabel(o.target_release) + ')').join(' and ') + ' is already scheduled the week of ' + shortDay(weekOf(D.value)) + '.' : '';
    };
    D.addEventListener('input', upd); T.addEventListener('input', upd); upd();
    $('#sch-form', m).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const iso = D.value ? etToIso(D.value, T.value || '06:00') : null, err = $('#sch-err', m);
      if (!iso || new Date(iso) <= new Date()) { err.hidden = false; err.textContent = 'Pick a date and time in the future.'; D.focus(); return; }
      await busy($('#sch-go', m), 'Scheduling…', async () => {
        if (!(await patchDraft(d.id, { status: 'scheduled', target_release: iso }, 'Could not schedule it'))) return;
        close(); toast('Scheduled: goes live ' + releaseLabel(iso)); await refresh();
        const f = $('#f-pub'); if (f) f.focus();
      });
    });
  });
}
/* Other unpublished drafts that would lose a category (publishing removes the same suggestions everywhere). */
function losers(d) {
  const mine = new Set(PL.slots.filter((s) => s.draft_id === d.id && s.submission_id).map((s) => s.submission_id)), out = [];
  PL.drafts.forEach((o) => {
    if (o.id === d.id || o.status === 'published') return;
    slotsOf(o.id).forEach((s) => { if (s && s.row.submission_id && mine.has(s.row.submission_id)) out.push({ o, name: s.item.name }); });
  });
  return out;
}
const STEPS = ['Build the puzzle files from this draft', 'Make the menu-card picture', 'Set it as this week’s puzzle', 'Credit the contributors',
  'Mark its suggestions Used', 'Take them out of other drafts', 'Publish the site', 'Class stats start counting'];
function publishDialog(d) {
  const hit = losers(d), back = { scheduled: 'goes back to Ready', ready: 'goes back to Planning', planning: 'stays in Planning' };
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Publish “' + esc(d.title) + '” now?</h2>' +
    '<p>This replaces the live puzzle for everyone as soon as the publisher runs' + (d.status === 'scheduled' ? ', instead of waiting for ' + esc(releaseLabel(d.target_release)) : '') + '.</p>' +
    '<h3 class="pub-h">What happens at release</h3><ol class="steps">' + STEPS.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    (hit.length ? '<div class="note-box"><b>Other drafts lose categories:</b><ul class="losers">' + hit.map((x) => '<li>‘' + esc(x.name) + '’ from ' + esc(x.o.title) + ' (' + esc(DSTATUS[x.o.status]) + ', ' + back[x.o.status] + ')</li>').join('') + '</ul></div>'
      : '<p class="muted">No other draft uses these categories.</p>') +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="button" id="pub-go">Publish now</button></div></div>',
  (m, close) => {
    $('#pub-go', m).addEventListener('click', (e) => busy(e.currentTarget, 'Asking…', async () => {
      if (!(await requestPublish(d.id))) return;
      close(); toast('Queued — the publisher will pick it up', 4000); await refresh();
      const j = $('#job'); if (j) { j.tabIndex = -1; j.focus(); }
    }));
  });
}
function mount() {
  const el = $('#flow'); if (!el) return;
  el.addEventListener('click', (e) => {
    const d = current(), b = e.target.closest('button'); if (!d || !b || readOnly(d)) return;
    if (b.id === 'f-ready') setStatus(d, { status: 'ready' }, 'Marked Ready', 'f-sched');
    else if (b.id === 'f-plan') setStatus(d, { status: 'planning' }, 'Back to Planning', 'f-ready');
    else if (b.id === 'f-unsched') setStatus(d, { status: 'ready', target_release: null }, 'Unscheduled. Back to Ready.', 'f-sched');
    else if (b.id === 'f-sched') scheduleDialog(d);
    else if (b.id === 'f-pub') publishDialog(d);
  });
}
addPart({ mount, update: render });
