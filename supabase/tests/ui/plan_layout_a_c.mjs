// Part 3 of plan_layout_a.e2e.mjs: see inside a category without adding it
// (hover preview + 👁 View), the Faculty approval and Checks pills (small
// popovers, never full width), and the phone layout at 375 px (light + dark):
// slots first, bottom bar Database / Preview / Checks opening sheets, filters
// and View inside the sheet, no sideways scroll, no console errors.
import { page } from './lib.mjs';

export async function runPart3({ P, check, sql, U, C, D, settle, shot, mouse, center, SHOTS }) {
  const slotsN = async () => Number(((await sql('select count(*)::int as n from public.draft_slots where draft_id = $1', [D.cmsru])).rows || [{}])[0].n);
  const card = '#lib-list .lib-card[data-key="' + C.clubbing + '"]';
  const n0 = await slotsN();
  await P.js(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`); await P.sleep(150);
  const [cx, cy] = await center(card);
  await mouse('mouseMoved', cx, cy, { button: 'none', buttons: 0 });
  check('H1 hover shows a preview after a short delay', await P.waitFor('!document.getElementById("lib-peek").hidden', 3000));
  const pk = await P.text('#lib-peek');
  check('H1 preview: name, suggested tier, explanation, usage line, 👍', /Causes of clubbing/.test(pk) && /Suggested Easy/.test(pk) && /Causes of clubbing explained\./.test(pk) && /Never used/.test(pk) && /👍 3/.test(pk), pk);
  check('H1 preview: all 4 clues, image clue with a thumbnail', (await P.count('#lib-peek .pk-clues li')) === 4 && (await P.waitFor('!!document.querySelector("#lib-peek img.pk-th[src]")', 3000)));
  check('H1 the card points at the preview (aria-describedby)', (await P.attr(card, 'aria-describedby')) === 'lib-peek');
  await shot('planner-hover-preview', true);
  await mouse('mouseMoved', 760, 860, { button: 'none', buttons: 0 });
  check('H2 moving away hides it', await P.waitFor('document.getElementById("lib-peek").hidden', 2000));
  check('H2 hovering did not change the draft', (await slotsN()) === n0);

  await P.click('[data-view="' + C.clubbing + '"]'); await P.waitFor('!!document.querySelector(".view-dlg")');
  check('V1 👁 View opens the same content in a dialog', /Causes of clubbing/.test(await P.text('.view-dlg h2')) && (await P.count('.view-dlg .pk-clues li')) === 4 &&
    /Suggested Easy/.test(await P.text('.view-dlg')) && /👍 3/.test(await P.text('.view-dlg .pk-use')));
  check('V1 dialog has "Add to draft…" and Close', (await P.text('#view-add')) === 'Add to draft…' && (await P.text('#view-close')) === 'Close');
  await P.sleep(200); await shot('planner-view-panel');
  await P.click('#view-close'); await P.sleep(200);
  check('V2 Close: dialog gone, draft unchanged', !(await P.count('.view-dlg')) && (await slotsN()) === n0);
  await P.click('[data-view="' + C.clubbing + '"]'); await P.waitFor('!!document.querySelector("#view-add")');
  await P.click('#view-add'); await P.waitFor('!!document.querySelector("[data-pick]")');
  await P.click('[data-pick="1"]'); await P.waitFor('!!document.querySelector("#slots .slot[data-t=\'1\'].filled")');
  check('V3 "Add to draft…" from View → choose a tier → placed', (await slotsN()) === n0 + 1);

  check('A1 approval pill: "Faculty approval"', /^Faculty approval/.test(await P.text('#appr-pill')));
  await P.click('#appr-pill'); await P.sleep(150);
  const aw = await P.js('Math.round(document.getElementById("appr").getBoundingClientRect().width)');
  check('A1 opens a small popover, not full width', (await P.visible('#appr')) && (await P.attr('#appr-pill', 'aria-expanded')) === 'true' && aw <= 400, aw);
  await P.key('Escape', 'Escape', 27);
  check('A1 Escape closes it and returns focus to the pill', (await P.js('document.getElementById("appr").hidden')) && (await P.focused()) === 'appr-pill');
  await sql(`update public.drafts set faculty_approved_by = $2, faculty_approved_at = now() where id = $1`, [D.cmsru, U.FAC]);
  await P.click('#ed-refresh'); await P.waitFor('/approved/i.test(document.getElementById("appr-pill").textContent)');
  check('A2 approved: "✓ Faculty approved · Dr. Lee ▾"', /^✓ Faculty approved · Dr\. Lee/.test(await P.text('#appr-pill')), await P.text('#appr-pill'));
  check('A2 not "edited" yet', !/edited/.test(await P.text('#appr-pill')));
  await P.sleep(800); // the app ignores changes within 0.5 s of the approval
  await P.click('#lib-list [data-view="' + C.hemoptysis + '"]'); await P.waitFor('!!document.getElementById("view-add")'); await P.click('#view-add'); await P.waitFor('!!document.querySelector("[data-pick]")'); await P.click('[data-pick="2"]');
  await P.waitFor('/edited/.test(document.getElementById("appr-pill").textContent)');
  await P.click('#appr-pill'); await P.sleep(150);
  check('A3 edited since approval: pill says so, popover has the note', /edited/.test(await P.text('#appr-pill')) && /Edited since approval/.test(await P.text('#appr-edited')) && (await P.count('#appr .seal')) === 1,
    [await P.text('#appr-pill'), await P.text('#appr')]);
  check('A4 Checks pill counts what needs a look', /^Checks · \d+ (blocking|to look at)/.test(await P.text('#ck-pill')), await P.text('#ck-pill'));
  await P.click('#ck-pill'); await P.sleep(150);
  const cw = await P.js('Math.round(document.getElementById("ck-panel").getBoundingClientRect().width)');
  check('A4 Checks popover opens small; approval popover closes', (await P.visible('#ck-panel')) && cw <= 400 && (await P.js('document.getElementById("appr").hidden')) && (await P.count('#ck-panel .checks li')) > 0, cw);
  await P.click('#ed-h'); await P.sleep(100);
  check('A5 clicking elsewhere closes it', await P.js('document.getElementById("ck-panel").hidden'));
  check('A6 nothing in the header spans the full width', (await P.js('Math.max(...[...document.querySelectorAll("#ed-pills > *")].map((e) => e.getBoundingClientRect().width))')) < 400);

  for (const dark of [false, true]) {
    const tag = dark ? 'dark' : 'light';
    const M = await page({ width: 375, height: 760, mobile: true, dark });
    const shown = (sel) => M.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && !e.hidden && r.width > 0 && r.height > 0; })()`);
    const fits = async (what) => { const o = await M.overflow(); check(`M ${tag}: ${what} fits 375 px`, o <= 0, o); };
    check(`M0 ${tag}: signs in on a phone`, await M.signInAs(U.ADMIN));
    await M.js('location.hash = "#/planner/' + D.cmsru + '"'); await M.waitFor('!!document.querySelector("#slots .slot.filled") && !!document.querySelector("#lib-list .lib-card")');
    check(`M1 ${tag}: slots first, rails hidden, bottom bar with 3 buttons`, !(await M.visible('#lib')) && !(await M.visible('#db-strip')) && (await M.count('#pbar .btn')) === 3 && (await M.visible('#pb-ck')));
    await fits('editor');
    if (!dark && SHOTS) await M.shot(SHOTS + '/planner-phone-bottom-bar.png');
    await M.click('#pb-pv'); await M.sleep(250);
    check(`M2 ${tag}: Preview opens as a sheet`, (await M.js('getComputedStyle(document.getElementById("pv-col")).position')) === 'fixed' && (await shown('#pv-col')) && (await M.attr('#pb-pv', 'aria-expanded')) === 'true');
    await fits('preview sheet');
    await M.click('#pv-col [data-sheet-x]'); await M.sleep(150);
    check(`M2 ${tag}: Done closes it`, !(await shown('#pv-col')) && !(await M.count('#sheet-scrim')));
    await M.click('#pb-ck'); await M.sleep(200);
    check(`M3 ${tag}: Checks opens as a sheet`, (await shown('#ck-panel')) && (await M.js('getComputedStyle(document.getElementById("ck-panel")).position')) === 'fixed');
    await M.key('Escape', 'Escape', 27); await M.sleep(150);
    check(`M3 ${tag}: Escape closes it`, !(await shown('#ck-panel')));
    await M.click('#pb-db'); await M.sleep(200);
    await M.click('#f-toggle'); await M.sleep(150); await M.click('[data-f="block"][data-v="Pulm"]'); await M.sleep(400);
    check(`M4 ${tag}: filters work inside the Database sheet`, (await M.count('#lib-list .lib-card')) === 3 && (await M.count('#active-f .af-chip')) === 1);
    await fits('Database sheet with filters');
    if (!dark && SHOTS) await M.shot(SHOTS + '/planner-phone-database-sheet.png');
    await M.click('#af-clear'); await M.sleep(300); await M.click('#f-toggle'); await M.sleep(100);
    await M.click('[data-view="' + C.asthma + '"]'); await M.waitFor('!!document.querySelector(".view-dlg")');
    check(`M5 ${tag}: 👁 View works on a phone`, /Asthma triggers/.test(await M.text('.view-dlg h2')));
    await fits('View dialog');
    await M.click('#view-close'); await M.sleep(150); await M.click('#lib-close'); await M.sleep(150);
    await M.click('#appr-pill'); await M.sleep(150);
    const r = await M.js('(() => { const b = document.getElementById("appr").getBoundingClientRect(); return [b.left, b.right]; })()');
    check(`M6 ${tag}: approval popover stays on screen`, r[0] >= 0 && r[1] <= 375, r);
    await fits('approval popover');
    check(`M7 ${tag}: no console errors`, M.errors.length === 0, M.errors);
    M.close();
  }
}
