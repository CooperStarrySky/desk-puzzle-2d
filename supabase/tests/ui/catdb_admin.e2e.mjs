// node supabase/tests/ui/catdb_admin.e2e.mjs  (needs pg_server.mjs running)
// Category database as a CMSRU admin: names and routes, usage line, filters,
// chips, saved views, sorts, Trash (one tap + Undo + reason, same filters,
// Restore), Fix the original + Undo, comment visibility, votes, Add to draft,
// keyboard shortcuts. Real row rules via PGlite.
import { page, check, summary, resetDb, U, C, BASE } from './lib.mjs';

await resetDb();
const P = await page();
const card = (id) => '#sug-list .sug-card[data-id="' + id + '"]';
const has = async (id) => (await P.count(card(id))) > 0;
check('A0 signs in as CMSRU admin', await P.signInAs(U.ADMIN));
await P.settle();

// 1. Names, routes, nothing left of Shortlist or full puzzles.
check('A1 tab is "Categories" (S3 rename)', /^Categories/.test(await P.text('#ws-tabs [aria-current]')), await P.text('#ws-tabs'));
check('A1 heading', (await P.text('#ws-main h1')) === 'Category database');
check('A1 route #/categories', (await P.js('location.hash')) === '#/categories');
const body = await P.text('#v-ws');
check('A1 no subtitle / Shortlist / full-puzzle words', !/what people sent in|shortlist|Full puzzle|Download all/i.test(body), body.match(/what people sent in|shortlist|Full puzzle|Download all/i));
await P.js('location.hash = "#/suggestions"'); await P.sleep(400);
check('A1 old #/suggestions forwards', (await P.js('location.hash')) === '#/categories');
await P.js('location.hash = "#s=' + C.clubbing + '"'); await P.waitFor('!!document.querySelector("' + card(C.clubbing) + '.open")');
check('A1 old #s=<id> opens the card at #/categories/<id>', (await P.js('location.hash')) === '#/categories/' + C.clubbing);
await P.click('#tg-' + C.clubbing); await P.sleep(200);
check('A1 closing returns to #/categories', (await P.js('location.hash')) === '#/categories');

// 2. Sub-tabs and counts.
check('A2 sub-tabs with counts', /^All categories 7\s*🗑 Trash 2$/.test(await P.text('#cat-subtabs')), await P.text('#cat-subtabs'));
check('A2 result line', (await P.text('#sug-n')) === 'Showing 7 of 7 categories in the database', await P.text('#sug-n'));

// 3. Usage (top right, zeros hidden) from category_usage; 👍 with the my-school split in its tooltip;
//    drafts counted only where RLS lets me see them.
const line = (id) => P.text(card(id) + ' .card-use');
const vote = (id) => P.js(`(() => { const b = document.querySelector(${JSON.stringify(card(id) + ' .card-acts .vote-btn')}); return b ? b.textContent + ' | ' + b.dataset.tip : null; })()`);
check('A3 used in 2 published puzzles', (await line(C.hemoptysis)) === 'In 2 published puzzles', await line(C.hemoptysis));
check('A3 as-is/adapted + schools in the usage tooltip', (await P.attr(card(C.hemoptysis) + ' .u-pub', 'title')) === '1 as-is, 1 adapted · CMSRU, RVSOM');
check('A3 👍 once, my-school split only in the tooltip', (await vote(C.hemoptysis)) === '👍 1 | 1 thumbs up · 0 from CMSRU · 1 school' && (await vote(C.clubbing)) === '👍 3 | You and 2 others · 2 from CMSRU · 2 schools', [await vote(C.hemoptysis), await vote(C.clubbing)]);
check('A3 never used + comments', (await line(C.clubbing)) === 'Not used yet💬 2', await line(C.clubbing));
check('A3 in a CMSRU draft', (await line(C.lead)) === 'In 1 draft', await line(C.lead));
check('A3 RV-only draft is invisible to CMSRU', !/draft/.test(await line(C.asthma)), await line(C.asthma));
check('A3 imported category: no source / credit text on the card', !/From published puzzle|Puzzle group|John Doe/.test(await P.text(card(C.imported))), await P.text(card(C.imported)));

// 4. Filters: school multi-select, chips, block, usage, more filters, clear.
check('A4 school, block, usage sections open', (await P.visible('#filters #ms-btn')) && (await P.count('#filters [data-f="block"]')) > 5 && (await P.visible('#filters [data-seg="used"]')) && (await P.count('#filters [data-seg="used"]')) === 4);
check('A4 the rest are folded sections, no More filters button', (await P.js('["st","tier","ct","sub","dates","vfrom"].every((k) => document.getElementById("fsb-" + k).hidden && document.getElementById("fsh-" + k).getAttribute("aria-expanded") === "false")')) && (await P.count('#more-f')) === 0);
await P.click('#ms-btn'); await P.sleep(100);
check('A4 school picker opens with search focused', (await P.focused()) === 'ms-q');
await P.type('#ms-q', 'virtua'); await P.sleep(50);
check('A4 typing narrows the schools', (await P.count('#ms-list [data-msk]')) === 1 && /RVSOM/.test(await P.text('#ms-list')));
await P.click('#ms-c-rvsom'); await P.settle();
check('A4 only RV categories', JSON.stringify((await P.names()).sort()) === JSON.stringify(['Cheese-related', 'Lead poisoning signs']), await P.names());
check('A4 chip + Filters (1)', /To RVSOM/.test(await P.text('#active-f')) && (await P.text('#f-toggle')) === 'Filters (1)');
await P.click('#active-f [data-afx="0"]'); await P.settle();
check('A4 × removes the chip', (await P.count('#sug-list .sug-card')) === 7 && (await P.text('#active-f')) === '');
await P.click('#filters [data-f="block"][data-v="Pulm"]'); await P.settle();
check('A4 block filter', (await P.count('#sug-list .sug-card')) === 3, await P.names());
await P.click('#filters [data-seg="used"][data-v="never"]'); await P.settle();
check('A4 usage: never used', JSON.stringify((await P.names()).sort()) === JSON.stringify(['Asthma triggers', 'Causes of clubbing']), await P.names());
await P.click('#filters [data-seg="used"][data-v="draft"]'); await P.click('#filters [data-f="block"][data-v="Pulm"]'); await P.settle();
check('A4 usage: in a draft', JSON.stringify(await P.names()) === JSON.stringify(['Lead poisoning signs']), await P.names());
await P.click('#fsh-tier'); await P.sleep(50);
check('A4 a folded section opens', !(await P.js('document.getElementById("fsb-tier").hidden')) && (await P.attr('#fsh-tier', 'aria-expanded')) === 'true' && (await P.focused()) === 'fsh-tier');
await P.click('#filters [data-seg="used"][data-v="any"]'); await P.click('#filters [data-f="tier"][data-v="4"]'); await P.settle();
await P.click('#fsh-tier'); await P.sleep(50);
check('A4 difficulty filter + badge on the folded heading', JSON.stringify(await P.names()) === JSON.stringify(['Cheese-related']) && (await P.text('#fsh-tier .fsec-n')) === '1', await P.text('#fsh-tier'));
await P.click('#af-clear'); await P.settle();
check('A4 Clear all', (await P.count('#sug-list .sug-card')) === 7 && (await P.text('#f-toggle')) === 'Filters');

// 5. Search (server, full text) and sorts.
await P.type('#sug-q', 'clubbing'); await P.sleep(400); await P.settle();
check('A5 word search', JSON.stringify(await P.names()) === JSON.stringify(['Causes of clubbing']), await P.names());
await P.type('#sug-q', ''); await P.sleep(400); await P.settle();
const sortBy = async (v) => { await P.js('(() => { const s = document.getElementById("sug-sort"); s.value = "' + v + '"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.settle(); return P.names(); };
check('A5 most used first', (await sortBy('used'))[0] === 'Causes of hemoptysis');
check('A5 never used first', !['Causes of hemoptysis', 'Holes in things'].includes((await sortBy('unused'))[0]));
check('A5 most 👍', (await sortBy('votes'))[0] === 'Causes of clubbing');
check('A5 name A–Z', (await sortBy('name'))[0] === 'Asthma triggers');
await sortBy('newest');

// 6. Saved views.
check('A6 presets', (await P.text('#views')) === 'AllNew since my last visitUnused at my schoolTop 👍＋ Save this view', await P.text('#views'));
await P.click('[data-pv="unused"]'); await P.settle();
check('A6 Unused at my school', !(await has(C.hemoptysis)) && !(await has(C.imported)) && (await has(C.lead)) && (await P.attr('[data-pv="unused"]', 'aria-pressed')) === 'true');
await P.click('[data-pv="top"]'); await P.settle();
check('A6 Top 👍 sorts by votes', (await P.js('document.getElementById("sug-sort").value')) === 'votes' && (await P.names())[0] === 'Causes of clubbing');
await P.click('[data-pv="all"]'); await P.click('#filters [data-f="block"][data-v="Heme"]'); await P.settle();
await P.click('#save-view'); await P.waitFor('!!document.getElementById("sv-n")');
await P.type('#sv-n', 'Heme only'); await P.submit('#sv-form'); await P.sleep(150);
check('A6 Save this view', /Heme only/.test(await P.text('#views')) && (await P.attr('[data-sv="0"]', 'aria-pressed')) === 'true');
await P.js('localStorage.setItem("dp2d:cat-visit:' + U.ADMIN + '", new Date(Date.now() - 2 * 864e5).toISOString())');
await P.go(BASE + '/inbox/?mock&reload=1#/categories'); await P.waitFor('document.querySelectorAll("#sug-list .sug-card").length > 0'); await P.settle();
check('A6 saved view survives a reload', /Heme only/.test(await P.text('#views')));
await P.click('[data-sv="0"]'); await P.settle();
check('A6 saved view applies', JSON.stringify(await P.names()) === JSON.stringify(['Lead poisoning signs']), await P.names());
await P.click('[data-svx="0"]'); await P.sleep(100);
check('A6 delete a saved view', !/Heme only/.test(await P.text('#views')));
await P.click('[data-pv="since"]'); await P.settle();
check('A6 New since my last visit', JSON.stringify(await P.names()) === JSON.stringify(['Causes of clubbing']), await P.names());
await P.click('[data-pv="all"]'); await P.settle();

const { partB } = await import('./catdb_admin_b.mjs');
await partB({ P, card, has, line, sortBy });
const errs = P.errors.filter((e) => !/favicon/.test(e));
check('A99 no console errors', errs.length === 0, errs);
P.close(); process.exit(summary());
