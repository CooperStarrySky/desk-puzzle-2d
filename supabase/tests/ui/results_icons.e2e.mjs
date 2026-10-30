// node supabase/tests/ui/results_icons.e2e.mjs  (needs pg_server.mjs running; it only serves the game's files here)
// Results screen v2: the bottom buttons are icons with an aria-label and a tooltip
// (hover or keyboard focus on desktop, a small label under each icon on phones);
// the "Open notes" chevron points down when closed and up when open; the hints tile
// reads "Hints used / 1 of 3 / Label Images"; the solve squares are big enough to
// read; the credit label clinks on hover and slides quietly while tilting, and stays
// silent with Sound off.
import { page, check, summary, BASE, stubGameStats } from './lib.mjs';

const items = [];
const groups = [
  { tier: 1, name: 'Psammoma bodies', credit: { name: 'John D.', line: 'MS2' } },
  { tier: 2, name: 'Hemoptysis' }, { tier: 3, name: 'Ring-enhancing lesions' }, { tier: 4, name: 'Mitral valve disease' },
].map((g, gi) => {
  const ids = [];
  for (let i = 0; i < 4; i++) { const id = 'c' + gi + i; ids.push(id); items.push({ id, label: 'Clue ' + gi + i, zone: 'corkboard', info: { title: 'Clue', text: 'Text' } }); }
  return Object.assign({ id: 'g' + gi, explanation: 'Why these four belong together.', itemIds: ids }, g);
});
const PUZZLE = { id: 'icons-test-2026-10-30', title: 'Icons test', date: '2026-10-30', items, groups };
let live = 0;
async function results(opts, hints) {
  const P = await page(opts);
  const c = await stubGameStats(P);
  await P.go(BASE + '/?icons-test=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.showResultsForPuzzle)');
  await P.js(`(() => { window.__dp2d.showResultsForPuzzle(${JSON.stringify(PUZZLE)}, { won: true, hints: ${JSON.stringify(hints || { labels: true })},
    solvedGroupIds: new Set(['g0', 'g1', 'g2', 'g3']), attempts: [{ itemIds: ['c00', 'c01', 'c02', 'c10'] }, { itemIds: ['c00', 'c01', 'c02', 'c03'] }] }); return true; })()`);
  await P.waitFor('!document.getElementById("overlay-results").hidden');
  await P.sleep(700);
  P.live = () => c.live;
  return P;
}
const tipOpacity = (P, sel) => P.js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}), '::after').opacity`);
const center = (P, sel) => P.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const mouse = (P, p) => P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });

// Desktop
{
  const P = await results({ width: 1280, height: 900 });
  const btns = await P.js(`[...document.querySelectorAll('.results-actions button')].map((b) => ({ id: b.id, hidden: b.hidden, aria: b.getAttribute('aria-label'), tip: b.dataset.tip, svg: !!b.querySelector('svg'), w: Math.round(b.getBoundingClientRect().width), t: Math.round(b.getBoundingClientRect().top) }))`);
  check('I1 every bottom button is an icon with an aria-label and a matching tooltip', btns.length === 5 && btns.every((b) => b.aria && b.tip === b.aria && b.svg), btns);
  check('I1 Share / Anki / My stats labels', ['Share result', 'Study these in Anki', 'My stats'].every((l) => btns.some((b) => b.aria === l)), btns.map((b) => b.aria));
  const shown = btns.filter((b) => !b.hidden);
  check('I2 desktop: icons sit in one row, square', shown.length >= 4 && new Set(shown.map((b) => b.t)).size === 1 && shown.every((b) => b.w <= 52), shown);
  check('I2 desktop: no text label under the icons', !(await P.visible('#btn-share .icon-btn-label')));
  check('I3 tooltip hidden at rest', Number(await tipOpacity(P, '#btn-share')) === 0);
  await mouse(P, await center(P, '#btn-share'));
  await P.sleep(350);
  check('I3 tooltip shows on hover', Number(await tipOpacity(P, '#btn-share')) === 1);
  await mouse(P, { x: 3, y: 3 });
  await P.js(`document.getElementById('btn-share').focus()`);
  await P.key('Tab', 'Tab', 9);
  await P.sleep(350);
  const foc = await P.focused();
  check('I4 tooltip shows on keyboard focus', foc === shown[1].id && Number(await tipOpacity(P, '#' + shown[1].id)) === 1, foc);

  // Notes chevron
  const rot = () => P.js(`(() => { const t = getComputedStyle(document.querySelector('.result-placard-more'), '::after').transform; const m = /matrix\\(([^)]+)\\)/.exec(t); return m ? m[1].split(',').map(Number) : t; })()`);
  const closed = await rot();
  check('N1 notes chevron points down while closed', Array.isArray(closed) && closed[0] > 0.6 && closed[1] > 0.6, closed);
  await P.click('.result-placard-head');
  await P.sleep(450);
  const open = await rot();
  check('N2 notes chevron points up when open', Array.isArray(open) && open[0] < -0.6 && open[1] < -0.6, open);
  check('N3 notes label has no sideways arrow', !/[→←]/.test(await P.js(`getComputedStyle(document.querySelector('.result-placard-more'), '::before').content`)));

  // Hints tile + solve squares
  check('H1 hints tile reads "Hints used / 1 of 3 / Label Images"', (await P.text('#results-hints-k')) === 'Hints used' && (await P.text('#results-hints')) === '1 of 3' && (await P.text('#results-hints-sub')) === 'Label Images');
  const sq = await P.js(`document.querySelector('.results-sq').getBoundingClientRect().width`);
  check('P1 solve squares are at least 30 px', sq >= 30, sq);
  const lay = await P.js(`(() => { const a = document.querySelector('.results-stats').getBoundingClientRect(), b = document.getElementById('results-path-block').getBoundingClientRect(); return { side: b.left > a.right - 1, sameTop: Math.abs(a.top - b.top) < 2, sameBottom: Math.abs(a.bottom - b.bottom) < 2 }; })()`);
  check('L1 desktop: tiles beside the solve grid, rows line up', lay.side && lay.sameTop && lay.sameBottom, lay);

  // Sounds: a gesture first (audio can't start from hover alone), then hover the label.
  await P.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 3, y: 3, button: 'left', clickCount: 1 });
  await P.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 3, y: 3, button: 'left', clickCount: 1 });
  await P.js(`(async () => { const a = await import('/src/audio.js'); const c = a.audioCtx(); if (c) await c.resume(); return c && c.state; })()`);
  await P.js(`(async () => { const a = await import('/src/audio.js'); const c = a.audio.ctx; window.__osc = 0; const o = c.createOscillator.bind(c); c.createOscillator = function () { window.__osc++; return o(); }; return true; })()`);
  await P.click('.result-placard-head'); // close the notes again so the label sits still
  await P.sleep(300);
  const lab = await center(P, '.credit-label .cl-slide');
  await mouse(P, { x: lab.x - 30, y: lab.y });
  await P.sleep(80);
  for (let i = 0; i < 8; i++) { await mouse(P, { x: lab.x - 30 + i * 9, y: lab.y + (i % 2 ? 6 : -6) }); await P.sleep(30); }
  const s1 = await P.js(`({ osc: window.__osc, voice: !!document.querySelector('.credit-label .cl-slide')._clVoice })`);
  check('A1 hover plays a clink and starts the slide voice', s1.osc >= 2 && s1.voice, s1);
  await mouse(P, { x: 3, y: 3 });
  await P.sleep(100);
  check('A2 leaving stops the slide voice', !(await P.js(`!!document.querySelector('.credit-label .cl-slide')._clVoice`)));
  await P.js(`(async () => { (await import('/src/state.js')).state.settings.sound = false; window.__osc = 0; return true; })()`);
  await P.sleep(300);
  await mouse(P, lab);
  await P.sleep(150);
  check('A3 Sound off: hovering stays silent', (await P.js(`window.__osc`)) === 0 && !(await P.js(`!!document.querySelector('.credit-label .cl-slide')._clVoice`)));
  await mouse(P, { x: 3, y: 3 });
  check('I9 desktop: no console errors', P.errors.length === 0, P.errors);
  live += P.live();
  P.close();
}
// Phone
{
  const P = await results({ width: 390, height: 844, mobile: true }, {});
  const btns = await P.js(`[...document.querySelectorAll('.results-actions button')].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); const l = b.querySelector('.icon-btn-label'); return { id: b.id, t: Math.round(r.top), h: Math.round(r.height), label: l && l.offsetParent !== null ? l.textContent : '', tip: getComputedStyle(b, '::after').display }; })`);
  check('I5 phone: a short label shows under every icon', btns.every((b) => b.label.length > 0), btns);
  check('I5 phone: tooltips off (label already on screen)', btns.every((b) => b.tip === 'none'), btns);
  check('I6 phone: all buttons in one row, tap-sized', new Set(btns.map((b) => b.t)).size === 1 && btns.every((b) => b.h >= 44 && b.h <= 64), btns);
  check('H2 phone: no hints used reads "0 of 3 / Solved without help"', (await P.text('#results-hints')) === '0 of 3' && (await P.text('#results-hints-sub')) === 'Solved without help');
  const lay = await P.js(`(() => { const f = document.querySelector('.results-stat-found').getBoundingClientRect(), h = document.querySelector('.results-stat-hints').getBoundingClientRect(), p = document.getElementById('results-path-block').getBoundingClientRect(); return { pair: Math.abs(f.top - h.top) < 2, under: p.top > f.bottom, full: Math.abs(p.left - f.left) < 2 && Math.abs(p.right - h.right) < 2 }; })()`);
  check('L2 phone: the two tiles share a row, solve grid full width under them', lay.pair && lay.under && lay.full, lay);
  check('L3 phone: fits the width', (await P.overflow()) <= 0, await P.overflow());
  check('I9 phone: no console errors', P.errors.length === 0, P.errors);
  live += P.live();
  P.close();
}
check('Z no request reached the live database', live === 0, live);
process.exit(summary() ? 1 : 0);
