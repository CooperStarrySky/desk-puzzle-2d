// Part 2 of plan_layout_a.e2e.mjs: the Database rail's filters work exactly
// like the Category database tab's (same module): search, receiving school,
// block, usage, More filters (status, difficulty, clue types, submitter, dates)
// plus the Planner's own (images, draft usage, min 👍, submitted within, kind),
// active-filter chips with × and Clear all, sorts. Trash never shows.
const CL = 'Causes of clubbing', HE = 'Causes of hemoptysis', LE = 'Lead poisoning signs', AS = 'Asthma triggers', CH = 'Cheese-related', HO = 'Holes in things', GA = 'Group A';
const ALL = [CL, HE, LE, AS, CH, HO, GA];

export async function runPart2({ P, check, names, settle, same, shot }) {
  const is = async (label, want) => { const got = await names(); check(label, same(got, want), got); };
  const chip = async (sel) => { await P.click(sel); await settle(); };
  const chips = () => P.js('[...document.querySelectorAll("#active-f .af-chip")].map((x) => x.firstChild.textContent)');
  const clearAll = async () => { await P.click('#af-clear'); await settle(); };
  await is('F0 Database lists every category not in Trash (7, groups count on their own)', ALL);
  check('F0 result line', (await P.text('#lib-n')) === 'Showing 7 of 7' && (await P.text('#lib-count')) === '7 categories');

  await P.type('#sug-q', 'clubbing'); await P.sleep(700);
  await is('F1 search: "clubbing"', [CL]);
  check('F1 search shows as a chip', (await chips()).some((c) => /Search: “clubbing”/.test(c)), await chips());
  await chip('[data-afx="0"]');
  await is('F1 × on the chip clears the search', ALL);
  check('F1 search box emptied too', (await P.js('document.getElementById("sug-q").value')) === '');
  await P.type('#sug-q', 'hemo'); await P.sleep(700);
  await is('F2 part of a word still finds it ("hemo")', [HE]);
  await P.type('#sug-q', ''); await P.sleep(700);

  await chip('#f-toggle');
  check('F3 Filters opens a collapsible section inside the rail', (await P.visible('#filters')) && (await P.attr('#f-toggle', 'aria-expanded')) === 'true' &&
    (await P.js('getComputedStyle(document.getElementById("filters")).position')) === 'static');
  await chip('#ms-btn');
  check('F3 receiving school: searchable multi-select with counts', (await P.visible('#ms-q')) && (await P.text('label:has(#ms-c-rvsom) .n')) === '2');
  await chip('#ms-c-rvsom');
  await is('F3 school = Rowan-Virtua', [LE, CH]);
  check('F3 school chip in the panel and in the active list', (await P.count('.ms-chip')) === 1 && (await chips()).some((c) => /^To /.test(c)), await chips());
  await chip('#ms-c-cmsru');
  await is('F3 + CMSRU = everything', ALL);
  await chip('#ms-done'); await chip('#ms-clear');

  await chip('[data-f="block"][data-v="Pulm"]');
  await is('F4 block Pulm', [CL, HE, AS]);
  await shot('planner-A2-database-open-with-filters');
  await chip('[data-f="block"][data-v="Micro"]');
  await is('F4 Pulm + Micro', [CL, HE, AS, CH]);
  check('F4 two chips + "Filters (2)"', (await chips()).length === 2 && (await P.text('#f-toggle')) === 'Filters (2)', [await chips(), await P.text('#f-toggle')]);
  await clearAll();
  await is('F4 Clear all', ALL);
  check('F4 no chips left', (await chips()).length === 0 && (await P.text('#f-toggle')) === 'Filters');

  await chip('[data-seg="used"][data-v="never"]'); await is('F5 usage: never used', [CL, LE, AS, CH, GA]);
  await chip('[data-seg="used"][data-v="used"]'); await is('F5 usage: used', [HE, HO]);
  await chip('[data-seg="used"][data-v="draft"]');
  const dr = await names(); check('F5 usage: in a draft (Lead is in this draft)', dr.includes(LE) && !dr.includes(CL) && !dr.includes(HE), dr);
  await chip('[data-seg="used"][data-v="any"]');

  await chip('#more-f');
  check('F6 More filters opens', (await P.visible('#more-panel')) && (await P.attr('#more-f', 'aria-expanded')) === 'true');
  await chip('[data-f="st"][data-v="new"]');
  const nw = await names(); check('F6 status: New (not used, not in a draft)', nw.includes(CL) && !nw.includes(HE) && !nw.includes(HO) && !nw.includes(LE), nw);
  await chip('[data-f="st"][data-v="new"]');
  await chip('[data-f="tier"][data-v="4"]'); await is('F6 suggested difficulty: Hardest', [CH]); await chip('[data-f="tier"][data-v="4"]');
  await chip('[data-f="ct"][data-v="photo"]'); await is('F6 clue type: Photo', [CL]); await chip('[data-f="ct"][data-v="photo"]');
  await chip('[data-seg="sub"][data-v="anon"]'); await is('F6 submitter: anonymous', [CH]); await chip('[data-seg="sub"][data-v="all"]');
  await chip('[data-seg="img"][data-v="text"]'); await is('F6 images: text only (none here)', []);
  check('F6 empty result says so', /Nothing matches/.test(await P.text('#lib-list')));
  await chip('[data-seg="img"][data-v="has"]'); await is('F6 images: has images', ALL); await chip('[data-seg="img"][data-v="any"]');
  await chip('[data-seg="duse"][data-v="this"]'); await is('F6 draft usage: in this draft', [LE]);
  await chip('[data-seg="duse"][data-v="none"]'); const nd = await names(); check('F6 draft usage: not in any draft', !nd.includes(LE) && nd.includes(CL), nd);
  await chip('[data-seg="duse"][data-v="any"]');
  await chip('[data-seg="minv"][data-v="2"]'); await is('F6 min 👍 2+', [CL]);
  await chip('[data-seg="minv"][data-v="1"]'); await is('F6 min 👍 1+', [CL, HE]); await chip('[data-seg="minv"][data-v="0"]');
  await chip('[data-seg="within"][data-v="7"]'); await is('F6 submitted within 7 days', [CL, LE, AS]); await chip('[data-seg="within"][data-v="any"]');
  await chip('[data-seg="kind"][data-v="group"]'); await is('F6 kind: group from a full puzzle', [GA]); await chip('[data-seg="kind"][data-v="any"]');
  const d5 = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
  await P.js(`(() => { const e = document.getElementById("f-from"); e.value = "${d5}"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`); await settle();
  await is('F6 submitted from 5 days ago', [CL, LE, AS]);
  await chip('[data-f="tier"][data-v="1"]');
  check('F7 chips list every active filter', (await chips()).length === 2 && (await P.text('#f-toggle')) === 'Filters (2)', await chips());
  await chip('[data-afx="0"]');
  check('F7 × removes just that one', (await chips()).length === 1, await chips());
  await is('F7 left: submitted from 5 days ago', [CL, LE, AS]);
  await clearAll();
  await is('F7 Clear all brings everything back', ALL);
  check('F7 Trash never shows', !(await names()).some((n) => /Things that are blue|Spare category/.test(n)));

  const sortBy = async (v) => { await P.js(`(() => { const e = document.getElementById("sug-sort"); e.value = "${v}"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`); await settle(); return names(); };
  const opts = await P.js('[...document.getElementById("sug-sort").options].map((o) => o.value)');
  check('F8 sorts: the Category database\'s plus difficulty and fewest images', ['newest', 'oldest', 'votes', 'used', 'unused', 'name', 'diff', 'imgs'].every((v) => opts.includes(v)), opts);
  const byName = await sortBy('name'); check('F8 Name A–Z', JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))), byName);
  check('F8 Newest first', (await sortBy('newest'))[0] === CL);
  check('F8 Oldest first', (await sortBy('oldest'))[0] === GA);
  check('F8 Most 👍', (await sortBy('votes'))[0] === CL);
  check('F8 Most used', (await sortBy('used'))[0] === HE);
  check('F8 Fewest images puts the photo category last', (await sortBy('imgs')).slice(-1)[0] === CL);
  const tiers = async () => P.js('[...document.querySelectorAll("#lib-list .lib-card")].map((c) => Number((c.className.match(/\\bt(\\d)\\b/) || [0, 9])[1]))');
  await sortBy('diff'); const ts = await tiers(); check('F8 Difficulty easy→hard', ts.every((t, i) => !i || ts[i - 1] <= t), ts);
  await sortBy('votes');
  await chip('#f-toggle');
  check('F9 Filters section folds away again', !(await P.visible('#filters')));
}
