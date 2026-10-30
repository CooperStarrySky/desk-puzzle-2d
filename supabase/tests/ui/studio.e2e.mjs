// node supabase/tests/ui/studio.e2e.mjs   (pg_server.mjs running; BASE=http://127.0.0.1:4820)
// The Puzzle Studio after the multischool release: one category only (no
// full-puzzle mode, no test play), a "Your school" list from active_schools(),
// and a real send through the submit function's handler into PGlite (a small inline
// thank-you, no receipt popup; the backend still stores a receipt code). The
// Studio's config is pointed at pg_server's /__fake stand-in before the page
// loads, so nothing reaches the live project.
import { page, check, summary, resetDb, sql, BASE } from './lib.mjs';

await resetDb();
const FAKE = BASE + '/__fake';
const P = await page({ width: 1280, height: 900 });
// config.js assigns window.DESK_PUZZLE_CONFIG; swap the URL as it lands.
await P.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'DESK_PUZZLE_CONFIG', { configurable: true,
  get() { return this.__dpc; }, set(v) { this.__dpc = Object.assign({}, v, { supabaseUrl: ${JSON.stringify(FAKE)}, turnstileSiteKey: '' }); } });` });
// Belt and braces: anything still aimed at supabase.co is failed in the browser.
let live = 0;
await P.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] });
P.on((m) => { if (m.method === 'Fetch.requestPaused') { live++; P.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); } });

const open = async (q) => { await P.go(BASE + '/studio/' + (q || '?submit')); return P.waitFor('document.querySelectorAll("#s-school option").length > 1'); };
check('studio: loads and the school list fills in', await open());
check('studio: config points at the local stand-in', String(await P.js('window.DESK_PUZZLE_CONFIG.supabaseUrl')).startsWith(FAKE));
check('studio: no full-puzzle mode switch', (await P.count('.modebar, #mode-puzzle, [data-mode="puzzle"]')) === 0);
check('studio: no test-play view or Edit/Test play tabs', (await P.count('#view-play, #tab-play, #head-tabs')) === 0);
const opts = await P.js('[...document.querySelectorAll("#s-school option")].map((o) => o.value + "|" + o.textContent)');
check('studio: "Your school" lists the active schools', opts.includes('cmsru|Cooper Medical School of Rowan University') && opts.includes('rvsom|Rowan-Virtua SOM') && opts.length === 3, opts);
check('studio: no school picked yet when there are several', (await P.js('document.getElementById("s-school").value')) === '');
check('studio: checklist asks for a school', (await P.text('#checks')).includes('Pick your school'));

// Required markers: a red star after each required label, aria-required on the control.
const reqState = () => P.js(`(() => {
  const star = (el) => { const box = el && (el.closest('label, .field')); const m = box && box.querySelector('.req-mark'); return m ? (m.classList.contains('filled') ? 'filled' : 'red') : 'none'; };
  const q = (s) => document.querySelector(s);
  return { legend: !!q('.req-legend .req-mark'), name: star(q('[data-k="g.name"]')), expl: star(q('[data-k="g.explanation"]')),
    tier: star(q('.tier-pick')), label0: star(q('[data-f="label"][data-i="0"]')), school: star(q('#s-school')), consent: star(q('#s-consent')),
    credit: (() => { const m = q('[data-for="s-credit-grp"]'); return m ? (m.classList.contains('filled') ? 'filled' : 'red') : 'none'; })(),
    email: star(q('[data-k="c.email"]')), note0: star(q('[data-f="note"][data-i="0"]')), article: star(q('[data-k="g.articleText"]')),
    aria: ['[data-k="g.name"]', '[data-k="g.explanation"]', '#s-tier-x', '#s-school', '#s-consent', '#s-credit-grp', '[data-f="label"][data-i="3"]', '[data-f="zone"][data-i="0"]']
      .filter((s) => s !== '#s-tier-x').every((s) => q(s) && q(s).getAttribute('aria-required') === 'true') && q('.tier-pick').getAttribute('aria-required') === 'true',
    ariaOpt: [...document.querySelectorAll('[data-k="c.email"], [data-f="note"], [data-k="g.nids"]')].every((x) => !x.hasAttribute('aria-required')),
    red: getComputedStyle(q('.req-legend .req-mark')).color };
})()`);
let rq = await reqState();
check('studio: "* = required" legend near the top', rq.legend, rq);
check('studio: required labels carry a red star (name, explanation, difficulty, clue, school, credit, consent)', ['name', 'expl', 'tier', 'label0', 'school', 'consent', 'credit'].every((k) => rq[k] === 'red'), rq);
check('studio: optional fields have no star', rq.email === 'none' && rq.note0 === 'none' && rq.article === 'none', rq);
check('studio: required controls have aria-required, optional ones do not', rq.aria && rq.ariaOpt, rq);
check('studio: star uses the danger red', /rgb\(192, 57, 47\)/.test(rq.red), rq.red);

// Fill in one category.
await P.type('[data-k="g.name"]', 'TEST: causes of clubbing (studio e2e)');
await P.type('[data-k="g.explanation"]', 'Each causes digital clubbing.');
for (let i = 0; i < 4; i++) await P.type(`[data-f="label"][data-i="${i}"]`, ['Lung cancer', 'Bronchiectasis', 'Cyanotic heart disease', 'IBD'][i]);
await P.click('input[name="s-tier"][value="2"]');
await P.click('input[name="s-credit"][value="anonymous"]');
await P.click('#s-consent');
await P.js('(() => { const s = document.getElementById("s-school"); s.value = "rvsom"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
check('studio: school hint names the receiving school', (await P.text('#s-school-hint')).includes('Rowan-Virtua SOM'));
check('studio: ready to send once a school is picked', (await P.text('#checks')).includes('Ready to send'), await P.text('#checks'));

rq = await reqState();
check('studio: stars fade once each required field is filled', ['name', 'expl', 'tier', 'label0', 'school', 'consent', 'credit'].every((k) => rq[k] === 'filled'), rq);
await P.click('input[name="s-credit"][value="named"]');
check('studio: "Name to show" gets a star only when "Credit me" is chosen', await P.js('!!document.querySelector("[data-k=\\"c.name\\"]").closest("label").querySelector(".req-mark:not(.filled)") && document.querySelector("[data-k=\\"c.name\\"]").getAttribute("aria-required") === "true"'));
await P.click('input[name="s-credit"][value="anonymous"]');
check('studio: no name field (and no name star) when anonymous', (await P.count('[data-k="c.name"]')) === 0);
await P.click('#btn-send');
const sent = await P.waitFor('!document.getElementById("send-ok").hidden', 20000);
check('studio: category sent through the real submit handler, with a small inline thank-you', sent && /^Thanks! Your category .* was sent/.test(await P.text('#send-ok-msg')), await P.text('#send-ok'));
check('studio: no receipt popup and no receipt code on screen', !(await P.count('#modal-root > *')) && !/DP-|receipt/i.test(await P.js('document.body.innerText')), await P.text('#modal-root'));
check('studio: thank-you names the school', (await P.text('#send-ok-msg')).includes('Rowan-Virtua SOM'));
check('studio: thank-you offers "Start another" and "Close"', (await P.visible('#send-ok-new')) && (await P.visible('#send-ok-close')));
let r = await sql('select school, kind, group_name, credit_mode, receipt_code from public.submissions where group_name = $1', ['TEST: causes of clubbing (studio e2e)']);
const row = (r.rows || [])[0] || {};
check('studio: stored with the chosen school, kind category, anonymous', row.school === 'rvsom' && row.kind === 'category' && row.credit_mode === 'anonymous', row);
check('studio: the backend still issues a receipt code', /^DP-/.test(row.receipt_code || ''), row);
if (process.env.SHOTS) {
  const fs = await import('node:fs');
  await P.js('window.scrollTo(0, 0)'); await P.sleep(200);
  const shot = await P.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.SHOTS + '/submit-thanks.png', Buffer.from(shot.data, 'base64'));
}
await P.click('#send-ok-new');
check('studio: "Start another" keeps the school and clears the category', (await P.js('document.getElementById("s-school").value')) === 'rvsom' && (await P.js('document.querySelector("[data-k=\\"g.name\\"]").value')) === '');
check('studio: the thank-you goes away after "Start another"', (await P.js('document.getElementById("send-ok").hidden')) === true);

// The function itself (same page origin, as the Studio calls it).
const post = (sub) => P.js(`fetch(${JSON.stringify(FAKE + '/functions/v1/submit')}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ submission: sub })}) }).then(async (x) => ({ s: x.status, j: await x.json() }))`);
const base = { format: 'desk-puzzle-submission', version: 2, kind: 'category', consent: true, suggestedTier: 1, credit: { mode: 'anonymous' },
  group: { name: 'TEST e2e', explanation: 'x', items: ['A', 'B', 'C', 'D'].map((l) => ({ label: l, zone: 'corkboard', info: { title: l } })) } };
let x = await post(Object.assign({}, base, { school: 'harvard' }));
check('submit: unknown school refused with a plain message', x.s === 400 && /recognize that school/.test(x.j.error), x);
await sql(`insert into public.schools (slug, name, status) values ('pinebrook', 'Pinebrook College of Medicine', 'setup')`);
x = await post(Object.assign({}, base, { school: 'pinebrook' }));
check('submit: a school still in setup is refused', x.s === 400, x);
x = await post(base);
check('submit: no school refused', x.s === 400 && /pick your school/i.test(x.j.error), x);
x = await post({ format: 'desk-puzzle-submission', version: 2, kind: 'puzzle', school: 'cmsru', consent: true, credit: { mode: 'anonymous' }, puzzle: { title: 't', groups: [] } });
check('submit: a full puzzle is refused (one category at a time)', x.s === 400 && /one category at a time/.test(x.j.error), x);
await open();
check('studio: a school in setup is not offered', !(await P.js('[...document.querySelectorAll("#s-school option")].some((o) => o.value === "pinebrook")')));

// A full-puzzle draft saved before the change: offered one category at a time.
await P.js(`localStorage.setItem('dp2d:studio-draft', JSON.stringify({ v: 1, title: 'Old week', creditMode: 'named', name: 'John D.', groups: [
  { name: 'Old group one', tier: 3, items: [{ label: 'Alpha', zone: 'corkboard' }, { label: 'Beta', zone: 'corkboard' }, { label: 'Gamma', zone: 'corkboard' }, { label: 'Delta', zone: 'corkboard' }] },
  { name: '', items: [] }, { name: 'Old group three', items: [{ label: 'Q', zone: 'folder' }] }, { name: '', items: [] }] }))`);
await open('?build');
check('studio: old ?build link opens the category form (?submit)', (await P.js('location.search')) === '?submit');
check('studio: saved full puzzle is offered, non-empty categories only', (await P.visible('#old-puz')) && (await P.count('#old-puz [data-old]')) === 2);
await P.click('#old-puz [data-old="0"]');
check('studio: "Use" copies that category into the editor', await P.waitFor('document.querySelector("[data-k=\\"g.name\\"]").value === "Old group one"'));
check('studio: copied category keeps its tier as the suggestion and the credit', (await P.js('document.querySelector("input[name=s-tier]:checked") && document.querySelector("input[name=s-tier]:checked").value')) === '3' && (await P.js('document.querySelector("[data-k=\\"c.name\\"]") && document.querySelector("[data-k=\\"c.name\\"]").value')) === 'John D.');
await P.click('#old-hide');
await open();
check('studio: "Hide this" keeps the banner hidden next visit', !(await P.visible('#old-puz')));
check('studio: the old draft itself is kept', /Old group one/.test(await P.js('localStorage.getItem("dp2d:studio-draft") || import("/src/idb-kv.js").then((m) => m.idbGet("dp2d:studio-draft")).then((v) => String(v || ""))')));

// Conditional stars follow the clue type and whether an image is attached.
const picStars = () => P.js(`(() => { const c = document.querySelector('[data-f="credit"][data-i="0"]'), np = document.querySelector('[data-np="0"]');
  return { src: c ? !!c.closest('label').querySelector('.req-mark') : null, srcAria: c ? c.getAttribute('aria-required') : null,
    np: np ? !!np.closest('label').querySelector('.req-mark') : null, npAria: np ? np.getAttribute('aria-required') : null }; })()`);
await P.js('(() => { const s = document.querySelector("[data-f=\\"zone\\"][data-i=\\"0\\"]"); s.value = "corkboard"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
let ps = await picStars();
check('studio: text clue has no image-source field', ps.src === null && ps.np === null, ps);
await P.js('(() => { const s = document.querySelector("[data-f=\\"zone\\"][data-i=\\"0\\"]"); s.value = "photo"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
ps = await picStars();
check('studio: photo clue without an image: source and no-patient box not starred yet', ps.src === false && ps.np === false && ps.srcAria === null && ps.npAria === null, ps);
await P.js(`(async () => { const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30; const x = cv.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 40, 30);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'john-d-test.png', { type: 'image/png' }));
  document.querySelector('[data-drop="0"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
await P.waitFor('!!document.querySelector(".drop.has[data-drop=\\"0\\"]")', 8000);
ps = await picStars();
check('studio: once an image is added, source and no-patient box are starred and aria-required', ps.src && ps.np && ps.srcAria === 'true' && ps.npAria === 'true', ps);
await P.click('[data-rm="0"]');
ps = await picStars();
check('studio: removing the image drops those stars again', ps.src === false && ps.np === false, ps);
if (process.env.SHOTS) await P.shot(process.env.SHOTS + '/studio-required-1280.png');

// Phone width.
await P.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
await open();
check('studio: no sideways scroll at 375px', (await P.overflow()) <= 0, await P.overflow());
if (process.env.SHOTS) await P.shot(process.env.SHOTS + '/studio-375.png');
check('studio: nothing went to supabase.co', live === 0, live);
check('studio: no console errors', P.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, P.errors);
P.close();
process.exit(summary() ? 1 : 0);
