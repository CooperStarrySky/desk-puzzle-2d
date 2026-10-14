// node supabase/tests/ui/admin_roles.e2e.mjs  (needs pg_server.mjs running)
// Admin console and Settings for everyone who is not the site owner:
// a school lead (own school only, no leads, no Move school, no Add school,
// school settings yes, Trash setting locked), and an admin and a faculty
// member (no Admin tab, #/admin falls back, Settings opens with every row
// locked). The database refuses the same things the screen hides.
import { page, check, summary, resetDb, sql, U } from './lib.mjs';

await resetDb();
const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
const rpcAs = async (who, q, p) => sql(q, p, who);

// ===== School lead (John D., CMSRU) =====
let P = await page();
const toastHas = (re) => P.waitFor(re + '.test(document.getElementById("toast").textContent)', 8000);
const row = (email) => `[...document.querySelectorAll("#people tbody tr")].find((r) => r.children[1] && r.children[1].textContent === ${JSON.stringify(email)})`;
const rowText = (email) => P.js(`(() => { const r = ${row(email)}; return r ? r.textContent.replace(/\\s+/g, ' ') : null; })()`);
const act = (email, a) => P.js(`(() => { const r = ${row(email)}; const b = r && r.querySelector('[data-pa="${a}"]'); if (!b) return false; b.click(); return true; })()`);

check('L0 lead signs in', await P.signInAs(U.LEAD)); await P.settle();
check('L0 Admin tab shown to a lead', /Admin/.test(await P.text('#ws-tabs')));
await P.js('location.hash = "#/admin"');
check('L1 console opens', await P.waitFor('!!document.querySelector("#people tbody") && !!document.querySelector("#schools .school-card")'));
check('L1 eyebrow names the school; lead note', /school lead, Cooper Medical School/.test(await P.text('#ws-main .eyebrow')) && /Other schools and new schools are the site owner/.test(await P.text('#ws-main .priv-note')));
check('L2 only CMSRU people (3), no owner row, no school chips', (await P.count('#people tbody tr')) === 3 && !(await rowText(U.OTHER)) && !(await rowText(U.OWNER)) && (await P.count('[data-asch]')) === 0);
check('L2 own lead row: site owner only', /Site owner only/.test(await rowText(U.LEAD)) && /\(you\)/.test(await rowText(U.LEAD)));
check('L2 no Move school, no Add school', (await P.count('[data-pa="move"]')) === 0 && (await P.count('#add-school')) === 0);
check('L2 schools: own school card only, no Studio on/off', (await P.count('#schools .school-card')) === 1 && (await P.count('#schools [data-sact]')) === 0);

await P.click('#add-person'); await P.waitFor('!!document.getElementById("ap-e")');
check('L3 add person: school fixed, no lead role', (await P.js('document.getElementById("ap-s").disabled')) && (await P.count('#ap-s option')) === 1 &&
  !/School lead/.test(await P.text('#ap-r')) && /School admin/.test(await P.text('#ap-r')));
await P.type('#ap-e', 'john.doe2@example.edu'); await P.js('document.getElementById("ap-r").value = "faculty"'); await P.click('.modal .btn.primary');
check('L3 invite note', await P.waitFor('!!document.getElementById("inv-msg")') && /Faculty at Cooper Medical School/.test(await P.text('#inv-msg')));
await P.clickText('.modal .btn', 'Done'); await P.sleep(150);
check('L3 added as CMSRU faculty', (await db1(`select role, school from public.members where email = 'john.doe2@example.edu'`)).school === 'cmsru');

await act(U.FAC, 'role'); await P.waitFor('!!document.getElementById("pr")');
check('L4 change role: admin/faculty only', (await P.count('#pr option')) === 2);
await P.js('document.getElementById("pr").value = "admin"'); await P.click('.modal .btn.primary'); await toastHas('/is now School admin/');
check('L4 Dr. Lee now admin', (await db1(`select role from public.members where email = $1`, [U.FAC])).role === 'admin');
await act('john.doe2@example.edu', 'remove'); await P.waitFor('!!document.querySelector(".modal .btn.primary")');
await P.click('.modal .btn.primary'); await toastHas('/Removed workspace access/');
check('L5 remove access', (await db1(`select active from public.members where email = 'john.doe2@example.edu'`)).active === false);
await act('john.doe2@example.edu', 'restore'); await toastHas('/can sign in again/');
check('L5 give access back', (await db1(`select active from public.members where email = 'john.doe2@example.edu'`)).active === true);

// The database says no to the same things.
const refused = async (q, p) => !!(await rpcAs(U.LEAD, q, p)).error;
check('L6 DB: lead cannot make a lead', await refused(`select public.change_role($1, 'cmsru', 'lead')`, [U.ADMIN]));
check('L6 DB: lead cannot move a person', await refused(`select public.move_school($1, 'cmsru', 'rvsom')`, [U.ADMIN]));
check('L6 DB: lead cannot add to another school', await refused(`select public.add_member('x.y@example.edu', 'rvsom', 'admin')`));
check('L6 DB: lead cannot add a school', await refused(`select public.add_school('nope', 'Nope School', 'a.b@example.edu')`));
check('L6 DB: lead cannot remove another school\'s admin', await refused(`select public.set_member_active($1, 'rvsom', false)`, [U.OTHER]) ||
  (await db1(`select active from public.members where email = $1`, [U.OTHER])).active === true);

await P.click('#gear-btn'); await P.waitFor('!!document.getElementById("set-ad")');
check('L7 settings: one school, no picker', (await P.count('#set-pick')) === 0 && /Cooper Medical School/.test(await P.text('#set-sch legend')));
check('L7 Trash setting locked for a lead', (await P.js('document.getElementById("set-ad").disabled')) && /Only the site owner/.test(await P.text('.modal')));
await P.click('#set-fac'); await toastHas('/seal off for Cooper/');
check('L7 lead turns the faculty seal off', (await db1(`select faculty_badge f from public.school_settings where school = 'cmsru'`)).f === false);
await P.js('(() => { const s = document.getElementById("set-cm"); s.value = "all"; s.dispatchEvent(new Event("change")); })()'); await toastHas('/All schools/');
check('L7 lead sets comment default', (await db1(`select comment_default c from public.school_settings where school = 'cmsru'`)).c === 'all');
check('L7 DB: lead cannot set Trash retention', ((await rpcAs(U.LEAD, 'update public.site_settings set trash_retention_days = 30 returning 1')).rows || []).length === 0 &&
  (await db1('select trash_retention_days d from public.site_settings')).d == null);
check('L7 DB: lead cannot change RV settings', ((await rpcAs(U.LEAD, `update public.school_settings set faculty_badge = false where school = 'rvsom' returning 1`)).rows || []).length === 0);
await P.key('Escape', 'Escape', 27);
check('L8 no console errors', P.errors.length === 0, P.errors);
P.close();

// ===== School admin and faculty: no console, Settings all locked =====
for (const [tag, who] of [['A', U.ADMIN], ['F', 'john.doe2@example.edu']]) {
  if (tag === 'F') await sql(`update public.members set role = 'faculty' where email = $1`, [who]);
  if (tag === 'F') await sql(`insert into auth.users (email, last_sign_in_at) values ($1, now()) on conflict do nothing`, [who]);
  P = await page();
  check(`${tag}0 signs in`, await P.signInAs(who)); await P.settle();
  check(`${tag}0 no Admin tab`, !/Admin/.test(await P.text('#ws-tabs')));
  await P.js('location.hash = "#/admin"'); await P.sleep(500);
  check(`${tag}1 #/admin falls back to the Category database`, (await P.count('#people')) === 0 && (await P.count('#sug-list')) === 1);
  check(`${tag}1 DB: cannot add people`, !!(await rpcAs(who, `select public.add_member('z.z@example.edu', 'cmsru', 'faculty')`)).error);
  await P.click('#gear-btn'); await P.waitFor('!!document.getElementById("set-ad")');
  check(`${tag}2 Settings opens, every school row locked`, (await P.js('document.getElementById("set-fac").disabled && document.getElementById("set-cm").disabled && document.getElementById("set-ad").disabled')) &&
    /Only this school’s lead or the site owner/.test(await P.text('.modal')));
  check(`${tag}2 What's new button still works for them`, (await P.click('#set-wn')) && await P.waitFor('/What’s new is back/.test(document.getElementById("toast").textContent)', 4000));
  await P.key('Escape', 'Escape', 27);
  check(`${tag}3 no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

// ===== Phone, light and dark: console and Settings fit 375 px =====
for (const dark of [false, true]) {
  const t = dark ? 'dark' : 'light';
  P = await page({ width: 375, height: 760, mobile: true, dark });
  await P.signInAs(U.OWNER); await P.settle();
  await P.js('location.hash = "#/admin"'); await P.waitFor('!!document.querySelector("#schools .school-card")');
  check(`M1 ${t}: Admin console fits 375 px`, (await P.overflow()) <= 0, await P.overflow());
  await P.click('#add-school'); await P.waitFor('!!document.getElementById("as-n")');
  check(`M2 ${t}: Add school fits`, (await P.overflow()) <= 0);
  await P.key('Escape', 'Escape', 27); await P.sleep(150);
  await P.click('#gear-btn'); await P.waitFor('!!document.getElementById("set-ad")');
  check(`M3 ${t}: Settings fits`, (await P.overflow()) <= 0 && (await P.js('(() => { const r = document.querySelector(".modal").getBoundingClientRect(); return r.left >= 0 && r.right <= 375; })()')));
  await P.key('Escape', 'Escape', 27);
  await P.js('location.hash = "#/categories"'); await P.waitFor('!!document.getElementById("wn-line")');
  check(`M4 ${t}: What's new line fits`, (await P.overflow()) <= 0);
  check(`M5 ${t}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}
process.exit(summary() ? 1 : 0);
