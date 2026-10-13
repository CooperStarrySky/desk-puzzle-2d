/* Puzzle workspace: the Calendar tab. What is live now (the site's own
   puzzles/index.json), Ready drafts that still need a date, and the next 8
   weeks (Monday to Sunday, Eastern time) with Scheduled drafts and the gaps. */
import { $, esc, busy, toast, av, person } from './ws-core.js';
import { PL, DSTATUS, loadPlanner, filledCount, latestJob } from './ws-plan-data.js';
import { ARCH, loadArchive } from './ws-plan-checks.js';
import { weekOf, todayEt, addDays, releaseLabel, dayLabel, shortDay } from './ws-plan-time.js';

function item(href, st, label, title, whenText, who) {
  return '<a class="cal-item" href="' + href + '"><span class="st st-' + esc(st) + '">' + esc(label) + '</span><span class="grow"><b>' + esc(title) + '</b><br>' +
    '<span class="muted cal-when">' + esc(whenText) + '</span></span>' + (who ? '<span class="row cal-who" style="--gap:6px">' + av(who) + esc(person(who).name) + '</span>' : '') + '</a>';
}
const draftLink = (d) => '#/planner/' + encodeURIComponent(d.id);
/* A draft the publisher is working on right now shows "Publishing…" instead of its status. */
function dItem(d, st, label, whenText) {
  const j = latestJob(d.id);
  if (j && j.state === 'running') return item(draftLink(d), 'publishing', 'Publishing…', d.title, 'Publishing now' + (j.step ? ': ' + j.step : ''), d.owner_email);
  return item(draftLink(d), st, label, d.title, whenText, d.owner_email);
}
function weeksHtml() {
  const w0 = weekOf(todayEt()), open = PL.drafts.filter((d) => d.status !== 'published');
  let html = '';
  for (let i = 0; i < 8; i++) {
    const ws = addDays(w0, 7 * i), we = addDays(ws, 6);
    const pubs = ARCH.list.filter((p) => p.date && weekOf(p.date) === ws);
    const sched = open.filter((d) => d.status === 'scheduled' && d.target_release && weekOf(d.target_release) === ws)
      .sort((a, b) => (a.target_release < b.target_release ? -1 : 1));
    const pubDrafts = PL.drafts.filter((d) => d.status === 'published' && d.published_at && weekOf(d.published_at) === ws && !pubs.some((p) => p.id === d.published_puzzle_id));
    const label = 'Week of ' + shortDay(ws);
    html += '<div class="cal-week" data-week="' + ws + '"><h3>' + (i === 0 ? 'This week<br>' : '') + esc(label) + '<span class="sr"> to ' + esc(shortDay(we)) + '</span></h3><div class="cal-items">' +
      pubs.map((p) => item('../', 'published', p.id === ARCH.current ? 'Live now' : 'Published', p.title, 'Released ' + dayLabel(p.date, true))).join('') +
      pubDrafts.map((d) => item(draftLink(d), 'published', 'Published', d.title, 'Published ' + releaseLabel(d.published_at), d.owner_email)).join('') +
      sched.map((d) => dItem(d, 'scheduled', 'Scheduled', 'Goes live ' + releaseLabel(d.target_release))).join('') +
      (sched.length > 1 ? '<p class="cal-gap">Two puzzles are scheduled this week. Move one?</p>' : '') +
      (!sched.length && !pubs.length && !pubDrafts.length ? '<p class="cal-gap">No puzzle scheduled for the week of ' + esc(shortDay(ws)) + '</p>' : '') + '</div></div>';
  }
  return html;
}
function render() {
  const live = ARCH.list.find((p) => p.id === ARCH.current);
  const needs = PL.drafts.filter((d) => d.status === 'ready').sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const planning = PL.drafts.filter((d) => d.status === 'planning').length;
  $('#ws-main').innerHTML = '<div class="view-head"><div><p class="eyebrow">Calendar</p><h1>Release schedule</h1></div>' +
    '<div class="row" style="--gap:8px"><p class="muted cal-note">Puzzles go live Thursday mornings, 6:00 AM Eastern.</p><button class="btn" type="button" id="cal-refresh">Refresh</button></div></div>' +
    (PL.err ? '<div class="err-box">' + esc(PL.err) + '</div>' : '') +
    '<div class="cal"><section class="panel cal-live stack" style="--gap:6px" aria-labelledby="cal-live-h"><p class="eyebrow" id="cal-live-h">Live now · This week’s puzzle</p>' +
    (live ? '<h2>' + esc(live.title) + '</h2><p class="muted">Released ' + esc(dayLabel(live.date, true)) + ' · <a href="../">Open the game</a></p>'
      : '<p class="muted">' + esc(ARCH.err || 'No live puzzle found in puzzles/index.json.') + '</p>') + '</section>' +
    '<section class="stack" style="--gap:8px" aria-labelledby="cal-needs"><h2 id="cal-needs" class="cal-h">Ready, needs a date</h2>' +
    (needs.length ? needs.map((d) => dItem(d, 'ready', DSTATUS.ready, 'Needs a date · ' + filledCount(d.id) + '/4 groups')).join('')
      : '<p class="muted">Nothing is waiting for a date.' + (planning ? ' ' + planning + (planning === 1 ? ' draft is' : ' drafts are') + ' still in planning.' : '') + '</p>') + '</section>' +
    '<section aria-labelledby="cal-weeks"><h2 id="cal-weeks" class="cal-h">Next 8 weeks</h2>' + weeksHtml() + '</section></div>';
  $('#cal-refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => { await loadPlanner(); render(); if (!PL.err) toast('Up to date'); }));
}
export async function showCalendar() {
  $('#ws-main').innerHTML = '<p class="muted">Loading the calendar…</p>';
  await Promise.all([loadPlanner(), loadArchive()]);
  render();
}
