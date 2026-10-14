// Part 2 of cards_b2.e2e.mjs (same page, CMSRU admin): folding filter
// sections (kept per browser, badges), the sidebar folding to a strip with a
// filter count and its width bar (drag, keys, double-click reset, kept), the
// opened category (rows folded, comment shortcut + visibility, Submission
// info last), and partial-word search.
export async function runPart2({ P, check, sql, C, BASE, card, q, shot }) {
  const reload = async (tag) => { await P.go(BASE + '/inbox/?mock&' + tag + '#/categories'); await P.waitFor('document.querySelectorAll("#sug-list .sug-card").length > 0'); await P.settle(); };
  const open = (k) => P.js(`document.getElementById("fsh-${k}").getAttribute("aria-expanded") === "true" && !document.getElementById("fsb-${k}").hidden`);

  // ===== C5: folding sections =====
  check('C5 Search stays above the list, outside the sections', (await P.count('#filters #sug-q')) === 0 && (await P.count('.searchbar #sug-q')) === 1);
  const heads = await P.js('[...document.querySelectorAll("#filters .fsec-btn")].map((b) => b.textContent.trim())');
  check('C5 every group is a section with a heading', heads.length === 9 && heads[0] === 'Receiving school' && heads.includes('Count 👍 from'), heads);
  check('C5 school, block, usage open; the rest folded', (await open('school')) && (await open('block')) && (await open('used')) && !(await open('st')) && !(await open('ct')));
  await P.click('#fsh-block'); await P.sleep(60); await P.click('#fsh-st'); await P.sleep(60);
  await P.click('#filters [data-f="st"][data-v="new"]'); await P.settle();
  await P.click('#fsh-st'); await P.sleep(60); await P.click('#fsh-ct'); await P.sleep(60);
  await P.click('#filters [data-f="ct"][data-v="photo"]'); await P.settle(); await P.click('#fsh-ct'); await P.sleep(60);
  check('C5 badges on folded headings with filters on', (await P.text('#fsh-st .fsec-n')) === '1' && (await P.text('#fsh-ct .fsec-n')) === '1' && (await P.count('#fsh-block .fsec-n')) === 0);
  await P.click('#fsh-ct'); await P.sleep(60); await P.click('#filters [data-f="ct"][data-v="photo"]'); await P.settle(); await P.click('#fsh-ct'); await P.sleep(60);
  check('C5 chips + Clear all stay above the results', /New/.test(await P.text('#active-f')) && (await P.count('#active-f #af-clear')) === 1 &&
    (await P.js('document.getElementById("active-f").getBoundingClientRect().bottom <= document.getElementById("sug-list").getBoundingClientRect().top')));
  await shot('09-filters-collapsible');
  await reload('c5');
  check('C5 open/closed kept after a reload', !(await open('block')) && !(await open('st')) && (await open('school')) && (await open('used')));
  await P.click('#fsh-block'); await P.sleep(60);
  await P.click('#filters [data-seg="used"][data-v="never"]'); await P.settle();

  // ===== C5b: the sidebar folds to a strip and resizes =====
  check('C5b fold button in the sidebar head', (await P.visible('#f-fold')) && !(await P.visible('#f-strip')));
  await P.click('#f-fold'); await P.sleep(120);
  const L = (k) => P.js(`document.querySelector("#ws-main .sug-layout").${k}`);
  check('C5b folds to a slim strip with the filter count', (await L('dataset.fold')) === 'closed' && (await P.visible('#f-strip')) && !(await P.visible('#filters')) &&
    (await P.text('#f-strip-n')) === '1' && (await P.focused()) === 'f-strip' && (await P.js('Math.round(document.getElementById("f-strip").getBoundingClientRect().width)')) <= 50);
  await shot('10-filters-folded');
  await reload('c5b');
  check('C5b stays folded after a reload', (await L('dataset.fold')) === 'closed');
  await P.click('#f-strip'); await P.sleep(120);
  check('C5b strip opens it again, focus on the fold button', (await L('dataset.fold')) === 'open' && (await P.visible('#filters')) && (await P.focused()) === 'f-fold');
  const fw = () => P.js('Math.round(document.getElementById("filters").getBoundingClientRect().width)');
  const w0 = await fw();
  await P.js('document.getElementById("f-handle").focus()'); await P.key('ArrowRight', 'ArrowRight', 39); await P.key('ArrowRight', 'ArrowRight', 39);
  check('C5b width bar: arrow keys', (await fw()) === w0 + 32 && (await P.attr('#f-handle', 'aria-valuenow')) === String(w0 + 32), [w0, await fw()]);
  await P.key('ArrowRight', 'ArrowRight', 39, 8);
  check('C5b Shift = bigger steps', (await fw()) === w0 + 96);
  await P.key('Home', 'Home', 36); const wmin = await fw(); await P.key('End', 'End', 35); const wmax = await fw();
  check('C5b Home/End = narrowest/widest', wmin === 200 && wmax === 440, [wmin, wmax]);
  const h = await P.js('(() => { const r = document.getElementById("f-handle").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + 40)]; })()');
  const m = (type, x) => P.send('Input.dispatchMouseEvent', { type, x, y: h[1], button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await m('mousePressed', h[0]); await m('mouseMoved', h[0] - 60); await m('mouseMoved', h[0] - 140); await m('mouseReleased', h[0] - 140); await P.sleep(100);
  check('C5b drag the bar narrower', (await fw()) === 300, await fw());
  await reload('c5c');
  check('C5b width kept after a reload', (await fw()) === 300, await fw());
  await P.js('document.getElementById("f-handle").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))'); await P.sleep(100);
  check('C5b double-click resets the width', (await fw()) === 250 && /width reset/.test(await P.toast()));
  await P.click('#af-clear'); await P.settle();

  // ===== C6: the opened category =====
  await P.click('#tg-' + C.hemoptysis); await P.waitFor(`!!document.querySelector(${q('#sd-' + C.hemoptysis + ' .sd-cmts .composer')})`);
  const sd = '#sd-' + C.hemoptysis;
  const rows = await P.js(`[...document.querySelectorAll(${q(sd + ' .secs > details')})].map((d) => (d.open ? 'OPEN ' : '') + d.querySelector('summary').childNodes[0].textContent.trim())`);
  check('C6 rows, all folded: Comments … Submission info last', JSON.stringify(rows) === JSON.stringify(['Comments', 'Usage', 'Block / system tags', 'History', 'Edit history', 'Submission info']), rows);
  const top = await P.js(`[...document.querySelector(${q(sd + ' > .stack')}).children].map((e) => e.className.split(' ')[0])`);
  check('C6 clues and explanation on top, then the rows', JSON.stringify(top) === '["sd-clues","expl","secs"]' && /^Why these go together:/.test(await P.text(sd + ' .expl')), top);
  check('C6 Submission info: who, contact, receipt, date, school', /Submitted by.*Contact.*Receipt.*DP-.*Date.*School.*Cooper Medical School/.test(await P.js(`document.querySelector(${q(sd + ' .sub-info .kv')}).textContent`)));
  check('C6 Comments row: count + "+ Add comment"', (await P.text(sd + ' .sd-cm-n')) === '0' && (await P.text(sd + ' .addc')) === '+ Add comment');
  await P.js(`(() => { const e = document.querySelector(${q(sd + ' .expl')}); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 420); })()`); await P.sleep(150);
  await shot('11-detail-collapsed', false);
  await P.click(sd + ' .addc'); await P.sleep(120);
  check('C6 shortcut opens Comments with the box focused', (await P.js(`document.querySelector(${q(sd + ' details.cmts')}).open`)) && (await P.focused()) === 'cm-' + C.hemoptysis &&
    (await P.js(`[...document.querySelectorAll(${q(sd + ' .secs > details')})].filter((d) => d.open).length`)) === 1 && !(await P.visible(sd + ' .addc')));
  check('C6 box: 🔒 My school only (default) / 🌐 All schools + Post', (await P.attr(sd + ' .vis-tog [data-v="school"]', 'aria-checked')) === 'true' && (await P.text(sd + ' [data-cact="post"]')) === 'Post');
  await P.click(sd + ' .vis-tog [data-v="all"]'); await P.type(sd + ' .cm-in', 'Mitral stenosis could be a harder fifth clue.');
  await P.js(`(() => { const e = document.querySelector(${q(sd + ' .expl')}); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 260); })()`); await P.sleep(150);
  await shot('12-detail-comment', false);
  await P.click(sd + ' [data-cact="post"]'); await P.waitFor('/for all schools/.test(document.getElementById("toast").textContent)');
  await P.waitFor(`/Mitral stenosis/.test(document.querySelector(${q(sd + ' .sd-cmts')}).textContent)`);
  const row = ((await sql(`select visibility, school from comments where body like 'Mitral stenosis%'`)).rows || [])[0] || {};
  check('C6 posted for all schools', row.visibility === 'all' && row.school === 'cmsru', row);
  check('C6 Comments stays open after posting, count 1, 🌐 shown', (await P.js(`document.querySelector(${q(sd + ' details.cmts')}).open`)) && (await P.text(sd + ' .sd-cm-n')) === '1' && /🌐 All schools/.test(await P.text(sd + ' .sd-cmts')));
  await P.click('#tg-' + C.hemoptysis); await P.sleep(150);
  await P.click('#tg-' + C.hemoptysis); await P.waitFor(`!!document.querySelector(${q(sd + ' .sd-cmts .composer')})`);
  check('C6 reopened: everything folded again (nothing remembered)', (await P.js(`[...document.querySelectorAll(${q(sd + ' .secs > details')})].every((d) => !d.open)`)));
  check('C6 the open card keeps ⋯, Add to draft…, 👍 at the top', (await P.count(card(C.hemoptysis) + ' .sug-top .card-acts .vote-btn')) === 1 && (await P.count(sd + ' .vote-btn')) === 0);
  await P.click('#tg-' + C.hemoptysis); await P.sleep(150);

  // ===== C7: partial words =====
  const names = () => P.names();
  await P.type('#sug-q', 'hemo'); await P.sleep(400); await P.settle();
  check('C7 "hemo" finds hemoptysis (part of a word)', JSON.stringify(await names()) === '["Causes of hemoptysis"]', await names());
  await P.type('#sug-q', 'clubb'); await P.sleep(400); await P.settle();
  check('C7 "clubb" finds clubbing', JSON.stringify(await names()) === '["Causes of clubbing"]', await names());
  await P.type('#sug-q', 'stippl'); await P.sleep(400); await P.settle();
  check('C7 clue words match too ("stippl")', JSON.stringify(await names()) === '["Lead poisoning signs"]', await names());
  await P.type('#sug-q', ''); await P.sleep(400); await P.settle();
}
