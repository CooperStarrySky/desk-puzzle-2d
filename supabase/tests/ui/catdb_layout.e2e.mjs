// node supabase/tests/ui/catdb_layout.e2e.mjs  (needs pg_server.mjs running)
// Phone (375 px) and desktop, light and dark: no sideways scroll, the phone
// "Filters (n)" drawer, open card, menus and dialogs fit; the old full-puzzle
// row still draws; the other tabs load with the new database without errors.
// SHOTS=<dir> saves screenshots.
import fs from 'node:fs';
import { page, check, summary, resetDb, U, C } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const card = (id) => '#sug-list .sug-card[data-id="' + id + '"]';
await resetDb();
let failsBefore = 0;

for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await page({ width: 375, height: 760, mobile: true, dark });
  const shot = async (name) => { if (SHOTS) await P.shot(SHOTS + '/' + name + '-' + tag + '.png'); };
  check(`L0 ${tag}: signs in on a phone`, await P.signInAs(U.ADMIN)); await P.settle();
  check(`L0 ${tag}: theme applied`, (await P.attr('html', 'data-theme')) === tag);
  check(`L1 ${tag}: database fits 375 px`, (await P.overflow()) <= 0, await P.overflow()); await shot('db');
  check(`L1 ${tag}: filters hidden behind "Filters"`, !(await P.visible('#filters')) && (await P.visible('#f-toggle')));
  await P.click('#f-toggle'); await P.sleep(150);
  check(`L2 ${tag}: drawer opens over the page`, (await P.js('getComputedStyle(document.getElementById("filters")).position')) === 'fixed' && (await P.js('getComputedStyle(document.getElementById("f-scrim")).display')) === 'block' && (await P.visible('#f-apply')));
  await P.click('#filters [data-f="block"][data-v="Pulm"]'); await P.sleep(300);
  check(`L2 ${tag}: "Show n results" + "Filters (1)"`, /Show 3 results/.test(await P.text('#f-apply')) && (await P.text('#f-toggle')) === 'Filters (1)');
  check(`L2 ${tag}: drawer fits`, (await P.overflow()) <= 0); await shot('drawer');
  await P.key('Escape', 'Escape', 27); await P.sleep(100);
  check(`L2 ${tag}: Escape closes the drawer, focus back on the button`, (await P.js('getComputedStyle(document.getElementById("f-scrim")).display')) === 'none' && (await P.focused()) === 'f-toggle');
  check(`L2 ${tag}: chips shown above the list`, /Pulm/.test(await P.text('#active-f')));
  await P.click('#af-clear'); await P.settle();
  await P.click(card(C.hemoptysis) + ' .mnu-btn'); await P.sleep(100);
  const pop = await P.js('(() => { const r = document.querySelector(".mnu-pop:not([hidden])").getBoundingClientRect(); return [r.left, r.right]; })()');
  check(`L3 ${tag}: ⋯ menu stays on screen`, pop[0] >= 0 && pop[1] <= 375, pop); await shot('menu');
  await P.key('Escape', 'Escape', 27);
  await P.click('#tg-' + C.hemoptysis); await P.waitFor('!!document.querySelector("#sd-' + C.hemoptysis + ' .use-tbl")');
  check(`L4 ${tag}: open card with usage table fits`, (await P.overflow()) <= 0, await P.overflow()); await shot('open');
  await P.click('#sd-' + C.hemoptysis + ' [data-act="draft"]'); await P.waitFor('!!document.getElementById("use-form")');
  check(`L5 ${tag}: Add to draft dialog fits`, (await P.overflow()) <= 0); await shot('add');
  await P.key('Escape', 'Escape', 27);
  await P.js('location.hash = "#/categories/trash"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Trash"'); await P.settle();
  check(`L6 ${tag}: Trash fits`, (await P.overflow()) <= 0); await shot('trash');
  check(`L7 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

// Desktop (dark) + the old full-puzzle row + the other tabs on the new database.
const P = await page({ width: 1366, height: 900, dark: true });
check('D0 desktop dark signs in', await P.signInAs(U.LEAD)); await P.settle();
check('D1 desktop fits, filter panel always visible', (await P.overflow()) <= 0 && (await P.visible('#filters')) && !(await P.visible('#f-toggle')));
check('D2 old full-puzzle row draws, no kind badge', (await P.count(card(C.oldpuzzle) + ' .grp-inline li')) === 1 && (await P.count('.kind-tag.puzzle')) === 0);
await P.click('#tg-' + C.oldpuzzle); await P.waitFor('!!document.querySelector("#sd-' + C.oldpuzzle + ' .sd-cmts .comments")');
await P.click(card(C.oldpuzzle) + ' .mnu-btn'); await P.sleep(60);
check('D2 old full puzzle: fix explains why not', /Old full-puzzle suggestions/.test(await P.text('.mnu-pop:not([hidden]) [data-mact="fix"]')));
await P.key('Escape', 'Escape', 27);
if (SHOTS) await P.shot(SHOTS + '/desktop-dark.png');
for (const [hash, sel] of [['#/planner', '#ws-main h1'], ['#/activity', '#ws-main h1'], ['#/calendar', '#ws-main h1'], ['#/archive', '#ws-main h1']]) {
  await P.js('location.hash = "' + hash + '"'); await P.sleep(1200);
  check('D3 ' + hash + ' loads', (await P.count(sel)) === 1 && !(await P.count('#ws-main .err-box')), await P.text('#ws-main'));
}
check('D4 no console errors', P.errors.length === 0, P.errors);
P.close();
process.exit(summary() + failsBefore);
