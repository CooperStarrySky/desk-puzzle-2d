// node supabase/tests/ui/plan_roles.e2e.mjs  (needs pg_server.mjs running)
// Planner, Calendar and Activity for faculty (approve, edited since approval,
// re-approve, seal hidden when the school turns it off), another school's
// admin (draft privacy both ways, calendar line without the title), the site
// owner (every school, school chips, one lane per school), and Activity
// grouping, type chips and "new since last visit".
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';
import { nextThursday, etToIso, addDays } from '../../../inbox/ws-plan-time.js';
import { runActivity } from './plan_roles_b.mjs';

await resetDb();
const P = await page();
const db1 = async (q, p, who) => ((await sql(q, p, who)).rows || [])[0] || {};
const toastHas = (re) => P.waitFor(re + '.test(document.getElementById("toast").textContent)', 8000);
const go = async (hash, ready) => { await P.js('location.hash = "' + hash + '"'); return P.waitFor(ready || '!!document.querySelector("#ws-main h1")'); };
const openDraft = (id) => go('#/planner/' + id, '!!document.querySelector("#slots .slot") && !!document.querySelector("#ck-panel .ck-head")');
const thu = nextThursday(), MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const thuWords = 'Thursday, ' + MON[Number(thu.slice(5, 7)) - 1] + ' ' + Number(thu.slice(8, 10));

// The CMSRU draft: 4 categories (put in by Marcus, the admin, one after another), then scheduled.
for (const [t, id] of [[1, C.clubbing], [2, C.imported], [4, C.cheese]]) {
  const r = await sql('insert into public.draft_slots (draft_id, tier, submission_id) values ($1, $2, $3)', [D.cmsru, t, id], U.ADMIN);
  if (r.error) console.log('setup: ' + r.error);
}
let r = await sql(`update public.drafts set status = 'scheduled', target_release = $2 where id = $1`, [D.cmsru, etToIso(thu, '06:00')], U.ADMIN);
check('setup: CMSRU draft scheduled for next Thursday', !r.error, r.error);
// A published CMSRU puzzle from the site's own files, approved by faculty (for the Archive).
await sql(`insert into public.drafts (title, status, owner_email, school, published_puzzle_id, published_at, faculty_approved_by, faculty_approved_at)
  values ('Holes draft', 'published', $1, 'cmsru', 'holes-haze-and-old-paint-2026-10-08', now() - interval '5 days', $2, now() - interval '6 days')`, [U.ADMIN, U.FAC]);

// ===== Faculty =====
check('F0 faculty signs in', await P.signInAs(U.FAC));
await go('#/planner', '!!document.getElementById("draft-list")');
check('F1 sees the CMSRU draft, no New draft button', /CMSRU next week/.test(await P.text('#draft-list')) && !(await P.count('#pl-new')));
await openDraft(D.cmsru);
check('F2 read-only slots: no Edit, no ⋯, no Add category', !(await P.count('#slots [data-adapt]')) && !(await P.count('#slots .mnu-btn')) && !(await P.count('#add-cat')) && !(await P.count('#lib-list [data-add]')));
check('F2 "Approve puzzle" offered, never blocks', (await P.text('#appr-go')) === 'Approve puzzle' && /never wait on it/.test(await P.text('#appr')));
await P.click('#appr-go'); await toastHas('/Approved/');
check('F3 seal shows the approver', (await P.attr('#appr .seal', 'aria-label') || '').startsWith('Faculty approved by Dr. Lee') && /Faculty approved ✓ Dr. Lee/.test(await P.text('#appr-h')));
check('F3 stamped in the database, status untouched', (await db1('select faculty_approved_by b, status from public.drafts where id = $1', [D.cmsru])).b === U.FAC);
check('F3 Remove my approval offered', (await P.text('#appr-x')) === 'Remove my approval');
await go('#/planner', '!!document.getElementById("draft-list")');
check('F4 small seal on the draft card', /Faculty approved · Dr. Lee/.test(await P.text('.draft-card[data-did="' + D.cmsru + '"] .seal-sm')));
await go('#/calendar', '!!document.querySelector(".cal-week")');
check('F4 ✓ chip with a tooltip on the Calendar', /^Faculty approved by Dr. Lee/.test(await P.attr('.cal-item[href="#/planner/' + D.cmsru + '"] .seal-xs', 'title') || ''));
await go('#/archive', '!!document.querySelector(".arch-card")');
check('F4 Archive shows faculty ✓ on the published puzzle', /Faculty approved · Dr. Lee/.test(await P.text('.arch-card[data-pid="holes-haze-and-old-paint-2026-10-08"] .seal-sm') || ''));
// The admin changes the puzzle after approval.
await P.sleep(1100);
r = await sql(`update public.draft_slots set adapted = jsonb_set((select payload from public.submissions where id = $2), '{name}', '"Clubbing v2"') where draft_id = $1 and tier = 1`, [D.cmsru, C.clubbing], U.ADMIN);
check('setup: admin adapts a slot after approval', !r.error, r.error);
await openDraft(D.cmsru);
check('F5 "Edited since approval" on the seal', /Edited since approval/.test(await P.text('#appr-edited')) && (await P.count('#appr .seal.edited')) === 1);
check('F5 Re-approve offered', (await P.text('#appr-go')) === 'Re-approve');
await P.click('#appr-go'); await toastHas('/Re-approved/');
check('F6 after re-approve the note is gone', !(await P.count('#appr-edited')) && (await P.count('#appr .seal:not(.edited)')) === 1);
// Badge off for CMSRU: the seal disappears everywhere (sign in again to read settings).
await sql(`update public.school_settings set faculty_badge = false where school = 'cmsru'`);
check('F7 faculty signs in again', await P.signInAs(U.FAC));
await openDraft(D.cmsru);
check('F7 badge off: no approval panel at all', (await P.js('document.getElementById("appr").hidden')) === true && !(await P.count('.seal, .seal-sm, .seal-xs')));
await go('#/calendar', '!!document.querySelector(".cal-week")');
check('F7 badge off: no ✓ on the Calendar', !(await P.count('.seal-xs')));
await sql(`update public.school_settings set faculty_badge = true where school = 'cmsru'`);

// ===== Rowan-Virtua admin =====
check('O0 other-school admin signs in', await P.signInAs(U.OTHER));
await go('#/planner', '!!document.getElementById("draft-list")');
check('O1 only RV drafts', /RV private draft/.test(await P.text('#draft-list')) && !/CMSRU next week|Holes draft/.test(await P.text('#ws-main')));
await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await toastHas('/isn’t there/');
check('O2 a CMSRU draft link opens nothing', !(await P.count('#editor')) && !/CMSRU next week/.test(await P.text('#ws-main')));
await go('#/calendar', '!!document.querySelector(".cal-week")');
const xline = await P.text('.cal-x .grow');
check('O3 CMSRU release as a content-free line', (xline || '').startsWith('Cooper Medical School of Rowan University has scheduled a puzzle to release ' + thuWords), xline);
const html = await P.js('document.documentElement.innerHTML');
check('O3 the line leaks no title, topic or category', !/CMSRU next week|Clubbing v2|Holes draft|Causes of clubbing/.test(html));
const rpcCall = await P.js('JSON.stringify(window.__mockState.calls.filter((c) => c.rpc === "other_school_releases"))');
check('O3 asked other_school_releases for 8 weeks', /p_from/.test(rpcCall) && /p_to/.test(rpcCall));
// RV schedules too; CMSRU sees a line, not the title.
await sql(`update public.drafts set status = 'scheduled', target_release = $2 where id = $1`, [D.rv, etToIso(addDays(thu, 7), '06:00')]);
check('O4 CMSRU admin signs in', await P.signInAs(U.ADMIN));
await go('#/calendar', '!!document.querySelector(".cal-week")');
check('O4 CMSRU sees "Rowan-Virtua SOM has scheduled…" and no RV title', /Rowan-Virtua SOM has scheduled a puzzle to release Thursday/.test(await P.text('#ws-main')) && !/RV private draft/.test(await P.js('document.documentElement.innerHTML')));
check('O4 own scheduled week shows the draft (Scheduled)', /CMSRU next week/.test(await P.text('.cal-week[data-week] .cal-lane')) || /CMSRU next week/.test(await P.text('#ws-main')));
check('O4 a gap week: Nothing planned + Start a draft', (await P.count('.cal-state.gap [data-startwk]')) > 0);
await go('#/planner', '!!document.getElementById("draft-list")');
check('O5 CMSRU admin never sees the RV draft', !/RV private draft/.test(await P.text('#ws-main')));

// ===== Site owner =====
check('W0 owner signs in', await P.signInAs(U.OWNER));
await go('#/planner', '!!document.getElementById("draft-list")');
check('W1 owner sees every school with chips', /Site owner view/.test(await P.text('#priv-note')) && /RV private draft/.test(await P.text('#draft-list')) && /CMSRU next week/.test(await P.text('#draft-list')));
await P.click('[data-psch="rvsom"]'); await P.sleep(150);
check('W1 school chip filters', /RV private draft/.test(await P.text('#draft-list')) && !/CMSRU next week/.test(await P.text('#draft-list')));
await go('#/calendar', '!!document.querySelector(".cal-week")');
check('W2 one lane per school', (await P.count('.cal-week:first-of-type .cal-lane')) >= 2 && (await P.count('.cal-lane[data-lane="rvsom"]')) === 8 && (await P.count('.cal-x')) === 0);
check('W2 RV scheduled week shows its title to the owner', /RV private draft/.test(await P.text('#ws-main')));

await runActivity({ P, check, sql, db1, go, toastHas });
check('Z no console errors', P.errors.length === 0, P.errors);
P.close();
process.exit(summary());
