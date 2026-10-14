// node supabase/tests/ui/cards_b2.e2e.mjs  (needs pg_server.mjs running)
// Category cards option B2 (owner-approved mockup, 2026-10-14). Part 1 (this
// file): card structure and button order, zeros hidden, no "Puzzle group" /
// "From published puzzle", image clue thumbnails, the school pill in the
// school's color from the database with readable text, the Comfortable /
// Compact switch (kept per browser, j/k, click to open, Trash too).
// Part 2 (cards_b2_b.mjs): folding filter sections, folding + resizing the
// sidebar, the opened category's rows and comment shortcut, partial search.
// Part 3 (cards_b2_c.mjs): pill color in Settings (lead / owner may, admin /
// faculty may not), 375 px light + dark, the Planner rail's narrow card.
// SHOTS=<dir> saves the review screenshots.
import fs from 'node:fs';
import { page, check, summary, resetDb, sql, U, C, D, BASE } from './lib.mjs';
import { runPart2 } from './cards_b2_b.mjs';
import { runPart3 } from './cards_b2_c.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
await resetDb();
// One clue with an image (storage path), for the thumbnail.
await sql(`update public.submissions set payload = jsonb_set(payload, '{items,1}', '{"label":"Clubbed fingers","zone":"photo","info":{"title":"Clubbed fingers","image":"cmsru/test/clubbed.png"}}') where id = $1`, [C.clubbing]);

const P = await page({ width: 1366, height: 900 });
const card = (id) => '#sug-list .sug-card[data-id="' + id + '"]';
const q = (s) => JSON.stringify(s);
const rect = (sel) => P.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })()`);
const css = (sel, prop) => P.js(`(() => { const e = document.querySelector(${q(sel)}); return e ? getComputedStyle(e)[${q(prop)}] : null; })()`);
const shot = async (name, top) => {
  if (!SHOTS) return;
  if (top !== false) { await P.js('window.scrollTo(0, 0)'); await P.sleep(150); }
  await P.js('document.getElementById("toast").hidden = true'); await P.shot(SHOTS + '/' + name + '.png');
};
check('C0 signs in as CMSRU admin', await P.signInAs(U.ADMIN)); await P.settle();

// ===== C1: card structure (B2) =====
const kids = await P.js(`[...document.querySelector(${q(card(C.clubbing) + ' .sug-top')}).children].map((e) => e.className)`);
check('C1 B2 parts in order: head, clue list, usage, buttons', JSON.stringify(kids) === JSON.stringify(['b2-head', 'b2-body', 'card-use', 'card-acts']), kids);
check('C1 name + "Submitted to" pill on the top line', (await P.text(card(C.clubbing) + ' .b2-head')) === 'Causes of clubbingSubmitted to CMSRU');
check('C1 one-column clue list (4 clues)', (await P.count(card(C.clubbing) + ' .b2-clues li')) === 4 && (await css(card(C.clubbing) + ' .b2-clues', 'flexDirection')) === 'column');
await P.waitFor(`!!document.querySelector(${q(card(C.clubbing) + ' .b2-clues li.img .thumb')}).style.backgroundImage`);
check('C1 image clue: small thumbnail + label', (await P.text(card(C.clubbing) + ' .b2-clues li.img')) === 'Clubbed fingers photo' && /url\(/.test(await css(card(C.clubbing) + ' .thumb', 'backgroundImage')) && (await rect(card(C.clubbing) + ' .thumb'))[2] - (await rect(card(C.clubbing) + ' .thumb'))[0] === 34);
const order = await P.js(`[...document.querySelectorAll(${q(card(C.clubbing) + ' .card-acts > *')})].map((e) => e.matches('.mnu') ? 'more' : e.dataset.addd ? 'add' : e.classList.contains('vote-btn') ? 'vote' : e.className)`);
check('C1 buttons left to right: ⋯, Add to draft…, 👍', JSON.stringify(order) === '["more","add","vote"]', order);
check('C1 👍 shown once per card', (await P.js('[...document.querySelectorAll("#sug-list .sug-card")].every((c) => c.querySelectorAll(".vote-btn").length === 1)')));
const R = await rect(card(C.hemoptysis)), use = await rect(card(C.hemoptysis) + ' .card-use'), acts = await rect(card(C.hemoptysis) + ' .card-acts'), head = await rect(card(C.hemoptysis) + ' .b2-head');
check('C1 usage right-aligned at the top right', R[2] - use[2] <= 16 && Math.abs(use[1] - head[1]) <= 6 && (await css(card(C.hemoptysis) + ' .card-use', 'textAlign')) === 'right', [R, use, head]);
check('C1 buttons pinned bottom right', R[2] - acts[2] <= 16 && R[3] - acts[3] <= 16, [R, acts]);
check('C1 usage wording, zeros hidden', (await P.text(card(C.hemoptysis) + ' .card-use')) === 'In 2 published puzzles' && (await P.text(card(C.lead) + ' .card-use')) === 'In 1 draft' &&
  (await P.text(card(C.asthma) + ' .card-use')) === 'Not used yet' && (await P.text(card(C.clubbing) + ' .card-use')) === 'Not used yet💬 2');
const list = await P.text('#sug-list');
check('C1 no "Puzzle group" credit or "From published puzzle" on cards', !/Puzzle group|From published puzzle/.test(list));
await sql(`update public.submissions set credit_name = 'Puzzle group' where id = $1`, [C.imported]);
await P.click('#btn-refresh'); await P.waitFor('/Up to date/.test(document.getElementById("toast").textContent)');
await P.click('#tg-' + C.imported); await P.waitFor(`!!document.querySelector(${q('#sd-' + C.imported + ' .sd-cmts .comments')})`);
await P.js(`document.querySelectorAll(${q('#sd-' + C.imported + ' details')}).forEach((d) => { d.open = true; })`);
const imp = await P.text(card(C.imported));
check('C1 …nor in the opened category (imported, credit "Puzzle group")', !/Puzzle group|From published puzzle/.test(imp) && /Submitted byNot recorded/.test(imp), imp.slice(0, 300));
await P.click('#tg-' + C.imported); await P.sleep(150);
await P.js('document.activeElement.blur()');
await shot('07-database-b2-cards');

// ===== C2: the pill in the school's color, readable text =====
const pill = (id) => css(card(id) + ' .sch-pill', 'backgroundColor');
check('C2 CMSRU pill crimson from the database', (await pill(C.clubbing)) === 'rgb(158, 27, 50)', await pill(C.clubbing));
check('C2 RVSOM pill its own color', (await pill(C.lead)) === 'rgb(107, 74, 46)' && /Submitted to RVSOM/.test(await P.text(card(C.lead) + ' .sch-pill')), await pill(C.lead));
const ratio = (sel) => P.js(`(() => { const e = document.querySelector(${q(sel)}), cs = getComputedStyle(e);
  const L = (c) => { const v = c.match(/\\d+/g).slice(0, 3).map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const a = L(cs.backgroundColor), b = L(cs.color); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10; })()`);
check('C2 pill text contrast ≥ 4.5', (await ratio(card(C.clubbing) + ' .sch-pill')) >= 4.5 && (await ratio(card(C.lead) + ' .sch-pill')) >= 4.5, [await ratio(card(C.clubbing) + ' .sch-pill'), await ratio(card(C.lead) + ' .sch-pill')]);
await sql(`update public.schools set color = '#f2d24b' where slug = 'rvsom'`);
await P.go(BASE + '/inbox/?mock&c2=1#/categories'); await P.waitFor('document.querySelectorAll("#sug-list .sug-card").length > 0'); await P.settle();
check('C2 a light color gets dark text', (await css(card(C.lead) + ' .sch-pill', 'color')) === 'rgb(22, 20, 31)' && (await ratio(card(C.lead) + ' .sch-pill')) >= 4.5, await css(card(C.lead) + ' .sch-pill', 'color'));
await sql(`update public.schools set color = '#6b4a2e' where slug = 'rvsom'`);

// ===== C4: Comfortable / Compact =====
check('C4 switch next to the sort, Comfortable by default', (await P.count('.searchbar #sug-sort + .dens')) === 1 && (await P.attr('[data-dens="comfortable"]', 'aria-checked')) === 'true');
await P.click('[data-dens="compact"]'); await P.sleep(150);
const hs = await P.js('[...document.querySelectorAll("#sug-list .sug-card")].map((c) => Math.round(c.getBoundingClientRect().height))');
check('C4 compact: one thin line per category', (await P.count('#sug-list .sug-card.cmp')) === 7 && hs.every((h) => h <= 46), hs);
check('C4 compact row: name, small pill, counts, ⋯ and Add', (await P.count(card(C.hemoptysis) + ' .sch-pill.sm')) === 1 && /2 pub/.test(await P.text(card(C.hemoptysis) + ' .cmp-n')) &&
  /👍 1/.test(await P.text(card(C.hemoptysis) + ' .cmp-n')) && /1 draft/.test(await P.text(card(C.lead) + ' .cmp-n')) && (await P.count(card(C.hemoptysis) + ' .mnu-btn')) === 1 && (await P.text(card(C.hemoptysis) + ' [data-addd]')) === 'Add');
await shot('08-database-compact');
await P.go(BASE + '/inbox/?mock&c4=1#/categories'); await P.waitFor('document.querySelectorAll("#sug-list .sug-card").length > 0'); await P.settle();
check('C4 compact kept after a reload', (await P.count('#sug-list .sug-card.cmp')) === 7 && (await P.attr('[data-dens="compact"]', 'aria-checked')) === 'true');
await P.js('document.activeElement.blur()'); await P.key('j', 'KeyJ', 74); await P.key('j', 'KeyJ', 74);
const second = await P.js('document.querySelectorAll("#sug-list .sug-card")[1].dataset.id');
check('C4 j/k still move through compact rows', (await P.js('document.querySelector(".sug-card.kcur") && document.querySelector(".sug-card.kcur").dataset.id')) === second);
const [x, y] = await P.js(`(() => { const r = document.querySelector(${q(card(C.asthma) + ' .cmp-n')}).getBoundingClientRect(); return [Math.round(r.left - 30), Math.round(r.top + r.height / 2)]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await P.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
await P.waitFor(`!!document.querySelector(${q(card(C.asthma) + '.open .sd-row')})`);
check('C4 clicking a compact row opens the full category', (await P.count(card(C.asthma) + '.open .b2-head .sch-pill:not(.sm)')) === 1 && (await P.count('#sug-list .sug-card.cmp')) === 6);
await P.click('#tg-' + C.asthma); await P.sleep(150);
await P.js('location.hash = "#/categories/trash"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Trash"'); await P.settle();
check('C4 Trash: compact too, with Restore', (await P.count('#sug-list .sug-card.cmp')) === 2 && (await P.count('#sug-list .cmp-row [data-restore]')) === 2 && (await P.count('.dens')) === 1);
await P.click('[data-dens="comfortable"]'); await P.sleep(150);
check('C4 Trash comfortable: B2 card, Add reason then Restore', (await P.count('#sug-list .sug-top.b2')) === 2 &&
  (await P.js(`[...document.querySelectorAll(${q(card(C.blue) + ' .card-acts button')})].map((b) => b.textContent).join()`)) === 'Edit reason,Restore');
await P.js('location.hash = "#/categories"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Category database"'); await P.settle();
check('C4 comfortable kept back on the database', (await P.count('#sug-list .sug-top.b2')) === 7);

const ctx = { P, check, sql, U, C, D, BASE, card, q, rect, css, shot, ratio, SHOTS };
await runPart2(ctx);
await runPart3(ctx);
check('Z no console errors (desktop)', P.errors.length === 0, P.errors);
P.close();
process.exit(summary());
