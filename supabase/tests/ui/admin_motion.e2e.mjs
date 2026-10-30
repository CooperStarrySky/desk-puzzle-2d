// node supabase/tests/ui/admin_motion.e2e.mjs  (needs pg_server.mjs running)
// Workspace motion (ws-motion.js + ws-motion.css). Part R: with "reduce motion"
// on, nothing animates (no ghosts, no running animations, zero durations).
// Part M: with motion on, animations run (menus, rails, the slot a category is
// placed in, folding rows) and a trashed or restored card's fading copy is
// removed once its fade ends, leaving no trace of the card in the list.
import { page, check, summary, resetDb, U, C, D } from './lib.mjs';

await resetDb();
const card = (id) => '#sug-list .sug-card[data-id="' + id + '"]';
const menu = async (P, id, act) => { await P.click(card(id) + ' .mnu-btn'); await P.sleep(60); return P.click('.mnu-pop:not([hidden]) [data-mact="' + act + '"]'); };
// Counts ghosts coming and going, and every animation the page asks for.
const RECORD = `(() => { window.__m = { added: 0, removed: 0, anims: [] };
  new MutationObserver((ms) => ms.forEach((m) => { m.addedNodes.forEach((n) => { if (n.classList && n.classList.contains('m-ghost')) window.__m.added++; });
    m.removedNodes.forEach((n) => { if (n.classList && n.classList.contains('m-ghost')) window.__m.removed++; }); })).observe(document.body, { childList: true, subtree: true });
  const orig = Element.prototype.animate;
  Element.prototype.animate = function (f, o) { window.__m.anims.push({ el: (this.id || this.className || this.tagName) + '', props: Object.keys((f && f[0]) || {}).join(',') }); return orig.call(this, f, o); };
  return true; })()`;
const running = (P) => P.js(`document.getAnimations().filter((a) => a.playState === "running" && (a.id === "m" || /^m-/.test(a.animationName || ""))).length`);
const anims = (P) => P.js('window.__m.anims.slice()');
const resetRec = (P) => P.js('window.__m.added = window.__m.removed = 0; window.__m.anims = []; true');

// ===== Part R: reduce motion (the default for every suite) =====
{
  const P = await page();
  check('R0 signs in', await P.signInAs(U.ADMIN)); await P.settle();
  await P.js(RECORD);
  check('R1 reduce motion is on and the motion tokens are zero', (await P.js('matchMedia("(prefers-reduced-motion: reduce)").matches')) &&
    (await P.js('getComputedStyle(document.documentElement).getPropertyValue("--m-base").trim()')) === '0ms');
  await P.click(card(C.cheese) + ' .mnu-btn'); await P.sleep(30);
  check('R2 the ⋯ menu opens with no animation', (await P.js('getComputedStyle(document.querySelector(".mnu-pop:not([hidden])")).animationDuration')) === '0s' && (await running(P)) === 0);
  await P.key('Escape'); await P.sleep(150);
  await menu(P, C.cheese, 'trash'); await P.waitFor('/to Trash/.test(document.getElementById("toast").textContent)');
  await P.sleep(30);
  check('R3 trashing is instant: card gone, no ghost, no animation requested', (await P.count(card(C.cheese))) === 0 &&
    (await P.js('window.__m.added')) === 0 && (await P.count('.m-ghost')) === 0 && (await anims(P)).length === 0, await anims(P));
  await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#ck-panel .ck-head")');
  await resetRec(P);
  if (await P.visible('#db-strip')) { await P.click('#db-strip'); } else { await P.click('#db-fold'); }
  await P.sleep(30);
  check('R4 folding a Planner rail is instant', (await anims(P)).length === 0 && (await running(P)) === 0, await anims(P));
  check('R5 no page errors', P.errors.length === 0, P.errors);
  P.close();
}

// ===== Part M: motion on =====
await resetDb();
{
  const P = await page({ motion: true });
  check('M0 signs in', await P.signInAs(U.ADMIN)); await P.settle();
  await P.js(RECORD);
  check('M1 motion tokens are set (200 ms base)', (await P.js('matchMedia("(prefers-reduced-motion: reduce)").matches')) === false &&
    (await P.js('getComputedStyle(document.documentElement).getPropertyValue("--m-base").trim()')) === '200ms');
  await P.click(card(C.cheese) + ' .mnu-btn'); await P.sleep(20);
  check('M2 the ⋯ menu pops in quickly (150 ms)', /m-pop/.test(await P.js('getComputedStyle(document.querySelector(".mnu-pop:not([hidden])")).animationName')) &&
    (await P.js('getComputedStyle(document.querySelector(".mnu-pop:not([hidden])")).animationDuration')) === '0.15s');
  await P.key('Escape'); await P.sleep(150);
  await resetRec(P);
  await menu(P, C.cheese, 'trash'); await P.waitFor('/to Trash/.test(document.getElementById("toast").textContent)');
  check('M3 trashed card leaves the list at once (state is not delayed)', (await P.count(card(C.cheese))) === 0);
  await P.sleep(700);
  const g = await P.js('({ added: window.__m.added, removed: window.__m.removed, left: document.querySelectorAll(".m-ghost").length })');
  check('M4 its fading copy appeared and was removed after the fade', g.added >= 1 && g.removed === g.added && g.left === 0, g);
  check('M5 the fading copy is inert: no ids, no data-id anywhere', (await P.count('[data-id="' + C.cheese + '"]')) === 0 && (await P.count('#tg-' + C.cheese)) === 0);
  check('M6 cards below glided up (transform animations asked for)', (await anims(P)).some((a) => /sug-card/.test(a.el) && /transform/.test(a.props)), await anims(P));
  // Restore from Trash: same exit fade, then gone.
  await P.js('location.hash = "#/categories/trash"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Trash"'); await P.settle();
  await P.sleep(300); await resetRec(P);
  await P.click(card(C.cheese) + ' [data-restore]');
  await P.waitFor('!document.querySelector(\'#sug-list .sug-card[data-id="' + C.cheese + '"]\')', 5000);
  await P.sleep(700);
  const g2 = await P.js('({ added: window.__m.added, removed: window.__m.removed, left: document.querySelectorAll(".m-ghost").length })');
  check('M7 restoring fades the card out of Trash and the copy is removed', g2.added >= 1 && g2.removed === g2.added && g2.left === 0, g2);
  // Folding rows (Comments, History, …) animate their height.
  await P.js('location.hash = "#/categories/' + C.clubbing + '"'); await P.waitFor('!!document.querySelector("#sd-' + C.clubbing + ' details.sd-row")', 8000);
  const dc = await P.js('(() => { const d = document.querySelector("#sd-' + C.clubbing + ' details.sd-row"); const s = getComputedStyle(d, "::details-content"); return s.transitionProperty + " " + s.transitionDuration; })()');
  check('M8 folding rows animate their height (::details-content)', /block-size/.test(dc) && /0\.2s/.test(dc), dc);
  // Planner: rail unfold glides, a placed category flies into its slot.
  await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#ck-panel .ck-head")');
  await P.sleep(300);
  if (!(await P.visible('#db-strip'))) { await P.click('#db-fold'); await P.sleep(400); }
  await resetRec(P);
  await P.click('#db-strip'); await P.sleep(40);
  const ra = await anims(P);
  check('M9 opening the Database rail glides its width', ra.some((a) => /rail-(l|db)/.test(a.el) && /width/.test(a.props)), ra);
  await P.sleep(400);
  check('M10 the rail settles at its full width', (await running(P)) === 0 && (await P.attr('#editor', 'data-db')) !== 'closed');
  await resetRec(P);
  const empty = await P.js('[1,2,3,4].find((t) => !!document.querySelector("#slots .slot[data-t=\'" + t + "\'] .slot-empty"))');
  await P.click('#lib-list .lib-card[data-key="' + C.asthma + '"] [data-view]'); await P.waitFor('!!document.getElementById("view-add")');
  await P.click('#view-add'); await P.waitFor('!!document.querySelector("[data-pick]")');
  await P.click('[data-pick="' + empty + '"]');
  await P.waitFor('!!document.querySelector("#slots .slot[data-t=\'' + empty + '\'] .slot-body[data-k=\'' + C.asthma + '\']")', 8000);
  await P.sleep(50);
  const sa = await anims(P);
  check('M11 the placed category glides into its slot', sa.some((a) => /slot-body/.test(a.el) && /transform/.test(a.props)), sa);
  await P.sleep(500);
  check('M12 everything settles, no leftovers', (await running(P)) === 0 && (await P.count('.m-ghost, .m-lift')) === 0);
  check('M13 no page errors', P.errors.length === 0, P.errors);
  P.close();
}
process.exit(summary() ? 1 : 0);
