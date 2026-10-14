// node supabase/tests/ui/admin_owner.e2e.mjs  (needs pg_server.mjs running)
// Admin console and Settings as the site owner: roles explainer, people table
// with last sign-in and status, Add person (never a password), Change role,
// Move school, Remove access / Give access back, Add school wizard, turning a
// school on for the Studio list, Settings (Trash auto-delete, faculty seal,
// comment default) and the What's new line.
import { page, check, summary, resetDb, sql, U } from './lib.mjs';

await resetDb();
const P = await page();
const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
const toastHas = (re) => P.waitFor(re + '.test(document.getElementById("toast").textContent)', 8000);
const row = (email) => `[...document.querySelectorAll("#people tbody tr")].find((r) => r.children[1] && r.children[1].textContent === ${JSON.stringify(email)})`;
const rowText = (email) => P.js(`(() => { const r = ${row(email)}; return r ? r.textContent.replace(/\\s+/g, ' ') : null; })()`);
const act = (email, a) => P.js(`(() => { const r = ${row(email)}; const b = r && r.querySelector('[data-pa="${a}"]'); if (!b) return false; b.click(); return true; })()`);
const goAdmin = async () => { await P.js('location.hash = "#/admin"'); return P.waitFor('!!document.querySelector("#people tbody") && !!document.querySelector("#schools .school-card")'); };

check('O0 owner signs in', await P.signInAs(U.OWNER)); await P.settle();
check('O0 Admin tab shown to the owner', /Admin/.test(await P.text('#ws-tabs')));
check('O0 header says All schools', (await P.text('#brand-sub')) === 'Desk Puzzle · All schools');
check('O1 console opens', await goAdmin());
check('O1 eyebrow: site owner; 4 role cards', /site owner/.test(await P.text('#ws-main .eyebrow')) && (await P.count('.role-card')) === 4);
check('O2 owner row first, then every school\'s people', /Site owner/.test(await P.text('#people tbody tr')) && (await P.count('#people tbody tr')) === 5);
check('O2 last sign-in column', /Last sign-in/.test(await P.text('#people thead')));
check('O2 Dr. Lee never signed up', /never.*Not signed up yet/.test(await rowText(U.FAC)), await rowText(U.FAC));
check('O2 Marcus active, with actions', /Active/.test(await rowText(U.ADMIN)) && /Change role.*Move school.*Remove access/.test(await rowText(U.ADMIN)));
await P.click('[data-asch="rvsom"]'); await P.sleep(100);
check('O3 school chip filters the table', (await P.count('#people tbody tr')) === 1 && !!(await rowText(U.OTHER)));
await P.click('[data-asch=""]'); await P.sleep(100);

// Add person
await P.click('#add-person'); await P.waitFor('!!document.getElementById("ap-e")');
check('O4 add person: school and role choices (owner may add a lead)', (await P.count('#ap-s option')) === 2 && /School lead/.test(await P.text('#ap-r')) && !(await P.js('document.getElementById("ap-s").disabled')));
check('O4 no password field anywhere', (await P.count('.modal input[type=password]')) === 0 && /choose their own password/.test(await P.text('.modal')));
await P.type('#ap-e', 'not-an-email'); await P.click('.modal .btn.primary'); await P.sleep(150);
check('O4 bad email refused in the dialog', /full email/.test(await P.text('.modal .err')));
await P.type('#ap-e', 'New.Fac@Example.edu');
await P.js('(() => { const s = document.getElementById("ap-s"); s.value = "rvsom"; const r = document.getElementById("ap-r"); r.value = "faculty"; })()');
await P.click('.modal .btn.primary');
check('O4 invite note to send (nothing emailed from here)', await P.waitFor('!!document.getElementById("inv-msg")') && /Create account/.test(await P.text('#inv-msg')) && /new\.fac@example\.edu/.test(await P.text('#inv-msg')) && /\/inbox\//.test(await P.text('#inv-msg')));
await P.clickText('.modal .btn', 'Done'); await P.sleep(150);
check('O4 added: RV faculty, tidied email', (await db1(`select role, school, added_by from public.members where email = 'new.fac@example.edu'`)).role === 'faculty');
check('O4 table shows them, not signed up yet', /Not signed up yet/.test(await rowText('new.fac@example.edu')));
// Change role
await act('new.fac@example.edu', 'role'); await P.waitFor('!!document.getElementById("pr")');
await P.js('document.getElementById("pr").value = "admin"'); await P.click('.modal .btn.primary'); await toastHas('/is now School admin/');
check('O5 change role saved', (await db1(`select role from public.members where email = 'new.fac@example.edu'`)).role === 'admin');
// Move school
await act('new.fac@example.edu', 'move'); await P.waitFor('!!document.getElementById("pm")');
check('O6 move offers the other schools only', !(await P.js('[...document.getElementById("pm").options].some((o) => o.value === "rvsom")')));
await P.js('document.getElementById("pm").value = "cmsru"'); await P.click('.modal .btn.primary'); await toastHas('/Moved/');
check('O6 moved to CMSRU', (await db1(`select school from public.members where email = 'new.fac@example.edu'`)).school === 'cmsru');
// Remove access, give it back
await act('new.fac@example.edu', 'remove'); await P.waitFor('/Remove access for/.test(document.querySelector(".modal") ? document.querySelector(".modal").textContent : "")');
check('O7 remove explains history stays', /past comments, votes, and history stay/.test(await P.text('.modal')));
await P.click('.modal .btn.primary'); await toastHas('/Removed workspace access/');
check('O7 access removed (row kept)', (await db1(`select active from public.members where email = 'new.fac@example.edu'`)).active === false && /Access removed.*Give access back/.test(await rowText('new.fac@example.edu')));
await act('new.fac@example.edu', 'restore'); await toastHas('/can sign in again/');
check('O7 give access back', (await db1(`select active from public.members where email = 'new.fac@example.edu'`)).active === true);
check('O7 people changes logged for Activity', (await db1(`select count(*)::int n from public.member_events where target_email = 'new.fac@example.edu'`)).n === 6); // add, role, move (both schools), remove, restore

// Add school
await P.click('#add-school'); await P.waitFor('!!document.getElementById("as-n")');
await P.type('#as-n', 'Pinebrook College of Medicine');
check('O8 short code suggested from the name', (await P.js('document.getElementById("as-c").value')) === 'pinebrook-college-of-med');
await P.type('#as-c', 'cmsru'); await P.type('#as-e', 'pb.lead@example.edu'); await P.click('#as-go'); await P.sleep(150);
check('O8 taken short code refused', /taken/.test(await P.text('#as-err')));
await P.type('#as-c', 'pinebrook'); await P.click('#as-go');
check('O8 next steps shown', await P.waitFor('/is set up to start/.test(document.querySelector(".modal") ? document.querySelector(".modal").textContent : "")') && (await P.count('.modal .steps li')) === 3);
await P.click('#ns-note'); await P.waitFor('!!document.getElementById("inv-msg")');
check('O8 note for the new lead', /School lead at Pinebrook College of Medicine/.test(await P.text('#inv-msg')));
await P.clickText('.modal .btn', 'Done'); await P.sleep(150);
const pb = await db1(`select s.status, m.role from public.schools s join public.members m on m.school = s.slug where s.slug = 'pinebrook'`);
check('O8 school in setup, lead listed', pb.status === 'setup' && pb.role === 'lead', pb);
const card = '#schools [data-school="pinebrook"]';
check('O8 card: setting up, 3 steps waiting', /Setting up/.test(await P.text(card)) && (await P.count(card + ' .steps li.done')) === 0);
await P.click(card + ' [data-sact="active"]'); await toastHas('/is now in the Studio/');
check('O9 turned on for the Studio list', (await db1(`select status from public.schools where slug = 'pinebrook'`)).status === 'active' &&
  ((await sql('select slug from public.active_schools()', [], 'anon')).rows || []).some((r) => r.slug === 'pinebrook'));
await P.waitFor('!!document.querySelector(\'' + card + ' [data-sact="setup"]\')');
await P.click(card + ' [data-sact="setup"]'); await P.waitFor('!!document.getElementById("ss-ok")'); await P.click('#ss-ok'); await toastHas('/off the Studio list/');
check('O9 taken off again', (await db1(`select status from public.schools where slug = 'pinebrook'`)).status === 'setup');

// Settings
await P.click('#gear-btn'); await P.waitFor('!!document.getElementById("set-ad")');
check('O10 owner: school picker, trash setting enabled', (await P.count('#set-pick option')) === 3 && !(await P.js('document.getElementById("set-ad").disabled')) && (await P.js('document.getElementById("set-ad").value')) === '');
await P.js('(() => { const s = document.getElementById("set-ad"); s.value = "90"; s.dispatchEvent(new Event("change")); })()'); await toastHas('/90 days/');
check('O10 Trash auto-delete saved (90 days)', (await db1('select trash_retention_days d from public.site_settings')).d === 90);
await P.js('(() => { const s = document.getElementById("set-ad"); s.value = ""; s.dispatchEvent(new Event("change")); })()'); await toastHas('/never deleted/');
check('O10 back to Never', (await db1('select trash_retention_days d from public.site_settings')).d === null);
await P.js('(() => { const s = document.getElementById("set-pick"); s.value = "rvsom"; s.dispatchEvent(new Event("change")); })()'); await P.sleep(100);
await P.click('#set-fac'); await toastHas('/seal off for Rowan-Virtua SOM/');
check('O10 faculty seal off for RV', (await db1(`select faculty_badge f from public.school_settings where school = 'rvsom'`)).f === false && (await P.attr('#set-fac', 'aria-checked')) === 'false');
await P.js('(() => { const s = document.getElementById("set-cm"); s.value = "school"; s.dispatchEvent(new Event("change")); })()'); await toastHas('/My school only/');
check('O10 RV comment default saved', (await db1(`select comment_default c from public.school_settings where school = 'rvsom'`)).c === 'school');
await P.key('Escape', 'Escape', 27);

// What's new on the Category database
await P.js('location.hash = "#/categories"'); await P.waitFor('!!document.getElementById("wn-line")');
check('O11 one-line What\'s new on the Category database', /What’s new in this release \(9\)/.test(await P.text('#wn-line')) && (await P.count('#wn-list')) === 0);
await P.click('#wn-x'); await P.sleep(80);
check('O11 opens to the list of changes', (await P.count('#wn-list li')) === 9 && (await P.attr('#wn-x', 'aria-expanded')) === 'true');
await P.click('#wn-gone'); await P.sleep(80);
check('O11 dismissed', (await P.count('#wn-line')) === 0);
await P.js('location.hash = "#/planner"'); await P.sleep(300); await P.js('location.hash = "#/categories"'); await P.sleep(400);
check('O11 stays dismissed', (await P.count('#wn-line')) === 0);
await P.click('#gear-btn'); await P.waitFor('!!document.getElementById("set-wn")'); await P.click('#set-wn'); await P.key('Escape', 'Escape', 27); await P.sleep(150);
check('O11 Settings brings it back', (await P.count('#wn-line')) === 1);
check('O12 no console errors', P.errors.length === 0, P.errors);
P.close();
process.exit(summary() ? 1 : 0);
