// node supabase/tests/ui/catdb_roles.e2e.mjs  (needs pg_server.mjs running)
// Category database for faculty, another school's admin, the site owner and a
// stranger. The row rules decide; the page must agree and explain.
import { page, check, summary, resetDb, sql, U, C } from './lib.mjs';

await resetDb();
const P = await page();
const card = (id) => '#sug-list .sug-card[data-id="' + id + '"]';
const line = (id) => P.text(card(id) + ' .card-line');
const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
const menuItem = async (id, act) => { await P.click(card(id) + ' .mnu-btn'); await P.sleep(60); return '.mnu-pop:not([hidden]) [data-mact="' + act + '"]'; };
const openCard = async (id) => { await P.click('#tg-' + id); await P.waitFor('!!document.querySelector("#sd-' + id + ' .sd-cmts .comments")'); };
const closeMenu = () => P.key('Escape', 'Escape', 27);

// ===== Faculty (CMSRU) =====
check('F0 faculty signs in', await P.signInAs(U.FAC)); await P.settle();
check('F1 Add to draft turned off with reason', (await P.attr(card(C.clubbing) + ' [data-addd]', 'aria-disabled')) === 'true');
await P.click(card(C.clubbing) + ' [data-addd]'); await P.sleep(150);
check('F1 clicking explains, no dialog', /Faculty can comment and approve drafts/.test(await P.toast()) && (await P.count('#use-form')) === 0);
let it = await menuItem(C.clubbing, 'trash');
check('F2 Move to Trash disabled for faculty', (await P.attr(it, 'aria-disabled')) === 'true' && /Faculty can’t move categories to Trash/.test(await P.text(it)));
check('F2 Fix disabled for faculty', (await P.attr('.mnu-pop:not([hidden]) [data-mact="fix"]', 'aria-disabled')) === 'true');
await P.click(it); await P.sleep(100);
check('F2 nothing trashed', (await db1('select status from submissions where id = $1', [C.clubbing])).status === 'new');
await closeMenu();
await openCard(C.clubbing);
check('F3 tags read-only', (await P.count('#sd-' + C.clubbing + ' [data-tag]')) === 0 && /Pulm/.test(await P.text('#sd-' + C.clubbing + ' .tag-ed')));
await P.click('#sd-' + C.clubbing + ' [data-act="vote"]'); await P.waitFor('/👍 added/.test(document.getElementById("toast").textContent)');
check('F3 faculty can 👍 (counts for CMSRU)', (await db1('select school from votes where voter_email = $1', [U.FAC])).school === 'cmsru');
await P.type('#sd-' + C.clubbing + ' .cm-in', 'Faculty thought'); await P.click('#sd-' + C.clubbing + ' [data-cact="post"]');
await P.waitFor('/Faculty thought/.test(document.querySelector("#sd-' + C.clubbing + ' .sd-cmts").textContent)');
check('F3 faculty can comment (my school only by default)', (await db1("select visibility from comments where body = 'Faculty thought'")).visibility === 'school');
await P.click('#tg-' + C.clubbing); await P.sleep(100);
await P.js('document.activeElement.blur()'); await P.key('j', 'KeyJ', 74); await P.key('a', 'KeyA', 65); await P.sleep(150);
check('F4 keyboard a explains instead of opening', (await P.count('#use-form')) === 0 && /Faculty/.test(await P.toast()));
await P.js('location.hash = "#/categories/trash"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Trash"'); await P.settle();
check('F5 Restore and reason off in Trash', (await P.js('[...document.querySelectorAll("#sug-list [data-restore], #sug-list [data-why]")].every((b) => b.disabled)')) && (await P.count('#sug-list [data-restore]')) === 2);
await openCard(C.blue);
check('F5 Restore off in the open card too', await P.js('document.querySelector("#sd-' + C.blue + ' [data-act=restore]").disabled'));

// ===== Rowan-Virtua admin =====
check('O0 other-school admin signs in', await P.signInAs(U.OTHER, '#/categories')); await P.settle();
check('O1 votes counted for RV', /👍 4 \(1 from RVSOM\) · 💬 2$/.test(await line(C.clubbing)), await line(C.clubbing));
check('O1 sees RV draft use, not CMSRU\'s', /in 1 draft/.test(await line(C.asthma)) && !/draft/.test(await line(C.lead)));
await openCard(C.clubbing);
const cm = await P.text('#sd-' + C.clubbing + ' .sd-cmts');
check('O2 RV private + all-schools comments, not CMSRU-only', /RV private aside/.test(cm) && /From RV/.test(cm) && !/CMSRU-only note/.test(cm) && !/Faculty thought/.test(cm), cm);
check('O2 comment default from RV settings: All schools', (await P.attr('#sd-' + C.clubbing + ' .vis-tog [data-v="all"]', 'aria-checked')) === 'true');
await P.click('#tg-' + C.clubbing); await P.sleep(100);
it = await menuItem(C.clubbing, 'fix');
check('O3 cannot fix CMSRU\'s original', (await P.attr(it, 'aria-disabled')) === 'true' && /Only CMSRU leads and admins/.test(await P.text(it)));
await closeMenu();
it = await menuItem(C.lead, 'fix'); await P.click(it); await P.waitFor('!!document.querySelector(".fix-ed")');
await P.type('.fix-ed [data-fx="explanation"]', 'Lead blocks heme synthesis.'); await P.click('[data-act="fxsave"]');
await P.waitFor('/Saved 1 fix/.test(document.getElementById("toast").textContent)');
check('O3 fixes its own school\'s original', (await db1("select payload->>'explanation' e from submissions where id = $1", [C.lead])).e === 'Lead blocks heme synthesis.');
await P.click('#tg-' + C.lead); await P.sleep(100);
await P.click(card(C.lead) + ' [data-addd]'); await P.waitFor('!!document.getElementById("use-form")');
const dl = await P.text('#use-form .use-drafts');
check('O4 only RV drafts offered', /RV private draft/.test(dl) && !/CMSRU next week/.test(dl), dl);
await P.key('Escape', 'Escape', 27); await P.sleep(80);
it = await menuItem(C.asthma, 'trash'); await P.click(it); await P.waitFor('/to Trash/.test(document.getElementById("toast").textContent)');
check('O5 any school\'s admin may trash (shared bank)', (await db1('select trashed_by from submissions where id = $1', [C.asthma])).trashed_by === U.OTHER);
await P.clickText('#toast .toast-btn', 'Undo'); await P.waitFor('/Undone/.test(document.getElementById("toast").textContent)');
await P.click('[data-pv="unused"]'); await P.settle();
check('O6 Unused at my school (RV used hemoptysis adapted)', !(await P.count(card(C.hemoptysis))) && (await P.count(card(C.imported))) === 1);

// ===== Site owner (no school row) =====
check('W0 owner signs in, no profile prompt', (await P.signInAs(U.OWNER)) && !(await P.js('!!document.querySelector("#modal-root .scrim")')));
await P.settle();
check('W1 no "Unused at my school" without a school', !/Unused at my school/.test(await P.text('#views')));
check('W1 usage line without a school split', /^Never used · 👍 4 · 💬 \d+$/.test(await line(C.clubbing)), await line(C.clubbing));
await openCard(C.clubbing);
const ocm = await P.text('#sd-' + C.clubbing + ' .sd-cmts');
check('W2 owner reads every comment', /RV private aside/.test(ocm) && /CMSRU-only note/.test(ocm));
await P.click('#tg-' + C.clubbing); await P.sleep(100);
it = await menuItem(C.lead, 'fix');
check('W3 owner may fix any school\'s original', (await P.attr(it, 'aria-disabled')) === null);
await closeMenu();
await P.click(card(C.cheese) + ' [data-addd]'); await P.waitFor('!!document.getElementById("use-form")');
const odl = await P.text('#use-form .use-drafts');
check('W4 owner sees both schools\' drafts', /RV private draft/.test(odl) && /CMSRU next week/.test(odl), odl);
await P.key('Escape', 'Escape', 27);

// ===== Stranger =====
await P.signInAs('nobody@example.com');
check('S1 a stranger gets the "not a member" page', await P.visible('#v-notadmin'));

const errs = P.errors.filter((e) => !/favicon/.test(e));
check('R99 no console errors', errs.length === 0, errs);
P.close(); process.exit(summary());
