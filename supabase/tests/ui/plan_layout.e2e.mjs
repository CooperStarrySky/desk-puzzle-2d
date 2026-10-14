// node supabase/tests/ui/plan_layout.e2e.mjs  (needs pg_server.mjs running)
// Phone (375 px), light and dark: Planner list, draft editor with the slots
// first and the library as a bottom sheet, the per-clue editor and the
// Adapted panel, approval panel, Calendar, Activity and Archive all fit with
// no sideways scroll. Desktop: Archive links to the Category database (no
// "Reuse as starting point"), Calendar "Start a draft for this week".
// SHOTS=<dir> saves screenshots.
import fs from 'node:fs';
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
await resetDb();
// One adapted slot so the "Adapted · N changes" panel can be checked on a phone.
await sql(`update public.draft_slots set adapted = jsonb_set(jsonb_set((select payload from public.submissions where id = $2), '{name}', '"Lead signs, CMSRU cut"'), '{items,1,label}', '"A much longer clue text that has to wrap nicely on a small phone screen"') where draft_id = $1 and tier = 3`, [D.cmsru, C.lead]);
// Hemoptysis went out in the live puzzle (category_uses), so the Archive can link it.
await sql(`insert into public.category_uses (submission_id, school, puzzle_id, puzzle_date) values ($1, 'cmsru', 'holes-haze-and-old-paint-2026-10-08', '2026-10-08')`, [C.hemoptysis]);
const slot = (t) => "#slots .slot[data-t='" + t + "']";

for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await page({ width: 375, height: 760, mobile: true, dark });
  const shot = async (name) => { if (SHOTS) await P.shot(SHOTS + '/plan-' + name + '-' + tag + '.png'); };
  const fits = async (name) => { const o = await P.overflow(); check(`${name} ${tag}: fits 375 px`, o <= 0, o); await shot(name.replace(/\W+/g, '-')); };
  check(`P0 ${tag}: admin signs in on a phone`, await P.signInAs(U.ADMIN));
  await P.js('location.hash = "#/planner"'); await P.waitFor('!!document.getElementById("draft-list")');
  await fits('P1 draft list');
  await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("#slots .slot.filled")');
  const order = await P.js('(() => { const s = document.querySelector(".mid-a").getBoundingClientRect().top, l = document.getElementById("lib"); return [s, getComputedStyle(l).display]; })()');
  check(`P2 ${tag}: slots first, library hidden until asked`, order[1] === 'none' && (await P.visible('#add-cat')), order);
  await fits('P2 editor');
  await P.click('#add-cat'); await P.sleep(200);
  check(`P3 ${tag}: "＋ Add category" opens a bottom sheet`, (await P.js('getComputedStyle(document.getElementById("lib")).position')) === 'fixed' && !!(await P.count('#sheet-scrim')) && (await P.attr('#add-cat', 'aria-expanded')) === 'true');
  await fits('P3 library sheet');
  const tier = dark ? 2 : 1; // the light run already filled Easy
  await P.click('#lib-list .lib-card[data-key="' + (dark ? C.cheese : C.asthma) + '"] [data-add]'); await P.waitFor('!!document.querySelector("[data-pick]")');
  await P.click('[data-pick="' + tier + '"]'); await P.waitFor('!!document.querySelector("' + slot(tier) + '.filled")');
  await P.sleep(300);
  check(`P3 ${tag}: placing closes the sheet`, !(await P.count('#sheet-scrim')) && (await P.js('getComputedStyle(document.getElementById("lib")).display')) === 'none');
  await P.click(slot(3) + ' .adapt-badge'); await P.waitFor('!!document.getElementById("diff-3")');
  await fits('P4 adapted panel');
  await P.click(slot(3) + ' [data-adapt]'); await P.waitFor('!!document.querySelector(".adapt-ed")');
  await fits('P5 per-clue editor');
  await P.click('[data-adcancel="3"]'); await P.sleep(150);
  await P.click(slot(3) + ' .mnu-btn'); await P.sleep(100);
  const pop = await P.js('(() => { const r = document.querySelector(".mnu-pop:not([hidden])").getBoundingClientRect(); return [r.left, r.right]; })()');
  check(`P6 ${tag}: slot ⋯ menu stays on screen`, pop[0] >= 0 && pop[1] <= 375, pop);
  await P.key('Escape', 'Escape', 27);
  check(`P7 ${tag}: approval panel visible`, await P.visible('#appr'));
  for (const [hash, ready, name] of [['#/calendar', '.cal-week', 'P8 calendar'], ['#/activity', '#feed li:not(.day)', 'P9 activity'], ['#/archive', '.arch-card', 'P10 archive']]) {
    await P.js('location.hash = "' + hash + '"'); await P.waitFor('!!document.querySelector("' + ready + '")'); await P.sleep(200);
    await fits(name);
  }
  check(`P11 ${tag}: tab label is "Categories"`, /^Categories/.test(await P.text('#ws-tabs a[href="#/categories"]')));
  check(`P12 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

// ===== Desktop: Archive and Calendar =====
const P = await page({ width: 1366, height: 900 });
check('D0 lead signs in', await P.signInAs(U.LEAD));
await P.js('location.hash = "#/archive"'); await P.waitFor('!!document.querySelector(".arch-card")');
check('D1 no "Reuse as starting point" anywhere', !/Reuse as starting point/.test(await P.text('#ws-main')) && !(await P.count('[data-reuse]')));
const link = await P.attr('.arch-card[data-pid="holes-haze-and-old-paint-2026-10-08"] .arch-open', 'href');
check('D2 categories link to "Open in Category database"', link === '#/categories/' + C.hemoptysis, link);
await P.click('.arch-card[data-pid="holes-haze-and-old-paint-2026-10-08"] .arch-open');
check('D2 the link opens the category in the database', await P.waitFor('location.hash === "#/categories/' + C.hemoptysis + '" && !!document.querySelector("#sd-' + C.hemoptysis + '")'));
await P.js('location.hash = "#/archive"'); await P.waitFor('!!document.querySelector(".arch-card .arch-cat")');
await P.click('.arch-card[data-pid="holes-haze-and-old-paint-2026-10-08"] .arch-cat-w:has(.arch-open) .arch-cat'); await P.waitFor('!!document.querySelector(".arch-dlg")');
check('D3 category dialog: Open in Category database, no Reuse', /Open in Category database/.test(await P.text('#cat-open')) && !/Reuse/.test(await P.text('.arch-dlg')));
await P.key('Escape', 'Escape', 27);
await P.js('location.hash = "#/calendar"'); await P.waitFor('!!document.querySelector(".cal-week")');
const wk = await P.attr('.cal-state.gap [data-startwk]', 'data-startwk');
await P.click('.cal-state.gap [data-startwk]'); await P.waitFor('!!document.getElementById("nd-form")');
check('D4 "Start a draft for this week" pre-fills title and target', /^Week of /.test(await P.js('document.getElementById("nd-title").value')) && /Target release: Thu /.test(await P.text('#nd-date')));
await P.submit('#nd-form'); await P.waitFor('!!document.querySelector("#slots .slot")');
const nd = ((await sql(`select school, target_release, status from public.drafts where title like 'Week of %'`)).rows || [])[0] || {};
check('D4 draft made for CMSRU with the target date (not scheduled)', nd.school === 'cmsru' && nd.status === 'planning' && !!nd.target_release && wk.startsWith('cmsru|'), [nd, wk]);
await P.js('location.hash = "#/calendar"'); await P.waitFor('!!document.querySelector(".cal-state.prog")');
check('D5 that week is now "Draft in progress" with a link', /Draft in progress/.test(await P.text('.cal-state.prog')) && (await P.count('.cal-state.prog a[href^="#/planner/"]')) === 1);
check('D6 no console errors', P.errors.length === 0, P.errors);
P.close();
process.exit(summary());
