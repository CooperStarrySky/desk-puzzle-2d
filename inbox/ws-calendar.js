/* Puzzle workspace: the Calendar tab. What is live now (the site's own
   puzzles/index.json), Ready drafts that still need a date, and the next 8
   weeks (Monday to Sunday, Eastern time). Each week of each school is one of:
   Scheduled (or published), Draft in progress (a draft aimed at that week,
   linked), or Nothing planned (yellow, with "Start a draft for this week",
   never for past weeks). The site owner sees one lane per school. Other
   schools' releases come from other_school_releases(): school and day only,
   never a title or topic. */
import { S, $, $$, esc, busy, toast, av, person, schFull, plainError } from './ws-core.js';
import { PL, DSTATUS, loadPlanner, filledCount, latestJob } from './ws-plan-data.js';
import { ARCH, loadArchive } from './ws-plan-checks.js';
import { weekOf, todayEt, addDays, releaseLabel, dayLabel, shortDay } from './ws-plan-time.js';
import { sealHtml } from './ws-plan-seal.js';
import { newDraftDialog, planSchools } from './ws-plan-list.js';
import { flip } from './ws-motion.js';

const CAL = { others: [], err: '' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const longDay = (date) => { const [y, m, d] = date.split('-').map(Number); return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ', ' + shortDay(date); };

function item(href, st, label, title, whenText, who, seal) {
  return '<a class="cal-item" href="' + href + '"><span class="st st-' + esc(st) + '">' + esc(label) + '</span><span class="grow"><b>' + esc(title) + '</b>' + (seal || '') + '<br>' +
    '<span class="muted cal-when">' + esc(whenText) + '</span></span>' + (who ? '<span class="row cal-who" style="--gap:6px">' + av(who) + esc(person(who).name) + '</span>' : '') + '</a>';
}
const draftLink = (d) => '#/planner/' + encodeURIComponent(d.id);
/* A draft the publisher is working on right now shows "Publishing…" instead of its status. */
function dItem(d, st, label, whenText) {
  const j = latestJob(d.id);
  if (j && j.state === 'running') return item(draftLink(d), 'publishing', 'Publishing…', d.title, 'Publishing now' + (j.step ? ': ' + j.step : ''), d.owner_email, sealHtml(d, 'xs'));
  return item(draftLink(d), st, label, d.title, whenText, d.owner_email, sealHtml(d, 'xs'));
}
/* Lanes: every school for the site owner, else my own school(s). */
function lanes() {
  const all = S.owner ? Array.from(new Set(Array.from(S.schools.keys()).concat(PL.drafts.map((d) => d.school)))) : Object.keys(S.roles);
  return all.sort((a, b) => (b === 'cmsru') - (a === 'cmsru') || (a < b ? -1 : 1));
}
function laneWeek(k, ws) {
  const inWk = (iso) => !!iso && weekOf(iso) === ws, mine = PL.drafts.filter((d) => d.school === k);
  const pubs = ARCH.list.filter((p) => p.school === k && p.date && weekOf(p.date) === ws);
  const pubDrafts = mine.filter((d) => d.status === 'published' && inWk(d.published_at) && !pubs.some((p) => p.id === d.published_puzzle_id));
  const sched = mine.filter((d) => d.status === 'scheduled' && inWk(d.target_release)).sort((a, b) => (a.target_release < b.target_release ? -1 : 1));
  const prog = mine.filter((d) => (d.status === 'planning' || d.status === 'ready') && inWk(d.target_release));
  return { pubs, pubDrafts, sched, prog, state: pubs.length || pubDrafts.length || sched.length ? 'ok' : prog.length ? 'prog' : 'gap' };
}
function laneHtml(k, ws, w) {
  const thu = addDays(ws, 3), canStart = planSchools().includes(k) && thu >= todayEt();
  const pubDraft = (p) => PL.drafts.find((d) => d.published_puzzle_id === p.id);
  let h = w.pubs.map((p) => item('#/archive', 'published', p.id === ARCH.current ? 'Live now' : 'Published', p.title, 'Released ' + dayLabel(p.date, true), '', sealHtml(pubDraft(p), 'xs'))).join('') +
    w.pubDrafts.map((d) => item(draftLink(d), 'published', 'Published', d.title, 'Published ' + releaseLabel(d.published_at), d.owner_email, sealHtml(d, 'xs'))).join('') +
    w.sched.map((d) => dItem(d, 'scheduled', 'Scheduled', 'Goes live ' + releaseLabel(d.target_release))).join('');
  if (w.sched.length > 1) h += '<p class="cal-gap">Two puzzles are scheduled this week. Move one?</p>';
  const progLinks = w.prog.map((d) => '<a href="' + draftLink(d) + '">' + esc(d.title) + '</a> · ' + filledCount(d.id) + '/4 · ' + esc(DSTATUS[d.status])).join('<br>');
  if (w.state === 'prog') h += '<div class="cal-state prog"><b>Draft in progress</b><span>' + progLinks + '</span></div>';
  else if (w.state === 'ok' && w.prog.length) h += '<p class="faint cal-also">Also aimed here: ' + w.prog.map((d) => '<a href="' + draftLink(d) + '">' + esc(d.title) + '</a>').join(', ') + '</p>';
  if (w.state === 'gap') h += '<div class="cal-state gap"><b>Nothing planned</b>' + (canStart ? '<button type="button" class="btn small" data-startwk="' + esc(k) + '|' + thu + '">Start a draft for this week</button>' : '') + '</div>';
  return h;
}
function weeksHtml(ls, gaps) {
  const w0 = weekOf(todayEt()); let html = '';
  for (let i = 0; i < 8; i++) {
    const ws = addDays(w0, 7 * i), we = addDays(ws, 6);
    const others = CAL.others.filter((o) => weekOf(o.date) === ws);
    html += '<div class="cal-week lanes-' + ls.length + '" data-week="' + ws + '"><h3>' + (i === 0 ? 'This week<br>' : '') + 'Week of ' + esc(shortDay(ws)) + '<span class="sr"> to ' + esc(shortDay(we)) + '</span></h3><div class="cal-lanes">' +
      ls.map((k) => { const w = laneWeek(k, ws); if (w.state === 'gap') gaps[k]++;
        return '<div class="cal-lane st-' + w.state + '" data-lane="' + esc(k) + '">' + (ls.length > 1 ? '<p class="lane-h">' + esc(schFull(k)) + '</p>' : '') + laneHtml(k, ws, w) + '</div>'; }).join('') +
      others.map((o) => '<div class="cal-item cal-x"><span class="st st-x">Other school</span><span class="grow">' + esc(o.school) + ' has scheduled a puzzle to release ' + esc(longDay(o.date)) +
        '<br><span class="faint cal-priv">🔒 Title and topics stay private until it’s live</span></span></div>').join('') + '</div></div>';
  }
  return html;
}
function render() {
  const ls = lanes(), gaps = {}; ls.forEach((k) => { gaps[k] = 0; });
  const weeks = weeksHtml(ls, gaps);
  const liveOf = (k) => { const m = ARCH.list.filter((p) => p.school === k).sort((a, b) => (a.date < b.date ? 1 : -1)); return m.find((p) => p.id === ARCH.current) || m[0] || null; };
  const needs = PL.drafts.filter((d) => d.status === 'ready').sort((a, b) => (!a.target_release - !b.target_release) || (a.updated_at < b.updated_at ? 1 : -1));
  const planning = PL.drafts.filter((d) => d.status === 'planning').length;
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Calendar</p><h1>Release schedule</h1></div>' +
    '<div class="row" style="--gap:8px"><p class="muted cal-note">Puzzles go live Thursday mornings, 6:00 AM Eastern.</p><button class="btn" type="button" id="cal-refresh">Refresh</button></div></div>' +
    (PL.err ? '<div class="err-box">' + esc(PL.err) + '</div>' : '') + (CAL.err ? '<p class="hint">Other schools’ release days could not be loaded: ' + esc(CAL.err) + '</p>' : '') +
    '<div class="cal"><p class="row cal-warn" style="--gap:8px">' + ls.map((k) => '<span class="' + (gaps[k] ? 'warn-chip' : 'ok-chip') + '">' + esc(schFull(k)) + ': ' +
      (gaps[k] ? gaps[k] + ' of 8 weeks with nothing planned' : 'every week covered') + '</span>').join('') + '</p>' +
    '<section class="cal-lives" aria-label="Live now">' + ls.map((k) => { const live = liveOf(k);
      return '<div class="panel cal-live stack" style="--gap:6px"><p class="eyebrow">Live now · ' + (ls.length > 1 ? esc(schFull(k)) : 'This week’s puzzle') + '</p>' +
        (live ? '<h2>' + esc(live.title) + '</h2><p class="muted">Released ' + esc(dayLabel(live.date, true)) + ' · <a href="../">Open the game</a></p>'
          : '<p class="muted">' + esc(ARCH.err || 'No puzzle has gone live yet.') + '</p>') + '</div>'; }).join('') + '</section>' +
    '<section class="stack" style="--gap:8px" aria-labelledby="cal-needs"><h2 id="cal-needs" class="cal-h">Ready, needs a date</h2>' +
    (needs.length ? needs.map((d) => '<div class="cal-ready">' + dItem(d, 'ready', DSTATUS.ready, (ls.length > 1 ? schFull(d.school) + ' · ' : '') + filledCount(d.id) + '/4 groups' +
      (d.target_release ? ' · target ' + releaseLabel(d.target_release) : '')) + (d.target_release ? '' : '<span class="nudge">Needs a date</span>') + '</div>').join('')
      : '<p class="muted">Nothing is waiting for a date.' + (planning ? ' ' + planning + (planning === 1 ? ' draft is' : ' drafts are') + ' still in planning.' : '') + '</p>') + '</section>' +
    '<section aria-labelledby="cal-weeks"><h2 id="cal-weeks" class="cal-h">Next 8 weeks</h2>' + weeks + '</section></div>';
  $('#cal-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => { await load(); redraw(); if (!PL.err) toast('Up to date'); }));
  $$('[data-startwk]').forEach((b) => b.addEventListener('click', () => { const [k, day] = b.dataset.startwk.split('|'); newDraftDialog({ school: k, date: day, title: 'Week of ' + shortDay(weekOf(day)) }); }));
}
async function loadOthers() {
  CAL.others = []; CAL.err = '';
  if (S.owner) return; // the owner already sees every school's drafts
  const from = weekOf(todayEt()), to = addDays(from, 55);
  const { data, error } = await S.sb.rpc('other_school_releases', { p_from: from, p_to: to });
  if (error) { CAL.err = plainError(error); return; }
  CAL.others = (data || []).map((r) => ({ school: String(r.school_name || 'Another school'), date: String(r.release_date || '').slice(0, 10) })).filter((r) => r.date);
}
const load = () => Promise.all([loadPlanner(), loadArchive(), loadOthers()]);
/* Redraws keep the old calendar on screen while loading, then drafts that moved
   glide to their new week and changed ones glow briefly (ws-motion.js). */
const calKey = (a) => a.getAttribute('href') + '|' + ((a.closest('section') || {}).getAttribute ? a.closest('section').getAttribute('aria-labelledby') : '');
function redraw() {
  const main = $('#ws-main'), had = !!$('.cal', main), old = new Map($$('#ws-main .cal-item').map((a) => [calKey(a), a.textContent]));
  flip(main, '.cal-item', calKey, render);
  if (had) $$('#ws-main .cal-item').forEach((a) => { const k = calKey(a); if (old.get(k) !== a.textContent) { a.classList.add('live-flash'); setTimeout(() => a.classList.remove('live-flash'), 2500); } });
}
export async function showCalendar() {
  if (!$('#ws-main .cal')) $('#ws-main').innerHTML = '<p class="muted">Loading the calendar…</p>';
  await load();
  redraw();
}
