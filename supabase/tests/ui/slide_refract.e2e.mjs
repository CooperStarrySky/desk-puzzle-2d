// node supabase/tests/ui/slide_refract.e2e.mjs  (needs pg_server.mjs running; it only serves the game's files here)
// The play desk's held slide: as it swings with sideways drag speed, the bench
// seen through its glass shifts sideways by the thin-plate Snell amount for the
// swing angle (refractShift), and the shift fades away once the slide hangs
// level again. Reduced motion: no swing and no shifted copy at all.
// SHOTS=<dir> saves screenshots while dragging.
import fs from 'node:fs';
import { page, check, summary, BASE, stubGameStats } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const reg = await (await fetch(BASE + '/puzzles/index.json')).json();
const cur = reg.puzzles.find((p) => p.id === reg.current);

const stubs = [];
const liveCount = () => stubs.reduce((n, c) => n + c.live, 0);
async function desk(opts) {
  const P = await page(opts);
  stubs.push(await stubGameStats(P));
  await P.go(BASE + '/?slide-refract=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.openPuzzle)');
  await P.js(`fetch('/puzzles/${cur.file}').then((r) => r.json()).then((p) => { window.__dp2d.openPuzzle(p); return true; })`);
  await P.waitFor('document.querySelectorAll(".piece-slide.textured").length > 0', 10000);
  await P.sleep(800);
  await P.click('#btn-close-help'); // first-play "How to play" card
  await P.waitFor('document.getElementById("overlay-help").hidden', 4000).catch(() => {});
  await P.sleep(400);
  return P;
}
const mouse = (P, type, x, y) => P.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
/** Center of the first slide on the desk (scrolled into view). */
const slideAt = (P) => P.js(`(() => { const s = document.querySelector('.piece-slide.textured'); s.scrollIntoView({ block: 'center' });
  const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: s.dataset.id || '' }; })()`);
/** The held slide's swing, shift and the bench copy's state. */
const held = (P) => P.js(`(async () => { const s = document.querySelector('.piece-slide.is-dragging'); if (!s) return null;
  const f = s.querySelector('.slide-refract'), cs = getComputedStyle(f), st = s.style, g = s.querySelector('.slide-glass');
  const off = document.querySelector('#slide-refract-f feOffset');
  const { refractShift } = await import('/src/ui-play.js');
  const rot = parseFloat(st.getPropertyValue('--rot')) || 0;
  return { rot, shift: parseFloat(st.getPropertyValue('--rf-shift')) || 0, a: parseFloat(st.getPropertyValue('--rf-a')) || 0,
    want: refractShift(rot), display: cs.display, opacity: Number(cs.opacity), strip: getComputedStyle(f.parentNode).display,
    svg: document.documentElement.classList.contains('rf-svg'), dx: off ? parseFloat(off.getAttribute('dx')) : null,
    backdrop: getComputedStyle(g).backdropFilter }; })()`);

/* A: motion on: a fast sideways drag tilts the slide and shifts the bench behind it. */
for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await desk({ width: 1366, height: 900, motion: true, dark });
  const s = await slideAt(P);
  await mouse(P, 'mousePressed', s.x, s.y);
  await P.sleep(400); // let the lift settle
  check(`A1 ${tag}: level held slide shows no shifted copy`, await P.js(`(() => { const s = document.querySelector('.piece-slide.is-dragging'); return !!s && Math.abs(parseFloat(s.style.getPropertyValue('--rf-shift')) || 0) < 0.01; })()`));
  let peak = null;
  for (let k = 1; k <= 10; k++) {
    await mouse(P, 'mouseMoved', s.x + k * 22, s.y + k * 2);
    await P.sleep(16);
    const h = await held(P);
    if (h && (!peak || Math.abs(h.shift) > Math.abs(peak.shift))) peak = h;
  }
  if (SHOTS) await P.shot(SHOTS + '/slide-refract-swing-' + tag + '.png');
  check(`A2 ${tag}: the slide swings while dragged sideways`, peak && Math.abs(peak.rot) > 3, peak);
  check(`A3 ${tag}: shift follows Snell for the swing angle`, peak && Math.abs(peak.shift - peak.want) < 0.05 && Math.abs(peak.shift) > 1.5, peak);
  check(`A3 ${tag}: shift direction follows the swing direction`, peak && Math.sign(peak.shift) === Math.sign(peak.rot) && peak.rot > 0, peak);
  check(`A4 ${tag}: Chromium: the glass's backdrop filter shifts by the same amount`, peak && peak.svg && /url\(.*slide-refract-f/.test(peak.backdrop) && Math.abs(peak.dx - peak.shift) < 0.01, peak);
  check(`A4 ${tag}: Chromium: no bench copy drawn`, peak && peak.display === 'none' && peak.strip === 'none', peak);
  // Swing the other way: the shift flips.
  let back = null;
  for (let k = 1; k <= 10; k++) {
    await mouse(P, 'mouseMoved', s.x + 220 - k * 24, s.y + 20);
    await P.sleep(16);
    const h = await held(P);
    if (h && (!back || h.shift < back.shift)) back = h;
  }
  check(`A5 ${tag}: swinging back flips the shift`, back && back.shift < -1.5 && Math.abs(back.shift - back.want) < 0.05, back);
  // Hold still: the slide settles level and the shift goes away.
  await P.sleep(1200);
  const rest = await held(P);
  check(`A6 ${tag}: settles level with no shift`, rest && Math.abs(rest.rot) < 0.1 && Math.abs(rest.shift) < 0.1 && Math.abs(rest.dx) < 0.1, rest);
  if (SHOTS) await P.shot(SHOTS + '/slide-refract-rest-' + tag + '.png');
  if (!dark) {
    // Other browsers (no SVG backdrop filters): the bench copy shows, cut to the edge strip.
    await P.js(`document.documentElement.classList.remove('rf-svg')`);
    let fb = null;
    for (let k = 1; k <= 8; k++) {
      await mouse(P, 'mouseMoved', s.x + k * 24, s.y + 20);
      await P.sleep(16);
      const h = await held(P);
      if (h && (!fb || Math.abs(h.shift) > Math.abs(fb.shift))) fb = h;
    }
    if (SHOTS) await P.shot(SHOTS + '/slide-refract-fallback.png');
    check('A9 fallback: bench copy shown in the edge strip while tilted', fb && fb.display === 'block' && fb.strip === 'block' && fb.opacity > 0.4 && Math.abs(fb.shift) > 1.5, fb);
    check('A9 fallback: glass keeps its plain blur', fb && !/url/.test(fb.backdrop), fb);
    await P.sleep(1200);
    const fr = await held(P);
    check('A9 fallback: copy fades out once level', fr && fr.opacity < 0.1, fr);
  }
  await mouse(P, 'mouseReleased', s.x - 20, s.y + 20);
  await P.sleep(500);
  check(`A7 ${tag}: dropped slide hides the copy`, await P.js(`[...document.querySelectorAll('.slide-refract')].every((f) => getComputedStyle(f).display === 'none')`));
  check(`A8 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

/* B: reduced motion: no swing, no shifted copy. */
{
  const P = await desk({ width: 1366, height: 900 });
  const s = await slideAt(P);
  await mouse(P, 'mousePressed', s.x, s.y);
  await P.sleep(100);
  let worst = null;
  for (let k = 1; k <= 8; k++) {
    await mouse(P, 'mouseMoved', s.x + k * 25, s.y);
    await P.sleep(16);
    const h = await held(P);
    if (h && (!worst || Math.abs(h.shift) > Math.abs(worst.shift) || h.display !== 'none')) worst = h;
  }
  check('B1 reduced motion: slide still drags', !!worst, worst);
  check('B2 reduced motion: no swing, no shift', worst && worst.rot === 0 && worst.shift === 0, worst);
  check('B3 reduced motion: bench copy never shown', worst && worst.display === 'none', worst);
  check('B3 reduced motion: glass backdrop has no shift filter', worst && !/url/.test(worst.backdrop), worst);
  await mouse(P, 'mouseReleased', s.x + 200, s.y);
  check('B4 reduced motion: no console errors', P.errors.length === 0, P.errors);
  P.close();
}

check('Z1 never touched the live database', liveCount() === 0, liveCount());
process.exit(summary());
