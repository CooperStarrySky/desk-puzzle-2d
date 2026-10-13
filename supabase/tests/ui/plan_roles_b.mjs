// Second half of plan_roles.e2e.mjs: Activity as the CMSRU admin. Runs of the
// same person on the same draft collapse into one line, the type chips, the
// tab badge = new since your last visit, and each school sees only its own lines.
import { U, C, D } from './seed.mjs';

export async function runActivity({ P, check, sql, go }) {
  // Admin-type lines: a Trash + Restore and a new member, by John D. (the CMSRU lead).
  let r = await sql('select public.trash_submission($1, $2)', [C.cheese, 'Duplicate'], U.LEAD);
  if (r.error) console.log('setup trash: ' + r.error);
  r = await sql('select public.restore_submission($1)', [C.cheese], U.LEAD); if (r.error) console.log('setup restore: ' + r.error);
  r = await sql('select public.add_member($1, $2, $3)', ['new.member@example.edu', 'cmsru', 'admin'], U.LEAD); if (r.error) console.log('setup member: ' + r.error);
  check('A0 CMSRU admin signs in', await P.signInAs(U.ADMIN));
  await P.js('localStorage.removeItem("dp2d:ws-act-seen:' + U.ADMIN + '")');
  check('A0 signs in again (fresh device memory)', await P.signInAs(U.ADMIN));
  const tabBefore = await P.text('#ws-tabs a[href="#/activity"]');
  check('A1 tab badge counts others\' events since the last visit', /^Activity \d+/.test(tabBefore), tabBefore);
  await go('#/activity', '!!document.querySelector("#feed li:not(.day)")');
  await P.sleep(300);
  check('A1 badge clears after the visit', (await P.text('#ws-tabs a[href="#/activity"]')) === 'Activity');
  check('A1 seen time remembered on this device', !!(await P.js('localStorage.getItem("dp2d:ws-act-seen:' + U.ADMIN + '")')));
  check('A2 new lines marked "new"', (await P.count('#feed li.fresh .new-dot')) > 0);
  const run = await P.text('#feed li[data-run=\"3\"] .what');
  check('A3 three placements by the same person in one draft = one line', /Marcus T\. put 3 categories in/.test(run || '') && /Show all 3/.test(run || ''), run);
  await P.click('#feed li[data-run=\"3\"] .run-tg'); await P.sleep(100);
  check('A3 Show all expands the run', (await P.count('#feed li[data-run=\"3\"] .run li')) === 3 && (await P.text('#feed li[data-run=\"3\"] .run-tg')) === 'Hide');
  check('A3 count says events in fewer lines', /\d+ events in \d+ lines/.test(await P.text('#af-n')));
  check('A4 chips: All, Submissions, Drafts, Comments, Publishing, Admin', (await P.js('[...document.querySelectorAll("[data-at]")].map((b) => b.textContent).join("|")')) === 'All|Submissions|Drafts|Comments|Publishing|Admin');
  await P.click('[data-at="publish"]'); await P.sleep(100);
  const pub = await P.text('#feed');
  check('A4 Publishing: schedule + faculty approval lines', /scheduled/.test(pub) && /gave faculty approval to/.test(pub) && !/commented/.test(pub), pub.slice(0, 300));
  await P.click('[data-at="admin"]'); await P.sleep(100);
  const adm = await P.text('#feed');
  check('A4 Admin: Trash, Restore and people lines', /restored from Trash Cheese-related and 1 more like it/.test(adm) && /added new\.member/.test(adm) && !/gave 👍/.test(adm), adm.slice(0, 400));
  await P.click('[data-at="comment"]'); await P.sleep(100);
  check('A4 Comments: comments and 👍', /commented on/.test(await P.text('#feed')) && !/moved to Trash/.test(await P.text('#feed')));
  check('A5 CMSRU never sees RV draft lines', !/RV private draft/.test(await P.js('JSON.stringify(window.__mockState.calls.length) && document.getElementById("feed").textContent')));
  await P.click('[data-at=""]'); await P.sleep(100);
  // Someone else acts: the badge counts it on the next load.
  await sql(`insert into public.comments (target_type, target_id, body) values ('draft', $1, 'Lead thought')`, [D.cmsru], U.LEAD);
  await go('#/planner', '!!document.getElementById("draft-list")');
  await P.js('location.hash = "#/activity"'); await P.waitFor('/Lead thought/.test(document.getElementById("feed").textContent)');
  check('A6 a new event by someone else is marked new', /Lead thought/.test(await P.text('#feed li.fresh')));
  check('A7 other-school admin: no CMSRU draft lines', await (async () => {
    await P.signInAs(U.OTHER); await go('#/activity', '!!document.querySelector("#feed li")'); await P.sleep(300);
    const t = await P.text('#feed'); return !/CMSRU next week|Lead thought|put 3 categories/.test(t) && /RV private draft|From RV/.test(t);
  })());
}
