// node supabase/tests/ui/results_order_privacy.e2e.mjs  (needs pg_server.mjs running; it only serves the game's files here)
// Results screen order: the puzzle and its teaching come first (outcome, the four
// groups with credit labels, the "your name here" invitation), then every number
// (your stats, your solve path, class stats + rating), then the buttons. On a
// 375 px phone the "Case closed" stamp no longer covers the date line.
// Privacy: the home page shows one short line; the full "About your data" text
// sits collapsed in both Settings menus, next to the share switch.
// Rating buttons line up under the class rating bars; the bottom buttons are normal size.
// SHOTS=<dir> saves privacy-short.png and privacy-settings.png.
import fs from 'node:fs';
import { page, check, summary, BASE, stubGameStats } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const items = [];
const groups = [
  { tier: 1, name: 'Psammoma bodies', credit: { name: 'John D.', line: 'MS2' } },
  { tier: 2, name: 'Hemoptysis', credit: { anonymous: true } },
  { tier: 3, name: 'Ring-enhancing lesions' },
  { tier: 4, name: 'Mitral valve disease', credit: { name: 'Marcus T.' } },
].map((g, gi) => {
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = 'c' + gi + i;
    ids.push(id);
    items.push({ id, label: g.name.split(' ')[0] + ' clue ' + (i + 1), zone: 'corkboard', info: { title: 'Clue ' + (i + 1), text: 'Text' } });
  }
  return Object.assign({ id: 'g' + gi, explanation: 'Why these four belong together.', itemIds: ids }, g);
});
// September: the longest month name, so the widest date line.
const PUZZLE = { id: 'order-test-2026-09-24', title: 'Order test', date: '2026-09-24', items, groups };

const stubs = [];
const liveCount = () => stubs.reduce((n, c) => n + c.live, 0);
async function safePage(opts) {
  const P = await page(opts);
  stubs.push(await stubGameStats(P));
  return P;
}
async function results(opts) {
  const P = await safePage(opts);
  await P.go(BASE + '/?order-test=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.showResultsForPuzzle)');
  await P.js(`(() => { window.__dp2d.showResultsForPuzzle(${JSON.stringify(PUZZLE)}, { won: true, sub: 'Solved in 5 guesses.', hints: { labels: true },
    solvedGroupIds: new Set(['g0', 'g1', 'g2', 'g3']), attempts: [{ itemIds: ['c00', 'c01', 'c02', 'c03'] }] });
    document.getElementById('results-class').hidden = false; document.getElementById('results-class-everyone').hidden = false; return true; })()`);
  await P.waitFor('!document.getElementById("overlay-results").hidden');
  await P.sleep(900);
  return P;
}
/** Document-order index of each selector inside the results card (-1 if missing). */
const order = (P, sels) => P.js(`(() => { const all = [...document.querySelectorAll('.results-card *')];
  return ${JSON.stringify(sels)}.map((s) => all.indexOf(document.querySelector(s))); })()`);
const inside = (P, sel, box) => P.js(`!!document.querySelector(${JSON.stringify(box)} + ' ' + ${JSON.stringify(sel)})`);
const rect = (P, sel) => P.js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; })()`);
const textRect = (P, sel) => P.js(`(() => { const g = document.createRange(); g.selectNodeContents(document.querySelector(${JSON.stringify(sel)}));
  const b = g.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; })()`);
const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

const SEQ = ['.results-hero', '#results-groups', '.credit-cta', '.results-numbers', '#results-found', '#results-path', '#results-class', '#results-rate', '.results-actions', '#btn-share', '#btn-play-again'];
for (const [w, h, mobile] of [[1100, 900, false], [375, 760, true]]) {
  for (const dark of [false, true]) {
    const tag = (mobile ? 'phone ' : 'desktop ') + (dark ? 'dark' : 'light');
    const P = await results({ width: w, height: h, mobile, dark });
    const idx = await order(P, SEQ);
    check(`O1 ${tag}: puzzle + teaching first, then numbers, then buttons`, idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), Object.fromEntries(SEQ.map((s, i) => [s, idx[i]])));
    check(`O2 ${tag}: hero holds only the outcome (no stats, path or buttons)`, !(await P.count('.results-hero .results-stat, .results-hero #results-path, .results-hero .btn')));
    check(`O3 ${tag}: class stats and rating sit inside "How you did"`, (await inside(P, '#results-class', '.results-numbers')) && (await P.text('#results-numbers-title')) === 'How you did');
    check(`O4 ${tag}: credit labels still on the groups`, (await P.count('#results-groups .credit-label')) === 2 && (await P.count('#results-groups .is-anon')) === 1);
    check(`O5 ${tag}: opens scrolled to the top`, (await P.js(`document.querySelector('.results-card').scrollTop`)) === 0);
    const groupsTop = (await rect(P, '#results-groups')).t, numbersTop = (await rect(P, '.results-numbers')).t;
    check(`O6 ${tag}: groups are drawn above the numbers`, groupsTop < numbersTop, { groupsTop, numbersTop });
    check(`O7 ${tag}: fits the width`, (await P.overflow()) <= 0, await P.overflow());
    if (mobile) {
      const date = await textRect(P, '#results-eyebrow'), stamp = await rect(P, '#results-stamp'), title = await rect(P, '#results-title');
      check(`S1 ${tag}: stamp clear of the date line`, /September 24, 2026/i.test(await P.text('#results-eyebrow')) && !hit(date, stamp), { date, stamp });
      check(`S2 ${tag}: stamp clear of the title`, !hit(title, stamp), { title, stamp });
    }
    check(`O8 ${tag}: no console errors`, P.errors.length === 0, P.errors);
    P.close();
  }
}
// Very narrow phone: the date line wraps to two lines; the stamp still clears it.
{
  const P = await results({ width: 320, height: 700, mobile: true });
  const date = await textRect(P, '#results-eyebrow'), stamp = await rect(P, '#results-stamp'), title = await rect(P, '#results-title');
  check('S3 320 px: stamp clear of the wrapped date line and the title', !hit(date, stamp) && !hit(title, stamp), { date, stamp, title });
  P.close();
}

// Rating: after a vote the class chart shows, and each 1-5 button sits right under its bar;
// the bottom buttons are normal size, in one wrapping row.
const RID = 'order-rate-2026-10-30';
const ROW = { puzzle_id: RID, plays: 25, std_finishes: 24, std_wins: 17, mistakes_hist: [6, 5, 4, 2, 7], hint_any: 9, hint_labels: 6, hint_seeds: 4, hint_category: 2, rating_n: 15, rating_hist: [1, 3, 6, 4, 1] };
for (const [w, h, mobile, dark] of [[1100, 900, false, false], [375, 760, true, true]]) {
  const tag = mobile ? 'phone dark' : 'desktop light';
  const P = await page({ width: w, height: h, mobile, dark });
  const stub = await stubGameStats(P, [ROW]); stubs.push(stub);
  await P.go(BASE + '/?order-rate=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.showResultsForPuzzle)');
  await P.js(`(async () => { const p = Object.assign({}, ${JSON.stringify(PUZZLE)}, { id: '${RID}', date: '2026-10-30' });
    localStorage.setItem('dp2d:counted:${RID}', '1'); localStorage.removeItem('dp2d:rating:${RID}');
    window.__dp2d.showResultsForPuzzle(p, { won: true, sub: 'Solved in 5 guesses.', solvedGroupIds: new Set(['g0', 'g1', 'g2', 'g3']), attempts: [] });
    (await import('/src/stats-class-ui.js')).renderResultsClass(p); return true; })()`);
  await P.waitFor('!document.getElementById("results-rate").hidden', 5000);
  check(`G1 ${tag}: before a vote the class ratings stay hidden (no swaying)`, (await P.js(`document.getElementById('results-rated').hidden`)) && (await P.count('#results-rate .rate-btn')) === 5);
  await P.clickText('#results-rate button', 'Hard');
  await P.waitFor('!document.getElementById("results-rated").hidden && document.querySelectorAll(".rate-dist-col").length === 5', 5000);
  const al = await P.js(`(() => { const bars = [...document.querySelectorAll('.rate-dist-col')].map((x) => x.getBoundingClientRect()), btns = [...document.querySelectorAll('#results-rate .rate-btn')].map((x) => x.getBoundingClientRect()),
    sec = document.getElementById('results-class').getBoundingClientRect(), d = document.querySelector('.rate-dist').getBoundingClientRect();
    return { dx: Math.max(...bars.map((b, i) => Math.abs((b.left + b.right) / 2 - (btns[i].left + btns[i].right) / 2))), dw: Math.max(...bars.map((b, i) => Math.abs(b.width - btns[i].width))),
      below: btns.every((b, i) => b.top >= bars[i].bottom - 1 && b.top - bars[i].bottom < 24), span: d.width / (sec.width - 24), mid: Math.abs((d.left + d.right) / 2 - (sec.left + sec.right) / 2) }; })()`);
  check(`G2 ${tag}: each rating button sits under its bar, same width`, al.dx < 1 && al.dw < 1 && al.below, al);
  check(`G3 ${tag}: chart spans the section, centered`, al.span > 0.9 && al.mid < 2, al);
  check(`G4 ${tag}: your vote is marked`, (await P.attr('#results-rate [data-rate="4"]', 'aria-pressed')) === 'true');
  const btns = await P.js(`[...document.querySelectorAll('.results-actions .btn')].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top) }; })`);
  check(`G5 ${tag}: bottom buttons are normal size`, btns.every((b) => b.h <= 44) && btns.find((b) => b.id === 'btn-share').w <= (mobile ? 200 : 180), btns);
  check(`G5 ${tag}: buttons share rows (not one per line)`, new Set(btns.map((b) => b.t)).size <= (mobile ? 3 : 1), btns);
  check(`G6 ${tag}: fits the width`, (await P.overflow()) <= 0, await P.overflow());
  check(`G7 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

// Privacy: one short line on the home page; the full text collapsed in Settings.
const SHORT = 'We count plays anonymously to show class stats. Details and opt-out in Settings.';
const SMOOTH = 'how many guesses you made and how many were wrong, which clues you grouped together on each guess, and which hints you used and when — shown only as class totals';
{
  const P = await safePage({ width: 1280, height: 900 });
  await P.go(BASE + '/?privacy=' + Date.now());
  await P.waitFor('!!document.getElementById("btn-play-today")'); await P.sleep(1000);
  const line = await P.text('.site-foot .stats-notice');
  check('V1 home shows the one short line', line === SHORT, line);
  check('V1 short line is 20 words or fewer', line.split(/\s+/).length <= 20, line.split(/\s+/).length);
  check('V2 no long privacy text on the home page', !/random ID|network address|private database/i.test(await P.js('document.body.innerText')));
  if (SHOTS) { await P.js(`document.querySelector('.site-foot').scrollIntoView({ block: 'end' })`); await P.sleep(300); await P.shot(SHOTS + '/privacy-short.png'); }
  await P.click('#btn-notice-settings');
  await P.waitFor('!document.getElementById("overlay-menu-settings").hidden');
  check('V3 "Settings" opens the Settings dialog', (await P.text('#menu-settings-title')) === 'Settings');
  check('V3 share switch is right there', await P.visible('#toggle-share-stats-menu'));
  check('V4 "About your data" starts collapsed', (await P.text('#about-data-menu > summary')) === 'About your data' && !(await P.js(`document.getElementById('about-data-menu').open`)));
  check('V4 collapsed text is not shown', !/random ID/.test(await P.js(`document.getElementById('overlay-menu-settings').innerText`)));
  await P.click('#about-data-menu > summary'); await P.sleep(200);
  const full = await P.text('#about-data-menu .privacy-text');
  check('V5 expanded: full text with the smoothed sentence', full.includes(SMOOTH) && /random ID/.test(full) && /Turn this off/.test(full), full.slice(0, 200));
  check('V5 the old split wording is gone', !/were wrong, and which clues/.test(full) && !/<li>which hints you used<\/li>/.test(await P.js(`document.getElementById('about-data-menu').innerHTML`)));
  if (SHOTS) await P.shot(SHOTS + '/privacy-settings.png');
  // The switch still works from here.
  await P.click('#toggle-share-stats-menu'); await P.sleep(100);
  check('V6 switch turns sharing off and saves it', !(await P.js(`document.getElementById('toggle-share-stats-menu').checked`)) && (await P.js(`Object.values(localStorage).some((v) => { try { return JSON.parse(v).shareStats === false; } catch (e) { return false; } })`)));
  await P.click('#toggle-share-stats-menu'); await P.sleep(100);
  await P.click('#btn-close-menu-settings');
  // In-game Settings: same collapsed section under the switch, no "What's sent?" link.
  await P.click('#btn-play-today');
  await P.waitFor('!document.getElementById("screen-play").hidden', 8000); await P.sleep(400);
  await P.click('#btn-close-help'); await P.sleep(200);
  await P.click('#btn-settings'); await P.sleep(200);
  check('V7 in-game Settings: "About your data" under the share switch, collapsed', (await P.visible('#about-data-game > summary')) && !(await P.js(`document.getElementById('about-data-game').open`)));
  check('V7 in-game Settings: no "What\'s sent?" link', !(await P.count('#btn-whats-sent')) && !/What's sent/.test(await P.text('#settings-panel')));
  await P.click('#about-data-game > summary'); await P.sleep(200);
  check('V8 in-game expanded text matches the Settings dialog', (await P.text('#about-data-game .privacy-text')) === full);
  if (SHOTS) await P.shot(SHOTS + '/privacy-settings-game.png');
  check('V8 in-game panel scrolls instead of running off screen', await P.js(`(() => { const p = document.getElementById('settings-panel'); return p.getBoundingClientRect().bottom <= innerHeight + 1; })()`));
  check('V9 no console errors', P.errors.length === 0, P.errors);
  P.close();
}
check('Z1 never touched the live database', liveCount() === 0, liveCount());
process.exit(summary());
