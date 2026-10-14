// Part 3 of live_sync.e2e.mjs: safe failure and small screens.
// - A client with no Realtime at all (?nort) works exactly as before.
// - Realtime goes down: nothing breaks; when it comes back the page catches up.
// - Still down: coming back to the tab refreshes once (fallback).
// - 375 px phone: presence line and chips fit, no sideways scroll.
import { page, check, resetDb, sql, BASE, U, C, D } from './lib.mjs';

const card = (id) => `.sug-card[data-id="${id}"]`;
const votes = (p, id) => p.js(`(() => { const b = document.querySelector('${card(id)} .vote-btn'); return b ? parseInt(b.textContent.replace(/\\D+/g, ''), 10) : -1; })()`);
const ctl = (down) => fetch(BASE + '/__rt_ctl', { method: 'POST', body: JSON.stringify({ down }) }).then((r) => r.json());

export async function runPart3() {
  await resetDb();
  // 1. No Realtime in the client at all
  const n = await page();
  try {
    await n.signInAs(U.LEAD);
    await n.go(BASE + '/inbox/?mock&nort&n=nort#/categories');
    await n.waitFor('document.querySelectorAll("#sug-list .sug-card").length > 0', 10000);
    check('F1 no Realtime: live layer stays off', await n.js('window.__wsLive.state().on') === false);
    await n.click(card(C.asthma) + ' .vote-btn');
    check('F1 no Realtime: voting still works', await n.waitFor(`/👍 1/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000));
    await n.go(BASE + '/inbox/?mock&nort&n=nort2#/planner/' + D.cmsru);
    check('F1 no Realtime: the draft editor opens, no presence line', await n.waitFor('!!document.getElementById("editor")', 10000) && await n.js('document.getElementById("ed-pres").hidden'));
    check('F1 no Realtime: no console errors', n.errors.length === 0, n.errors);
  } finally { n.close(); }
  await sql(`delete from public.votes where submission_id = $1`, [C.asthma]);

  // 2. Realtime goes down and comes back
  const a = await page();
  try {
    await a.signInAs(U.LEAD);
    check('F2 live at the start', await a.waitFor('window.__wsLive.state().ok', 8000));
    await ctl(true);
    check('F2 Realtime down: the page notices', await a.waitFor('!window.__wsLive.state().ok', 8000));
    let r = await sql(`insert into public.votes (submission_id) values ($1)`, [C.asthma], U.ADMIN);
    check('F2 a change while down (Marcus votes)', !r.error, r.error);
    await a.sleep(1500);
    check('F2 ...is not seen yet, and nothing broke', await votes(a, C.asthma) === 0 && a.errors.length === 0, a.errors);
    await ctl(false);
    check('F2 back up: rejoins on its own', await a.waitFor('window.__wsLive.state().ok', 15000));
    check('F2 back up: catches up with the missed vote', await a.waitFor(`/👍 1/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000), await votes(a, C.asthma));

    // 3. Still down: coming back to the tab refreshes once
    await ctl(true);
    await a.waitFor('!window.__wsLive.state().ok', 8000);
    r = await sql(`delete from public.votes where submission_id = $1`, [C.asthma], U.ADMIN);
    await a.sleep(800);
    await a.js('document.dispatchEvent(new Event("visibilitychange"))');
    check('F3 tab focus refreshes while Realtime is down', await a.waitFor(`/👍 0/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000), await votes(a, C.asthma));
    check('F3 no console errors through all of it', a.errors.length === 0, a.errors);
  } finally { a.close(); await ctl(false); }

  // 4. Phone width
  const p = await page({ width: 375, height: 800, mobile: true }), m = await page();
  try {
    await p.signInAs(U.LEAD, '#/planner/' + D.cmsru); await m.signInAs(U.ADMIN, '#/planner/' + D.cmsru);
    check('F4 375: presence line shows on the phone', await p.waitFor('!document.getElementById("ed-pres").hidden', 10000), await p.text('#ed-pres'));
    check('F4 375: no sideways scroll in the draft', await p.overflow() <= 0, await p.overflow());
    if (process.env.SHOTS) await p.shot(process.env.SHOTS + '/19-presence-phone.png');
    await m.go(BASE + '/inbox/?mock&n=m2#/categories/' + C.clubbing);
    await p.go(BASE + '/inbox/?mock&n=p2#/categories');
    check('F4 375: presence chip on the card', await p.waitFor(`!!document.querySelector('${card(C.clubbing)} .pres-chip')`, 10000));
    check('F4 375: no sideways scroll in Categories', await p.overflow() <= 0, await p.overflow());
    check('F4 375: no console errors', p.errors.length === 0 && m.errors.length === 0, [p.errors, m.errors]);
  } finally { p.close(); m.close(); }
}
