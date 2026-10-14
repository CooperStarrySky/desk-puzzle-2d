// supabase/tests/ui/live_sync_b.mjs — live syncing + presence (B6), part 2:
// Categories (votes, comments, trash, presence chips, typing is never
// clobbered), the Activity tab and badge, no leaks to another school, Realtime
// unavailable or down (works as before, catches up), and a 375 px phone.
// Called by live_sync.e2e.mjs (one browser suite in run_all.mjs).
import { page, check, resetDb, sql, BASE, U, C, D } from './lib.mjs';

const card = (id) => `.sug-card[data-id="${id}"]`;
const rtLog = (p) => p.js('JSON.stringify(window.__mockState.rt.log.filter((e) => e.type === "broadcast").map((e) => [e.topic, e.payload.t, e.payload.by]))');
export async function runPart2() {
  await resetDb();
  const a = await page(), b = await page(), o = await page();
  try {
    await a.signInAs(U.LEAD); await b.signInAs(U.ADMIN); await o.signInAs(U.OTHER);
    check('C0 three pages live', await a.waitFor('window.__wsLive.state().ok', 8000) && await b.waitFor('window.__wsLive.state().ok', 8000) && await o.waitFor('window.__wsLive.state().ok', 8000));
    check('C0 Aisha (other school) joined only the bank + her school', await o.js('window.__wsLive.state().topics.join()') === 'ws:bank,ws:school:rvsom');

    // Votes travel live to everyone (the bank is shared)
    await b.click(card(C.asthma) + ' .vote-btn');
    check('C1 John sees Marcus\'s vote on Asthma triggers', await a.waitFor(`/👍 1/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000), await a.text(card(C.asthma) + ' .vote-btn'));
    check('C1 "Vote by Marcus T." flash on the card', await a.waitFor(`(document.querySelector('${card(C.asthma)} > .live-by') || {}).textContent === 'Vote by Marcus T.'`, 3000));
    check('C1 Aisha (other school) sees the vote too', await o.waitFor(`/👍 1/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000));
    if (process.env.SHOTS) await a.shot(process.env.SHOTS + '/18-category-vote-flash.png');

    // Trash: the card leaves everyone's list, the Trash count goes up
    const trashN = await a.js('Number(document.querySelector("#cat-subtabs a[href$=trash] .n").textContent)');
    let r = await sql(`select public.trash_submission($1, 'duplicate')`, [C.cheese], U.ADMIN);
    check('C2 Marcus trashes Cheese-related', !r.error, r.error);
    check('C2 the card leaves John\'s list live', await a.waitFor(`!document.querySelector('${card(C.cheese)}')`, 8000));
    check('C2 Trash count goes up by one', await a.waitFor(`Number(document.querySelector("#cat-subtabs a[href$=trash] .n").textContent) === ${trashN + 1}`, 3000));

    // Presence chips: same school only
    await b.click('#tg-' + C.clubbing);
    check('C3 John sees Marcus has Causes of clubbing open', await a.waitFor(`!!document.querySelector('${card(C.clubbing)} .pres-chip')`, 8000) &&
      (await a.attr(card(C.clubbing) + ' .pres-chip', 'title')) === 'Marcus T. has this open');
    await o.click('#tg-' + C.clubbing);
    await a.sleep(1500);
    check('C3 Aisha (other school) does not see Marcus there', await o.count(card(C.clubbing) + ' .pres-chip') === 0);
    check('C3 John does not see Aisha (other school)', (await a.attr(card(C.clubbing) + ' .pres-chip', 'title')) === 'Marcus T. has this open');

    // A comment while John is typing in the same card
    await a.click('#tg-' + C.clubbing);
    await a.waitFor(`!!document.querySelector('#sd-${C.clubbing} .cm-in')`, 8000);
    await a.js(`(() => { const d = document.querySelector('#sd-${C.clubbing} details[data-row="cmts"]'); if (d) d.open = true; const t = document.querySelector('#sd-${C.clubbing} .cm-in'); t.focus(); t.value = 'John is writing'; })()`);
    r = await sql(`insert into public.comments (target_type, target_id, body, visibility) values ('submission', $1, 'Marcus: great one', 'all')`, [C.clubbing], U.ADMIN);
    await b.click(card(C.asthma) + ' .vote-btn'); // and a change on another card
    check('C4 other cards still update while John types (Asthma vote back to 0)', await a.waitFor(`/👍 0/.test(document.querySelector('${card(C.asthma)} .vote-btn').textContent)`, 8000));
    check('C4 John\'s text and focus are kept', await a.js(`document.querySelector('#sd-${C.clubbing} .cm-in').value === 'John is writing' && document.activeElement.classList.contains('cm-in')`));
    check('C4 the open card says Marcus changed it', await a.waitFor(`(document.querySelector('${card(C.clubbing)} > .live-by') || {}).textContent === 'New comment by Marcus T.'`, 3000));
    await a.js(`(() => { const t = document.querySelector('#sd-${C.clubbing} .cm-in'); t.value = ''; t.blur(); })()`);
    check('C4 the comment shows once John is done', await a.waitFor(`document.querySelector('#sd-${C.clubbing}').textContent.includes('Marcus: great one')`, 8000));
    check('C4 Aisha sees the all-schools comment count', await o.waitFor(`document.querySelector('#sd-${C.clubbing}') && document.querySelector('#sd-${C.clubbing}').textContent.includes('Marcus: great one')`, 8000));

    // School-only comment: never reaches the other school, not even as a note
    r = await sql(`insert into public.comments (target_type, target_id, body, visibility) values ('submission', $1, 'CMSRU only remark', 'school')`, [C.clubbing], U.ADMIN);
    check('C5 John sees the school-only comment live', await a.waitFor(`document.querySelector('#sd-${C.clubbing}').textContent.includes('CMSRU only remark')`, 8000));
    await o.sleep(1200);
    const ol = JSON.parse(await rtLog(o));
    check('C5 Aisha got no CMSRU-only note and no CMSRU topic at all', !ol.some(([t, tb]) => t.includes('cmsru') || (tb === 'comments' && t !== 'ws:bank')) &&
      !(await o.js('document.body.textContent.includes("CMSRU only remark")')), ol);
    r = await sql(`update public.drafts set title = 'Secret CMSRU draft' where id = $1`, [D.cmsru], U.LEAD);
    await o.sleep(1200);
    check('C5 a CMSRU draft change sends Aisha nothing', !JSON.parse(await rtLog(o)).some(([, tb]) => tb === 'drafts'));
    check('C5 Aisha cannot join CMSRU by hand', await o.js(`new Promise((res) => window.__inboxMockClient.channel('ws:school:cmsru', { config: { private: true } }).subscribe((s) => res(s)))`) === 'CHANNEL_ERROR');
    check('C5 public channels are refused', await o.js(`new Promise((res) => window.__inboxMockClient.channel('ws:school:cmsru', { config: { private: false } }).subscribe((s) => res(s)))`) === 'CHANNEL_ERROR');

    // Activity tab + badge
    await a.go(BASE + '/inbox/?mock&n=act#/activity');
    await a.waitFor('!!document.getElementById("feed") && document.querySelectorAll("#feed > li[data-when]").length > 0', 10000);
    await a.go(BASE + '/inbox/?mock&n=cat2#/categories');
    await a.waitFor('window.__wsLive.state().ok', 8000);
    const badge = () => a.js('(() => { const n = document.querySelector("#ws-tabs a[href=\'#/activity\'] .n"); return n ? parseInt(n.textContent, 10) : 0; })()');
    const before = await badge();
    await b.click(card(C.asthma) + ' .vote-btn');
    check('C6 Activity badge goes up live', await a.waitFor(`(() => { const n = document.querySelector("#ws-tabs a[href='#/activity'] .n"); return n && parseInt(n.textContent, 10) > ${before}; })()`, 8000), before);
    await a.click('#ws-tabs a[href="#/activity"]');
    await a.waitFor('!!document.getElementById("feed")', 8000);
    r = await sql(`insert into public.comments (target_type, target_id, body, visibility) values ('submission', $1, 'Fresh remark', 'all')`, [C.asthma], U.ADMIN);
    check('C6 a new line appears at the top of the feed, highlighted', await a.waitFor('!!document.querySelector("#feed > li .live-by")', 8000) && /Marcus T\./.test(await a.text('#feed > li[data-when]')));

    check('C6 the type filter chips are untouched by the live line', await a.count('#ws-main [data-at]') === 6 && await a.count('#feed [data-at]') === 0);
    await a.click('#ws-main [data-at="comment"]');
    check('C6 ...and still filter after a live update', await a.waitFor('/events?/.test(document.getElementById("af-n").textContent) && document.querySelector(\'[data-at="comment"]\').getAttribute("aria-pressed") === "true"', 3000));
    check('C7 no console errors', !a.errors.length && !b.errors.length && !o.errors.length, [a.errors, b.errors, o.errors]);
  } finally { a.close(); b.close(); o.close(); }
}
