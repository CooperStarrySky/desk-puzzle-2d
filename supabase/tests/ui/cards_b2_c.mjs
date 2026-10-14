// Part 3 of cards_b2.e2e.mjs: the pill color in Settings (the lead and the
// owner change it with a live preview; admins and faculty see it locked),
// the Planner rail's narrow B2 card (pill, clues, usage, 👁 / Add / 👍) with
// the compact switch, and 375 px phones in light and dark.
import { page } from './lib.mjs';

export async function runPart3({ P, check, sql, U, C, D, card, q, SHOTS }) {
  const color = async (slug) => (((await sql('select color from public.schools where slug = $1', [slug])).rows || [])[0] || {}).color;
  const settings = async (X) => { await X.click('#gear-btn'); return X.waitFor('!!document.getElementById("set-ad")'); };

  // ===== C3: admin and faculty can't change the color =====
  await settings(P);
  check('C3 admin: pill color shown but locked', (await P.count('#pc-prev .sch-pill')) === 2 && (await P.js('document.getElementById("pc-in").disabled')) &&
    (await P.js('[...document.querySelectorAll("[data-pc]")].every((b) => b.disabled)')) && /Only this school’s lead or the site owner/.test(await P.text('#set-sch')));
  await P.key('Escape', 'Escape', 27); await P.sleep(100);

  // ===== C9: the Planner rail's narrow B2 card =====
  await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#lib-list .lib-card")');
  await P.sleep(300);
  if ((await P.js('document.getElementById("editor").dataset.db')) === 'closed') { await P.click('#db-strip'); await P.sleep(250); }
  const lc = '#lib-list .lib-card[data-key="' + C.clubbing + '"]';
  check('C9 rail card: name + pill, clue list, usage line', (await P.count(lc + ' .lc-head .sch-pill')) === 1 && (await P.count(lc + ' .b2-clues li')) === 4 &&
    (await P.count(lc + ' .b2-clues li.img .thumb')) === 1 && (await P.text(lc + ' .lc-use')) === 'Not used yet' && /In 2 published puzzles/.test(await P.text('#lib-list .lib-card[data-key="' + C.hemoptysis + '"] .lc-use')));
  const ord = await P.js(`[...document.querySelectorAll(${q(lc + ' .lib-btns > button')})].map((b) => b.dataset.view ? 'view' : b.dataset.lvote ? 'vote' : '?')`);
  check('C9 rail buttons: 👁 View, 👍 (no Add to draft…)', JSON.stringify(ord) === '["view","vote"]' && (await P.count('#lib-list [data-add]')) === 0, ord);
  check('C9 no "Puzzle group" / "From published puzzle" in the rail', !/Puzzle group|From published puzzle/.test(await P.text('#lib-list')));
  const before = await P.text(lc + ' [data-lvote]');
  await P.click(lc + ' [data-lvote]'); await P.waitFor('/👍/.test(document.getElementById("toast").textContent)'); await P.sleep(150);
  const n = ((await sql('select count(*)::int n from votes where submission_id = $1', [C.clubbing])).rows || [])[0].n;
  check('C9 👍 in the rail toggles your vote', (await P.text(lc + ' [data-lvote]')) !== before && n !== 3, [before, await P.text(lc + ' [data-lvote]'), n]);
  await P.click(lc + ' [data-lvote]'); await P.waitFor('/Took back|added/.test(document.getElementById("toast").textContent)'); await P.sleep(150);
  if (SHOTS) {
    await P.js('(() => { const t = document.querySelector("#lib .tip [data-tip-x], #lib .tip button"); if (t) t.click(); document.activeElement.blur(); window.scrollTo(0, document.getElementById("lib").getBoundingClientRect().top + scrollY - 120); document.getElementById("toast").hidden = true; })()');
    await P.sleep(200); await P.shot(SHOTS + '/14-planner-rail-b2.png');
  }
  await P.click('#lib .dens [data-dens="compact"]'); await P.sleep(150);
  check('C9 compact rail row: only name + 👍', (await P.count('#lib-list.compact')) === 1 && (await P.count(lc + '.lc-row')) === 1 && (await P.count(lc + ' .b2-clues, ' + lc + ' .lc-use, ' + lc + ' .sch-pill, ' + lc + ' .lc-view, ' + lc + ' [data-add]')) === 0 &&
    /Clubbing/i.test(await P.text(lc + ' .lc-open')) && (await P.count(lc + ' [data-lvote]')) === 1 && (await P.attr(lc, 'draggable')) === 'true');
  await P.click(lc + ' .lc-open'); await P.waitFor('!!document.getElementById("view-add")', 3000);
  check('C9 clicking a compact row opens View with "Add to draft…"', /Add to draft…|Move…/.test(await P.text('#view-add')));
  await P.click('#view-close'); await P.sleep(150);
  await P.click('#lib .dens [data-dens="comfortable"]'); await P.sleep(100);
  await P.js('location.hash = "#/categories"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Category database"'); await P.settle();

  // ===== C3: the lead changes it, live preview; faculty can't =====
  const L = await page({ width: 1366, height: 900 });
  check('C3 lead signs in', await L.signInAs(U.LEAD)); await L.settle();
  await settings(L);
  check('C3 lead: picker on, current color checked', !(await L.js('document.getElementById("pc-in").disabled')) && (await L.attr('[data-pc="#9e1b32"]', 'aria-checked')) === 'true' && (await L.js('document.getElementById("pc-save").disabled')));
  await L.click('[data-pc="#1f3a68"]'); await L.sleep(60);
  check('C3 preset: live preview + Save turns on', (await L.js('getComputedStyle(document.querySelector("#pc-prev .sch-pill")).backgroundColor')) === 'rgb(31, 58, 104)' && !(await L.js('document.getElementById("pc-save").disabled')) && (await color('cmsru')) === '#9e1b32');
  await L.js('(() => { const i = document.getElementById("pc-in"); i.value = "#f5e6a8"; i.dispatchEvent(new Event("input", { bubbles: true })); })()'); await L.sleep(60);
  check('C3 custom color: preview with dark text', (await L.js('getComputedStyle(document.querySelector("#pc-prev .sch-pill")).color')) === 'rgb(22, 20, 31)' && (await L.count('[data-pc][aria-checked="true"]')) === 0);
  await L.click('[data-pc="#1f3a68"]'); await L.sleep(60);
  if (SHOTS) { await L.js('document.getElementById("toast").hidden = true'); await L.shot(SHOTS + '/13-settings-pill-color.png'); }
  await L.click('#pc-save'); await L.waitFor('/pill color saved/.test(document.getElementById("toast").textContent)');
  check('C3 lead saves: stored and every CMSRU pill updates', (await color('cmsru')) === '#1f3a68' && (await L.js(`getComputedStyle(document.querySelector(${q(card(C.clubbing) + ' .sch-pill')})).backgroundColor`)) === 'rgb(31, 58, 104)');
  await L.key('Escape', 'Escape', 27);
  check('C3 no console errors (lead)', L.errors.length === 0, L.errors); L.close();
  const F = await page({ width: 1366, height: 900 });
  check('C3 faculty signs in', await F.signInAs(U.FAC)); await F.settle();
  await settings(F);
  check('C3 faculty: locked', (await F.js('document.getElementById("pc-in").disabled')) && (await F.js('document.getElementById("pc-save").disabled')));
  const r = await sql('select public.set_school_color($1, $2)', ['cmsru', '#000000'], U.FAC);
  check('C3 faculty: the database refuses too', !!r.error && (await color('cmsru')) === '#1f3a68', r.error);
  check('C3 no console errors (faculty)', F.errors.length === 0, F.errors); F.close();
  const O = await page({ width: 1366, height: 900 });
  check('C3 owner signs in', await O.signInAs(U.OWNER)); await O.settle();
  await settings(O);
  await O.js('(() => { const s = document.getElementById("set-pick"); s.value = "rvsom"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await O.sleep(100);
  await O.click('[data-pc="#0f6e70"]'); await O.click('#pc-save'); await O.waitFor('/pill color saved/.test(document.getElementById("toast").textContent)');
  check('C3 owner changes another school\'s color', (await color('rvsom')) === '#0f6e70');
  check('C3 no console errors (owner)', O.errors.length === 0, O.errors); O.close();
  await sql(`update public.schools set color = '#9e1b32' where slug = 'cmsru'`); await sql(`update public.schools set color = '#6b4a2e' where slug = 'rvsom'`);

  // ===== C8: 375 px, light and dark =====
  for (const dark of [false, true]) {
    const tag = dark ? 'dark' : 'light', M = await page({ width: 375, height: 760, mobile: true, dark });
    check(`C8 ${tag}: signs in on a phone`, await M.signInAs(U.LEAD)); await M.settle();
    check(`C8 ${tag}: B2 cards fit 375 px`, (await M.overflow()) <= 0 && (await M.count('#sug-list .sug-top.b2')) === 7, await M.overflow());
    const cr = await M.js(`(() => { const e = document.querySelector(${q(card(C.clubbing) + ' .sch-pill')}), cs = getComputedStyle(e); return cs.backgroundColor + '|' + cs.color; })()`);
    check(`C8 ${tag}: pill colors`, cr === 'rgb(158, 27, 50)|rgb(255, 255, 255)', cr);
    check(`C8 ${tag}: no fold strip or width bar on a phone, Filters drawer instead`, !(await M.visible('#f-strip')) && !(await M.visible('#f-handle')) && (await M.visible('#f-toggle')));
    await M.click('#f-toggle'); await M.sleep(150);
    check(`C8 ${tag}: drawer with folding sections fits`, (await M.overflow()) <= 0 && (await M.js('getComputedStyle(document.getElementById("filters")).position')) === 'fixed' && (await M.count('#filters .fsec')) >= 8);
    await M.key('Escape', 'Escape', 27); await M.sleep(100);
    await M.click('[data-dens="compact"]'); await M.sleep(150);
    check(`C8 ${tag}: compact fits`, (await M.overflow()) <= 0 && (await M.count('#sug-list .sug-card.cmp')) === 7, await M.overflow());
    await M.click('[data-dens="comfortable"]'); await M.sleep(100);
    await M.click('#tg-' + C.hemoptysis); await M.waitFor(`!!document.querySelector(${q('#sd-' + C.hemoptysis + ' .sd-cmts .composer')})`);
    await M.js(`document.querySelectorAll(${q('#sd-' + C.hemoptysis + ' details')}).forEach((d) => { d.open = true; })`); await M.sleep(100);
    check(`C8 ${tag}: open category with every row open fits`, (await M.overflow()) <= 0, await M.overflow());
    await M.click('#tg-' + C.hemoptysis); await M.sleep(100);
    await settings(M);
    check(`C8 ${tag}: settings with the color picker fits`, (await M.overflow()) <= 0, await M.overflow());
    await M.key('Escape', 'Escape', 27);
    check(`C8 ${tag}: no console errors`, M.errors.length === 0, M.errors);
    M.close();
  }
}
