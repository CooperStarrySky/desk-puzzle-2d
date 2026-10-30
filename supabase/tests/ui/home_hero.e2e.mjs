// node supabase/tests/ui/home_hero.e2e.mjs  (needs pg_server.mjs running; it only serves the game's files here)
// Home page top (H4): the h1 is this week's puzzle name, the meta line gives its
// number, date and piece count, the live line shows real class totals only once
// they pass CLASS_MIN, Play is the only hero button, the featured desk is drawn
// live with a mouse-only lift, and the "Submitted by YOU" slide below the archive
// links to the Studio. Reduced motion = final state at once. SHOTS=<dir> saves screenshots.
import fs from 'node:fs';
import { page, check, summary, BASE, stubGameStats } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const reg = await (await fetch(BASE + '/puzzles/index.json')).json();
const cur = reg.puzzles.find((p) => p.id === reg.current);
const number = reg.puzzles.slice().sort((a, b) => a.date.localeCompare(b.date)).findIndex((p) => p.id === cur.id) + 1;
const row = (n, wins, plays) => ({ puzzle_id: cur.id, plays, std_finishes: n, std_wins: wins, mistakes_hist: [wins, 0, 0, 0, n - wins], rating_hist: [0, 0, 0, 0], hint_any: 0, hint_labels: 0, hint_seeds: 0, hint_category: 0 });

const stubs = [];
const liveCount = () => stubs.reduce((n, c) => n + c.live, 0);
async function home(opts, rows) {
  const P = await page(opts);
  stubs.push(await stubGameStats(P, rows));
  await P.go(BASE + '/?home-hero=' + Date.now());
  await P.waitFor('!!document.getElementById("btn-play-today") && document.getElementById("menu-headline").getAttribute("data-title") === ' + JSON.stringify(cur.title));
  return P;
}
const mouse = (P, x, y) => P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

/* A: reduced motion, too few finishes for class stats. */
{
  const P = await home({ width: 1280, height: 900 }, [row(6, 4, 7)]);
  await P.sleep(1200);
  check('A1 h1 is the featured puzzle name', (await P.text('#menu-headline')) === cur.title, await P.text('#menu-headline'));
  check('A1 featured card names the same puzzle', ((await P.attr('#btn-play-featured', 'aria-label')) || '').endsWith(cur.title));
  const meta = await P.text('#hero-meta');
  check('A2 meta line: number, date, piece count', meta === `Puzzle ${number} · ${await P.js(`(${JSON.stringify(cur.date)}).replace(/^(\\d+)-(\\d+)-(\\d+)$/, (m, y, mo, d) => new Date(Date.UTC(+y, +mo - 1, +d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }))`)} · 16 clues`, meta);
  check('A3 live line hidden below the class threshold', (await P.attr('#hero-live', 'hidden')) !== null && !(await P.visible('#hero-live')));
  check('A4 Play is the only hero button', (await P.count('.hero-copy button, .hero-copy a')) === 1 && (await P.text('.hero-copy #btn-play-today')) === 'Play');
  check('A4 no tagline, Submit button, or "Free, no sign-in"', !(await P.count('.hero .lede, .hero a[href*="studio"]')) && !/Free, no sign-in/.test(await P.js('document.body.innerText')));
  check('A4 How to play stays in the header only', (await P.count('#btn-menu-help')) === 1 && !/How to play/.test(await P.text('.hero')));
  check('A5 archive count shown', /^\d+ puzzles so far$/.test(await P.text('.menu-all .menu-stats')), await P.text('.menu-all .menu-stats'));
  const inv = '#home-invite a.credit-label';
  check('A6 invitation slide links to the Studio', /(^|\/)studio\/\?submit$/.test(await P.attr(inv, 'href')), await P.attr(inv, 'href'));
  check('A6 invitation aria-label', (await P.attr(inv, 'aria-label')) === 'Suggest a category in the Studio');
  check('A6 reads "Submitted by" + "YOU"', (await P.text(inv + ' .cl-cap')) === 'Submitted by' && (await P.text(inv + ' .cl-sig')) === 'YOU');
  check('A6 invitation line', (await P.text('#home-invite p')) === 'Submit a category for a chance to be featured in a puzzle.');
  check('A6 invitation is keyboard focusable', await P.js(`(() => { const a = document.querySelector('${inv}'); a.focus(); return document.activeElement === a && a.tabIndex === 0; })()`));
  check('A7 reduced motion: final state at once', await P.js(`(() => {
    const r = document.documentElement, words = [...document.querySelectorAll('#menu-headline .w > span')];
    const op = (s) => getComputedStyle(document.querySelector(s)).opacity === '1';
    return !r.classList.contains('home-intro') && op('#hero-meta') && op('#btn-play-today') && op('#btn-play-featured')
      && words.length > 0 && words.every((w) => getComputedStyle(w).transform === 'none')
      && document.querySelector('${inv}').classList.contains('no-entrance'); })()`));
  check('A7 reduced motion: saved thumbnail, no live desk', !(await P.count('#featured-mini.is-live')));
  check('A8 no horizontal scroll', (await P.overflow()) <= 0);
  check('A9 no console errors', P.errors.length === 0, P.errors);
  P.close();
}

/* B: enough finishes -> the live line shows the real totals. */
{
  const P = await home({ width: 1280, height: 900 }, [row(40, 26, 52)]);
  await P.waitFor('!document.getElementById("hero-live").hidden', 8000).catch(() => {});
  const t = await P.text('#hero-live');
  check('B1 live line shown above the threshold', await P.visible('#hero-live'));
  check('B1 live line numbers from puzzle_stats', /^52 players (so far|since Oct 2026)\s*·\s*65% found all four$/.test(t), t);
  check('B2 no console errors', P.errors.length === 0, P.errors);
  P.close();
}

/* C: motion on, desktop mouse: intro settles, the live desk lifts near the pointer. */
for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await home({ width: 1280, height: 900, motion: true, dark }, [row(40, 26, 52)]);
  await P.waitFor('document.getElementById("featured-mini").classList.contains("is-live")', 10000).catch(() => {});
  await P.sleep(2600);
  check(`C1 ${tag}: live desk with 9 pieces`, (await P.count('#featured-mini.is-live .desk-live .t')) === 9);
  const dbg = await P.js(`(() => { const op = (s) => getComputedStyle(document.querySelector(s)).opacity; return { intro: document.documentElement.classList.contains('home-intro'), meta: op('#hero-meta'), play: op('#btn-play-today'), feat: op('#btn-play-featured'), words: [...document.querySelectorAll('#menu-headline .w > span')].map((w) => w.style.transform), tiles: [...document.querySelectorAll('.desk-live .t')].map((t) => t.style.opacity) }; })()`);
  check(`C1 ${tag}: intro finished (all visible, no leftover transforms)`, await P.js(`(() => {
    const op = (s) => getComputedStyle(document.querySelector(s)).opacity === '1';
    return !document.documentElement.classList.contains('home-intro') && op('#hero-meta') && op('#btn-play-today') && op('#btn-play-featured')
      && [...document.querySelectorAll('#menu-headline .w > span')].every((w) => !w.style.transform)
      && [...document.querySelectorAll('.desk-live .t')].every((t) => Number(t.style.opacity) === 1); })()`), dbg);
  const box = await P.js(`(() => { const t = document.querySelector('.desk-live .t'), r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, t0: t.style.transform }; })()`);
  for (let k = 0; k < 5; k++) { await mouse(P, box.x + k, box.y); await P.sleep(50); }
  await P.sleep(900);
  const lifted = await P.js(`document.querySelector('.desk-live .t').style.transform`);
  check(`C2 ${tag}: piece under the mouse lifts and straightens`, /translateY\(-(9|10)(\.\d+)?px\)/.test(lifted) && /scale\(1\.03/.test(lifted), lifted);
  if (SHOTS) await P.shot(SHOTS + '/home-live-' + (dark ? 'dark' : 'desktop') + '.png');
  await mouse(P, 5, 5); await P.sleep(1000);
  check(`C3 ${tag}: piece springs back`, (await P.js(`document.querySelector('.desk-live .t').style.transform`)) === box.t0, await P.js(`document.querySelector('.desk-live .t').style.transform`));
  if (!dark) {
    const lb = await P.js(`(() => { const s = document.querySelector('#home-invite .cl-slide'); s.scrollIntoView({ block: 'center' }); return true; })()`);
    await P.sleep(1400);
    const r = await P.js(`(() => { const r = document.querySelector('#home-invite .cl-slide').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    for (let k = 0; k < 5; k++) { await mouse(P, r.x + r.w * (0.6 + k * 0.08), r.y + r.h * 0.2); await P.sleep(60); }
    await P.sleep(500);
    const st = await P.js(`(() => { const s = document.querySelector('#home-invite .cl-slide'); return { hover: s.classList.contains('is-hover'), px: Number(s.style.getPropertyValue('--px') || 0), inn: s.parentNode.classList.contains('is-in') }; })()`);
    check('C6 invitation flips in, tilts toward the mouse', lb && st.inn && st.hover && st.px > 0.2, st);
    if (SHOTS) await P.shot(SHOTS + '/home-live-invite.png');
    // Clink: the game's synth through its Sound setting (a click first; hover alone can't start audio).
    await mouse(P, 3, 3);
    await P.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 3, y: 300, button: 'left', clickCount: 1 });
    await P.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 3, y: 300, button: 'left', clickCount: 1 });
    await P.js(`(async () => { const a = await import('/src/audio.js'); const c = a.audioCtx(); if (c) await c.resume(); window.__osc = 0; const o = c.createOscillator.bind(c); c.createOscillator = function () { window.__osc++; return o(); }; return true; })()`);
    await P.sleep(300);
    await mouse(P, r.x + r.w * 0.5, r.y + r.h * 0.5); await P.sleep(150);
    check('C7 hovering the invitation plays the glass clink', (await P.js('window.__osc')) === 2, await P.js('window.__osc'));
    await mouse(P, 3, 3); await P.sleep(300);
    await P.js(`(async () => { (await import('/src/state.js')).state.settings.sound = false; window.__osc = 0; return true; })()`);
    await mouse(P, r.x + r.w * 0.5, r.y + r.h * 0.5); await P.sleep(150);
    check('C7 Sound off: hovering the invitation stays silent', (await P.js('window.__osc')) === 0);
    await mouse(P, 3, 3);
  }
  check(`C4 ${tag}: live line counted up to the real numbers`, /^52 players (so far|since Oct 2026)\s*·\s*65% found all four$/.test(await P.text('#hero-live')), await P.text('#hero-live'));
  check(`C5 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

/* D: phone: stacked, no overflow, Play full width above the desk. */
{
  const P = await home({ width: 390, height: 844, mobile: true, motion: true }, [row(40, 26, 52)]);
  await P.sleep(3000);
  check('D1 phone: no horizontal scroll', (await P.overflow()) <= 0, await P.overflow());
  check('D2 phone: hero stacked, desk below Play', await P.js(`(() => { const a = document.getElementById('btn-play-today').getBoundingClientRect(), b = document.getElementById('btn-play-featured').getBoundingClientRect(); return b.top > a.bottom; })()`));
  if (SHOTS) await P.shot(SHOTS + '/home-live-phone.png');
  check('D3 phone: no console errors', P.errors.length === 0, P.errors);
  P.close();
}

check('Z1 never touched the live database', liveCount() === 0, liveCount());
process.exit(summary());
