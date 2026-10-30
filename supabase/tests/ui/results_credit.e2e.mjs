// node supabase/tests/ui/results_credit.e2e.mjs  (needs pg_server.mjs running; it only serves the game's files here)
// The game's results screen: a named group gets the signed "Submitted by" slide
// label (option C1), an anonymous one the quiet line, a house group nothing; the
// "your name here" invitation links to the Studio; the label flips in once when
// seen, tilts toward the pointer and springs back; reduced motion turns all
// motion off. Stats, stamp and share stay. SHOTS=<dir> saves screenshots.
import fs from 'node:fs';
import { page, check, summary, BASE, stubGameStats } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// A made-up puzzle: tier 1 named, tier 2 anonymous, tier 3 house, tier 4 named.
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
    items.push({ id, label: g.name.split(' ')[0] + ' clue ' + (i + 1), zone: i === 2 ? 'rx' : 'corkboard', info: { title: 'Clue ' + (i + 1), text: 'Text' } });
  }
  return Object.assign({ id: 'g' + gi, explanation: 'Why these four belong together.', itemIds: ids }, g);
});
const PUZZLE = { id: 'credit-test-2026-10-29', title: 'Credit test', date: '2026-10-29', items, groups };

const show = (P) => P.js(`(() => {
  const p = ${JSON.stringify(PUZZLE)};
  window.__dp2d.showResultsForPuzzle(p, { won: true, sub: 'Solved in 5 guesses.', solvedGroupIds: new Set(['g0', 'g1', 'g2', 'g3']),
    attempts: [{ itemIds: ['c00', 'c01', 'c02', 'c03'] }] });
  return true;
})()`);
const placard = (i) => '#results-groups .result-placard:nth-child(' + (i + 1) + ')';
/** Centre of the first signed label's slide, scrolled into view. */
const slideBox = (P) => P.js(`(() => { const s = document.querySelector('#results-groups .credit-label .cl-slide'); s.scrollIntoView({ block: 'center' });
  const r = s.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const slideState = (P) => P.js(`(() => { const s = document.querySelector('#results-groups .credit-label .cl-slide');
  return { t: getComputedStyle(s).transform, px: s.style.getPropertyValue('--px') || '0', hover: s.classList.contains('is-hover') }; })()`);
const anims = (P) => P.js(`[...document.querySelectorAll('#results-groups .credit-label')].reduce((n, l) => n + l.getAnimations({ subtree: true }).length, 0)`);
const mouse = (P, x, y) => P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

/* The game reads class stats straight from Supabase: answer them from a local stub; any live request is failed and counted. */
const stubs = [];
const liveCount = () => stubs.reduce((n, c) => n + c.live, 0);
async function safePage(opts) {
  const P = await page(Object.assign({ motion: true }, opts)); // game page: keep its own motion (tests it)
  stubs.push(await stubGameStats(P));
  return P;
}
async function boot(opts) {
  const P = await safePage(opts);
  await P.go(BASE + '/?credit-test=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.showResultsForPuzzle)');
  await show(P);
  await P.waitFor('!document.getElementById("overlay-results").hidden');
  return P;
}

for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await boot({ width: 1100, height: 900, dark });
  check(`R0 ${tag}: results open, theme applied`, (await P.attr('html', 'data-theme')) === tag);
  check(`R1 ${tag}: two signed labels (named groups only)`, (await P.count('#results-groups .credit-label')) === 2);
  const t1 = await P.text(placard(0) + ' .credit-label');
  check(`R1 ${tag}: named label says "Submitted by" + name`, /Submitted by/.test(t1) && /John D\. · MS2/.test(t1), t1);
  check(`R1 ${tag}: label has a spoken name`, (await P.attr(placard(0) + ' .cl-slide', 'aria-label')) === 'Category submitted by John D. · MS2');
  check(`R1 ${tag}: no tier color on the label`, !/tier/.test(await P.js(`document.querySelector('${placard(0)} .credit-label').outerHTML`)));
  check(`R2 ${tag}: anonymous group -> quiet line, no label`, (await P.text(placard(1) + ' .result-placard-credit.is-anon')) === 'Category by an anonymous classmate' && !(await P.count(placard(1) + ' .credit-label')));
  check(`R2 ${tag}: anonymous line never animates`, (await P.js(`document.querySelector('${placard(1)} .is-anon').getAnimations().length`)) === 0);
  check(`R3 ${tag}: house group -> no credit at all`, !(await P.count(placard(2) + ' .credit-label, ' + placard(2) + ' .result-placard-credit')));
  check(`R4 ${tag}: CTA shown with link to the Studio`, (await P.visible('.credit-cta')) && /(^|\/)studio\/\?submit$/.test(await P.attr('.credit-cta a', 'href')), await P.attr('.credit-cta a', 'href'));
  check(`R4 ${tag}: CTA has the blank dashed label`, /your name here/.test(await P.text('.credit-cta .credit-label.is-blank')) && (await P.attr('.credit-cta .credit-label', 'aria-hidden')) === 'true');
  check(`R5 ${tag}: stats, stamp and share still there`, (await P.text('#results-found')) === '4 / 4' && (await P.text('#results-stamp')) === 'Case closed' && (await P.visible('#btn-share')) && (await P.count('#results-path .results-path-row')) === 1);
  // Entrance plays once it is on screen.
  const box = await slideBox(P);
  check(`R6 ${tag}: label flips in when scrolled into view`, await P.waitFor(`document.querySelector('#results-groups .credit-label').classList.contains('is-in')`, 3000));
  check(`R6 ${tag}: entrance uses the flip-in animation`, (await P.js(`getComputedStyle(document.querySelector('#results-groups .credit-label')).animationName`)) === 'cl-in');
  await P.sleep(1400);
  const rest = await slideState(P);
  // Hover: tilt toward the pointer, then spring back on leave.
  await mouse(P, box.x - 40, box.y + box.h + 60);
  await mouse(P, box.x + box.w * 0.85, box.y + box.h * 0.2); await P.sleep(50);
  await mouse(P, box.x + box.w * 0.9, box.y + box.h * 0.2); await P.sleep(400);
  const hov = await slideState(P);
  check(`R7 ${tag}: hover tilts the label toward the pointer`, hov.hover && parseFloat(hov.px) > 0.5 && hov.t !== rest.t && /matrix3d/.test(hov.t), { rest, hov });
  check(`R7 ${tag}: glare shows on hover`, parseFloat(await P.js(`getComputedStyle(document.querySelector('#results-groups .cl-glare')).opacity`)) > 0.5);
  if (SHOTS) await P.shot(SHOTS + '/results-credit-' + tag + '.png');
  await mouse(P, 5, 5); await P.sleep(800);
  const back = await slideState(P);
  check(`R7 ${tag}: springs back on leave`, !back.hover && back.px === '0' && back.t === rest.t, { rest, back });
  if (SHOTS) { await P.js(`document.querySelector('.credit-cta').scrollIntoView({ block: 'end' })`); await P.sleep(1600); await P.shot(SHOTS + '/results-credit-cta-' + tag + '.png'); }
  check(`R9 ${tag}: no school wording on the results screen (one school publishes)`, !/school/i.test(await P.js('document.getElementById("overlay-results").innerText')));
  check(`R8 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}

// Reduced motion: no entrance, no tilt; hover only shows a still sheen.
{
  const P = await safePage({ width: 1100, height: 900 });
  await P.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
  await P.go(BASE + '/?credit-rm=' + Date.now());
  await P.waitFor('!!(window.__dp2d && window.__dp2d.showResultsForPuzzle)');
  await show(P); await P.sleep(200);
  check('M1 reduced motion: labels shown at once, no entrance', (await P.count('#results-groups .credit-label.is-in.no-entrance')) === 2 && (await anims(P)) === 0);
  const box = await slideBox(P);
  const rest = await slideState(P);
  await mouse(P, box.x + box.w * 0.9, box.y + box.h * 0.2); await P.sleep(50);
  await mouse(P, box.x + box.w * 0.95, box.y + box.h * 0.1); await P.sleep(300);
  const hov = await slideState(P);
  check('M2 reduced motion: hover does not tilt', hov.hover && hov.px === '0' && hov.t === rest.t, { rest, hov });
  check('M2 reduced motion: still sheen on hover, nothing animating', parseFloat(await P.js(`getComputedStyle(document.querySelector('#results-groups .cl-glare')).opacity`)) > 0 && (await anims(P)) === 0);
  check('M3 no console errors', P.errors.length === 0, P.errors);
  P.close();
}

// Phone: the label and the invitation fit 375 px.
{
  const P = await boot({ width: 375, height: 760, mobile: true, dark: true });
  await P.sleep(1200); await slideBox(P); await P.sleep(1600);
  check('P1 phone: results fit 375 px', (await P.overflow()) <= 0, await P.overflow());
  check('P1 phone: label stays inside its placard', await P.js(`(() => { const a = document.querySelector('#results-groups .credit-label').getBoundingClientRect(), b = document.querySelector('${placard(0)}').getBoundingClientRect(); return a.right <= b.right + 1 && a.left >= b.left - 1; })()`));
  if (SHOTS) await P.shot(SHOTS + '/results-credit-phone-dark.png');
  check('P2 no console errors', P.errors.length === 0, P.errors);
  P.close();
}
// Home page: the header and footer "Submit a category" links are gone (the results invitation is the way in now).
{
  const P = await safePage({ width: 1280, height: 900 });
  await P.go(BASE + '/?home=' + Date.now());
  await P.waitFor('!!document.getElementById("btn-play-today")'); await P.sleep(1200);
  check('H1 no "Submit a category" in the header', !(await P.count('.site-head a[href*="studio"], .site-head-actions a[href*="studio"]')));
  check('H1 no "Submit a category" in the footer', !(await P.count('.site-foot a[href*="studio"]')));
  check('H2 header still has How to play, My stats, theme', (await P.count('#btn-menu-help')) === 1 && (await P.count('#btn-menu-stats')) === 1 && (await P.count('#btn-menu-theme')) === 1);
  check('H4 no school wording anywhere visible on the home page', !/school/i.test(await P.js('document.body.innerText')));
  if (SHOTS) await P.shot(SHOTS + '/home.png');
  check('H3 no console errors', P.errors.length === 0, P.errors);
  P.close();
}
check('Z1 never touched the live database', liveCount() === 0, liveCount());
process.exit(summary());
