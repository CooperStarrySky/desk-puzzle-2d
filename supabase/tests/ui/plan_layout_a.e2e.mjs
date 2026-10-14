// node supabase/tests/ui/plan_layout_a.e2e.mjs  (needs pg_server.mjs running)
// Planner layout A (owner-approved mockup option A): Database rail | tiers |
// Live preview rail. Part 1 (this file): fold/unfold, width bars (drag, keys,
// double-click reset), the tiers' minimum width and auto-fold, persistence
// across reload. Part 2 (plan_layout_a_b.mjs): every Database filter, chips,
// Clear all, sorts. Part 3 (plan_layout_a_c.mjs): hover preview, 👁 View,
// header pills, phone sheets at 375 px (light + dark), console errors.
// SHOTS=<dir> saves the review screenshots.
import fs from 'node:fs';
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';
import { runPart2 } from './plan_layout_a_b.mjs';
import { runPart3 } from './plan_layout_a_c.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
await resetDb();
const EMPTY = '20000000-0000-4000-9000-0000000000e1';
await sql(`insert into public.drafts (id, title, status, owner_email, school) values ($1, 'Week 9 (empty)', 'planning', $2, 'cmsru')`, [EMPTY, U.ADMIN]);
// One clue with a real image (storage path), for the preview thumbnails.
await sql(`update public.submissions set payload = jsonb_set(payload, '{items,1}', '{"label":"Clubbed fingers","zone":"photo","info":{"title":"Clubbed fingers","image":"cmsru/test/clubbed.png"}}') where id = $1`, [C.clubbing]);

const P = await page({ width: 1440, height: 900 });
const shot = async (name, keep) => {
  if (!SHOTS) return;
  if (!keep) { await P.js('window.scrollTo(0, 0)'); await P.sleep(150); }
  await P.js('document.getElementById("toast").hidden = true'); await P.shot(SHOTS + '/' + name + '.png');
};
const ed = (k) => P.js('document.getElementById("editor").dataset.' + k);
const width = (sel) => P.js(`Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().width)`);
const openDraft = async (id) => { await P.js('location.hash = "#/planner/' + id + '"'); return P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#lib-list .lib-card")'); };
const names = () => P.js('[...document.querySelectorAll("#lib-list .lib-card .lc-name")].map((x) => x.textContent)');
const settle = () => P.sleep(350);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const mouse = async (type, x, y, extra) => P.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));
const center = (sel) => P.js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);

check('L0 admin signs in', await P.signInAs(U.ADMIN));
check('L1 draft opens', await openDraft(D.cmsru));
check('L1 default (A1): both rails folded', (await ed('db')) === 'closed' && (await ed('pv')) === 'closed' && (await P.visible('#db-strip')) && (await P.visible('#pv-strip')) && !(await P.visible('#lib')));
check('L1 the tiers take the freed width', (await width('.center')) > 1000, await width('.center'));
check('L1 Database strip: vertical label, 🔍 and the count', /Database/.test(await P.text('#db-strip')) && /🔍/.test(await P.text('#db-strip')) && (await P.text('#db-cnt')) === '7' &&
  (await P.js('getComputedStyle(document.querySelector("#db-strip .vl")).writingMode')) === 'vertical-rl');
check('L1 library renamed "Database"', (await P.text('#lib-h')) === 'Database');
await shot('planner-A1-both-rails-folded');
check('L2 an empty draft opens with the Database open', (await openDraft(EMPTY)) && (await ed('db')) === 'open' && (await P.visible('#lib')));
await openDraft(D.cmsru);
check('L2 back on a filled draft: folded again', (await ed('db')) === 'closed');

await P.click('#db-strip'); await settle();
check('L3 strip click opens the Database; focus goes to search', (await ed('db')) === 'open' && (await P.visible('#lib-list')) && (await P.attr('#db-strip', 'aria-expanded')) === 'true' && (await P.focused()) === 'sug-q');
await P.click('#db-fold'); await settle();
check('L3 « folds it back; focus returns to the strip', (await ed('db')) === 'closed' && (await P.focused()) === 'db-strip');
await P.click('#db-strip'); await settle();
const h = await P.js('(() => { const x = document.getElementById("db-handle"); return [x.getAttribute("role"), x.tabIndex, getComputedStyle(x).cursor, x.getAttribute("aria-valuenow")]; })()');
check('L5 width bar: separator, focusable, col-resize cursor', h[0] === 'separator' && h[1] === 0 && h[2] === 'col-resize' && h[3] === '340', h);

// Drag the Database's bar 80 px right.
const w0 = await width('#lib'), [hx, hy] = await center('#db-handle');
await mouse('mouseMoved', hx, hy, { buttons: 0 }); await mouse('mousePressed', hx, hy); await mouse('mouseMoved', hx + 40, hy); await mouse('mouseMoved', hx + 80, hy); await mouse('mouseReleased', hx + 80, hy);
await settle();
check('L6 drag widens the Database by ~80 px', Math.abs((await width('#lib')) - (w0 + 80)) <= 2, [w0, await width('#lib')]);
// Keyboard: focus the bar, arrows (Shift = 64), Home/End.
await P.js('document.getElementById("db-handle").focus()');
const kv = async () => Number(await P.attr('#db-handle', 'aria-valuenow'));
const before = await kv(); await P.key('ArrowLeft', 'ArrowLeft', 37);
check('L7 ArrowLeft narrows by 16', (await kv()) === before - 16, [before, await kv()]);
await P.key('ArrowRight', 'ArrowRight', 39, 8);
check('L7 Shift+ArrowRight widens by 64', (await kv()) === before + 48, await kv());
await P.key('Home', 'Home', 36);
check('L7 Home = narrowest (260)', (await kv()) === 260 && (await width('#lib')) === 260);
await P.key('End', 'End', 35); await settle();
check('L7 End = widest that keeps the tiers ≥ 460 px', (await kv()) === Number(await P.attr('#db-handle', 'aria-valuemax')) && (await width('.center')) >= 459, [await kv(), await width('.center')]);
await P.js('document.getElementById("db-handle").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))'); await settle();
check('L8 double-click resets the Database width', (await kv()) === 340 && /Database width reset/.test(await P.toast()));
await P.click('#pv-strip'); await P.sleep(600);
check('L4 Live preview rail opens too', (await ed('pv')) === 'open' && (await P.visible('#pv-frame')));
check('L4 both open: tiers keep at least 460 px', (await width('.center')) >= 460, await width('.center'));
await P.js('document.getElementById("pv-handle").focus()'); const pv0 = Number(await P.attr('#pv-handle', 'aria-valuenow'));
await P.key('Home', 'Home', 36); await P.key('ArrowLeft', 'ArrowLeft', 37);
check('L7 preview bar: ArrowLeft widens the right rail', Number(await P.attr('#pv-handle', 'aria-valuenow')) === 316, [pv0, await P.attr('#pv-handle', 'aria-valuenow')]);
await P.js('document.getElementById("db-handle").focus()'); await P.key('ArrowRight', 'ArrowRight', 39, 8); await P.js('document.activeElement.blur()');
const saved = [await kv(), Number(await P.attr('#pv-handle', 'aria-valuenow'))];
await P.js('window.scrollTo(0, 0)'); await P.sleep(150);
const [gx, gy] = await center('#db-handle'); await mouse('mouseMoved', gx, gy, { button: 'none', buttons: 0 }); await P.sleep(150);
await shot('planner-resized-rails', true); // pointer on the Database's width bar, so its grip shows
await P.js('location.reload()'); await P.waitFor('!!document.querySelector("#lib-list .lib-card")'); await settle();
check('L9 after reload: both rails still open, widths kept', (await ed('db')) === 'open' && (await ed('pv')) === 'open' && (await kv()) === saved[0] && Number(await P.attr('#pv-handle', 'aria-valuenow')) === saved[1], [saved, await kv()]);
// A narrower window: the rail not touched last folds, then the open one floats over the tiers.
await P.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false }); await P.js('dispatchEvent(new Event("resize"))'); await P.sleep(300);
check('L10 1024 px: one rail auto-folds, tiers keep ≥ 460 px', [await ed('db'), await ed('pv')].filter((x) => x === 'closed').length === 1 && (await width('.center')) >= 459, [await ed('db'), await ed('pv'), await width('.center')]);
await P.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false }); await P.js('dispatchEvent(new Event("resize"))'); await P.sleep(300);
check('L10 700 px: the open rail floats over the tiers (no squeeze, no sideways scroll)', [await ed('db'), await ed('pv')].includes('over') && (await P.overflow()) <= 0, [await ed('db'), await ed('pv'), await P.overflow()]);
await P.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await P.js('dispatchEvent(new Event("resize"))'); await P.sleep(300);
check('L10 back to 1440 px: both open again (your choice was kept)', (await ed('db')) === 'open' && (await ed('pv')) === 'open');
await P.click('#pv-fold'); await settle();

const ctx = { P, check, sql, U, C, D, names, settle, same, shot, mouse, center, openDraft, ed, width, SHOTS };
await runPart2(ctx);
await runPart3(ctx);
check('Z no console errors (desktop)', P.errors.length === 0, P.errors);
P.close();
process.exit(summary());
