// Part B of catdb_admin.e2e.mjs (same page, same signed-in CMSRU admin).
import { check, sql, U, C } from './lib.mjs';

export async function partB({ P, card, has, line }) {
  const menu = async (id, act) => { await P.click(card(id) + ' .mnu-btn'); await P.sleep(60); return P.click('.mnu-pop:not([hidden]) [data-mact="' + act + '"]'); };
  const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
  const openCard = async (id) => { await P.click('#tg-' + id); await P.waitFor('!!document.querySelector("#sd-' + id + ' .sd-cmts .comments, #sd-' + id + ' .sd-cmts .err-box")'); };

  // 7. Move to Trash: one tap, toast with Undo + Add reason.
  await menu(C.cheese, 'trash'); await P.waitFor('/to Trash/.test(document.getElementById("toast").textContent)');
  check('B7 one tap trashes, toast offers Undo + Add reason', /Moved “Cheese-related” to Trash/.test(await P.toast()) && (await P.js('[...document.querySelectorAll("#toast .toast-btn")].map((b) => b.textContent).join()')) === 'Undo,Add reason');
  check('B7 gone from the database, Trash count 3', !(await has(C.cheese)) && /Trash 3/.test(await P.text('#cat-subtabs')));
  check('B7 database stamped who', (await db1('select status, trashed_by from submissions where id = $1', [C.cheese])).trashed_by === U.ADMIN);
  await P.clickText('#toast .toast-btn', 'Undo'); await P.waitFor('/Undone/.test(document.getElementById("toast").textContent)');
  check('B7 Undo restores', (await has(C.cheese)) && (await db1('select status from submissions where id = $1', [C.cheese])).status === 'new');
  await menu(C.cheese, 'trash'); await P.waitFor('/to Trash/.test(document.getElementById("toast").textContent)');
  await P.clickText('#toast .toast-btn', 'Add reason'); await P.waitFor('!!document.getElementById("why")');
  await P.click('.qr'); await P.submit('#why-form'); await P.waitFor('/Reason saved/.test(document.getElementById("toast").textContent)');
  check('B7 Add reason saves', (await db1('select trash_reason from submissions where id = $1', [C.cheese])).trash_reason === 'Duplicate of another category');

  // 8. Trash tab: same filters, who/when/why, Restore.
  await P.js('location.hash = "#/categories/trash"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Trash"'); await P.settle();
  check('B8 Trash lists trashed only', JSON.stringify((await P.names()).sort()) === JSON.stringify(['Cheese-related', 'Spare category', 'Things that are blue']), await P.names());
  check('B8 same filters as the database', (await P.count('#ms-btn')) === 1 && (await P.count('#filters [data-f="block"]')) > 5 && (await P.count('[data-seg="used"]')) === 4 && (await P.count('#filters .fsec')) >= 8 && (await P.count('#more-f')) === 0 && (await P.count('#views .view-tab')) >= 2 && (await P.count('#sug-q')) === 1);
  check('B8 note about shared Trash + auto-delete', /shared by every school/.test(await P.text('#trash-note')) && /Auto-delete is off/.test(await P.text('#trash-note')));
  check('B8 who, when, why', /Trashed by Marcus T\. · .+ — Not pathology/.test(await P.text(card(C.blue) + ' .attrib')) && /Trashed by Aisha K\..*No reason given/.test(await P.text(card(C.spare) + ' .attrib')));
  await P.type('#sug-q', 'pathology'); await P.sleep(400); await P.settle();
  check('B8 search finds the reason', JSON.stringify(await P.names()) === JSON.stringify(['Things that are blue']), await P.names());
  await P.type('#sug-q', ''); await P.sleep(400); await P.click('#ms-btn'); await P.click('#ms-c-rvsom'); await P.settle();
  check('B8 school filter in Trash', JSON.stringify(await P.names()) === JSON.stringify(['Cheese-related']) && /To RVSOM/.test(await P.text('#active-f')));
  await P.click('#af-clear'); await P.settle(); await P.click('#fsh-tby'); await P.sleep(50);
  await P.js('(() => { const s = document.getElementById("f-tby"); s.value = "' + U.OTHER + '"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.settle();
  check('B8 trashed-by filter', JSON.stringify(await P.names()) === JSON.stringify(['Spare category']) && /Trashed by Aisha K\./.test(await P.text('#active-f')));
  await P.click('#af-clear'); await P.settle();
  await P.click(card(C.cheese) + ' [data-restore]'); await P.waitFor('/Restored/.test(document.getElementById("toast").textContent)'); await P.settle();
  check('B8 Restore', !(await has(C.cheese)) && /Trash 2/.test(await P.text('#cat-subtabs')) && (await db1('select status from submissions where id = $1', [C.cheese])).status === 'new');
  await P.js('location.hash = "#/categories"'); await P.waitFor('document.querySelector("#ws-main h1").textContent === "Category database"'); await P.settle();

  // 9. Fix the original + edit history + Undo; disabled where not allowed.
  await menu(C.clubbing, 'fix'); await P.waitFor('!!document.querySelector(".fix-ed [data-fx=name]")');
  check('B9 editor opens in place, focused', (await P.js('document.activeElement.dataset.fx')) === 'name' && /Every school sees this fix/.test(await P.text('.fix-ed')));
  await P.type('.fix-ed [data-fx="name"]', 'Causes of digital clubbing'); await P.type('.fix-ed [data-fx="items.3.label"]', 'Crohn disease');
  await P.click('[data-act="fxsave"]'); await P.waitFor('/Saved 2 fixes/.test(document.getElementById("toast").textContent)'); await P.settle();
  await P.waitFor('document.querySelectorAll(".sd-edits li").length === 2');
  check('B9 saved through edit_submission', (await P.text('#tg-' + C.clubbing)) === 'Causes of digital clubbing' && (await db1('select count(*)::int n from submission_edits where submission_id = $1', [C.clubbing])).n === 2);
  check('B9 edit history lists both with Undo', (await P.count('.sd-edits [data-undo]')) === 2 && /changed the name/.test(await P.text('.sd-edits')));
  await P.js('[...document.querySelectorAll(".sd-edits li")].find((l) => /the name/.test(l.textContent)).querySelector("[data-undo]").click()');
  await P.waitFor('/Undone/.test(document.getElementById("toast").textContent)'); await P.waitFor('/undone by Marcus T\\./.test(document.querySelector(".sd-edits").textContent)');
  check('B9 Undo puts the name back', (await P.text('#tg-' + C.clubbing)) === 'Causes of clubbing' && (await db1('select group_name from submissions where id = $1', [C.clubbing])).group_name === 'Causes of clubbing');
  await P.click('#tg-' + C.clubbing); await P.sleep(150);
  await P.click(card(C.lead) + ' .mnu-btn'); await P.sleep(60);
  check('B9 Fix disabled for another school\'s original, with reason', (await P.attr('.mnu-pop:not([hidden]) [data-mact="fix"]', 'aria-disabled')) === 'true' && /Only RVSOM leads and admins/.test(await P.text('.mnu-pop:not([hidden]) [data-mact="fix"]')));
  check('B9 Hide for my school disabled', /Comes with multi-school/.test(await P.text('.mnu-pop:not([hidden]) [data-mact="hide"]')));
  await P.click('.mnu-pop:not([hidden]) [data-mact="fix"]'); await P.sleep(60);
  check('B9 disabled item explains itself', /Only RVSOM leads/.test(await P.toast()) && (await P.count('.fix-ed')) === 0);
  await P.key('Escape', 'Escape', 27);

  // 10. Comments: what I can read, icons, visibility toggle.
  await openCard(C.clubbing);
  const cm = await P.text('#sd-' + C.clubbing + ' .sd-cmts');
  check('B10 reads my school\'s + all-schools comments only', /CMSRU-only note/.test(cm) && /From RV: love this one/.test(cm) && !/RV private aside/.test(cm), cm);
  check('B10 icons on posted comments', /🔒 CMSRU only/.test(cm) && /🌐 All schools/.test(cm));
  check('B10 toggle defaults to My school only', (await P.attr('.vis-tog [data-v="school"]', 'aria-checked')) === 'true');
  await P.click('.vis-tog [data-v="all"]'); await P.type('.cm-in', 'For everyone'); await P.click('[data-cact="post"]');
  await P.waitFor('/for all schools/.test(document.getElementById("toast").textContent)'); await P.waitFor('/For everyone/.test(document.querySelector(".sd-cmts").textContent)');
  const row = await db1("select visibility, school from comments where body = 'For everyone'");
  check('B10 posted as all schools', row.visibility === 'all' && row.school === 'cmsru', row);
  await P.click('#tg-' + C.clubbing); await P.sleep(150);

  // 11. Votes: all admins vs my school.
  await P.click(card(C.hemoptysis) + ' .card-acts .vote-btn'); await P.waitFor('/👍 added/.test(document.getElementById("toast").textContent)'); await P.settle();
  const vtip = (id) => P.attr(card(id) + ' .card-acts .vote-btn', 'data-tip');
  check('B11 vote counted for my school', (await P.text(card(C.hemoptysis) + ' .card-acts .vote-btn')) === '👍 2' && /^You and 1 other · 1 from CMSRU/.test(await vtip(C.hemoptysis)) && (await db1('select school from votes where voter_email = $1 and submission_id = $2', [U.ADMIN, C.hemoptysis])).school === 'cmsru');
  await openCard(C.hemoptysis);
  check('B11 open card: one 👍, split in the tooltip', (await P.count(card(C.hemoptysis) + ' .vote-btn')) === 1 && (await vtip(C.hemoptysis)) === 'You and 1 other · 1 from CMSRU · 2 schools', await vtip(C.hemoptysis));
  // 12. Full usage table + drafts.
  const use = await P.text('#sd-' + C.hemoptysis + ' .sd-use');
  check('B12 usage table', (await P.count('#sd-' + C.hemoptysis + ' .use-tbl tbody tr')) === 2 && /Used 2× in published puzzles \(1 as-is, 1 adapted\)/.test(use) && /Adapted/.test(use) && /lungs-and-more-2026-10-01/.test(use), use);
  await P.click('#tg-' + C.hemoptysis); await P.sleep(100); await openCard(C.lead);
  check('B12 drafts list (mine only)', /In 1 draft: CMSRU next week \(CMSRU\)/.test(await P.text('#sd-' + C.lead + ' .sd-use')), await P.text('#sd-' + C.lead + ' .sd-use'));
  await P.click('#tg-' + C.lead); await P.sleep(100);
  await P.click('#fsh-vfrom'); await P.click('[data-seg="vfrom"][data-v="mine"]'); await P.settle();
  check('B11 Count 👍 from my school only', (await P.text(card(C.clubbing) + ' .card-acts .vote-btn')) === '👍 2');
  await P.click('[data-seg="vfrom"][data-v="all"]'); await P.settle();

  // 13. Add to draft: only my school's drafts (row rules), then usage updates.
  await P.click(card(C.asthma) + ' [data-addd]'); await P.waitFor('!!document.getElementById("use-form")');
  const dl = await P.text('#use-form .use-drafts');
  check('B13 draft list is RLS-filtered', /CMSRU next week/.test(dl) && !/RV private draft/.test(dl), dl);
  await P.submit('#use-form'); await P.waitFor('!!document.getElementById("ud-open")'); await P.settle();
  check('B13 added; usage line updates', /Added to CMSRU next week/.test(await P.toast()) && /In 1 draft/.test(await line(C.asthma)));
  check('B13 slot saved', (await db1('select count(*)::int n from draft_slots where draft_id = $1 and submission_id = $2', ['20000000-0000-4000-9000-000000000001', C.asthma])).n === 1);
  await P.key('Escape', 'Escape', 27); await P.sleep(100);

  // 14. Keyboard: / j k v a ? (off while typing).
  await P.js('document.activeElement.blur()'); await P.key('/', 'Slash', 191);
  check('B14 / focuses search', (await P.focused()) === 'sug-q');
  await P.key('j', 'KeyJ', 74); await P.sleep(50);
  check('B14 j while typing does nothing', (await P.count('.sug-card.kcur')) === 0);
  await P.type('#sug-q', ''); await P.sleep(350); await P.js('document.activeElement.blur()');
  await P.key('j', 'KeyJ', 74); await P.key('j', 'KeyJ', 74); await P.key('k', 'KeyK', 75);
  const first = await P.js('document.querySelector("#sug-list .sug-card").dataset.id');
  check('B14 j j k selects the first card', (await P.js('document.querySelector(".sug-card.kcur") && document.querySelector(".sug-card.kcur").dataset.id')) === first && (await P.js('document.activeElement.classList.contains("sug-toggle")')));
  const before = await P.text(card(first) + ' .card-acts .vote-btn');
  await P.key('v', 'KeyV', 86); await P.waitFor('/👍/.test(document.getElementById("toast").textContent)'); await P.settle();
  check('B14 v votes', (await P.text(card(first) + ' .card-acts .vote-btn')) !== before && (await P.count('.sug-card.kcur')) === 1);
  await P.key('a', 'KeyA', 65); await P.waitFor('!!document.getElementById("use-form")');
  check('B14 a opens Add to draft', (await P.count('#use-form')) === 1);
  await P.key('Escape', 'Escape', 27); await P.sleep(80);
  await P.key('?', 'Slash', 191, 8); await P.waitFor('!!document.querySelector("#modal-root .keys")');
  check('B14 ? shows the shortcuts', /Keyboard shortcuts/.test(await P.text('#modal-root')));
  await P.key('Escape', 'Escape', 27);
}
