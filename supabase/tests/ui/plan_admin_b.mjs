// Second half of plan_admin.e2e.mjs: the Adapted badge (original vs copy,
// Reset per change, Reset all), preview + export use the copy, slot ⋯,
// Remove with Undo, Publish now under ⋯, Needs a date, list sort, tips.
import { U, C, D } from './seed.mjs';

export async function runPart2({ P, check, sql, db1, slot, openDraft, toastHas, menu, libAdd, a }) {
  // ===== Preview and spec export use the copy =====
  const pz = await P.js(`(async () => { const pv = await import('/inbox/ws-plan-preview.js'), pd = await import('/inbox/ws-plan-data.js');
    const d = pd.draftById(${JSON.stringify(D.cmsru)}), p = await pv.puzzleOf(d), y = pv.specYaml(d);
    const g = p.groups.find((x) => x.tier === 1), items = p.items.filter((i) => g.itemIds.includes(i.id));
    return { name: g.name, labels: items.map((i) => i.label), zones: items.map((i) => i.zone), img: items[1].info.image || '', yaml: y }; })()`);
  check('V1 live preview draws the copy (name, swapped clue, new type)', pz.name === 'Clubbing, CMSRU cut' && pz.labels.join('|') === 'Lung cancer|Bronchiectasis|Tetralogy of Fallot|Cold air' && pz.zones[1] === 'photo', pz);
  check('V1 preview gets a signed link for the new image', pz.img.includes(encodeURIComponent(a.items[1].info.image)), pz.img.slice(-120));
  check('V2 spec export uses the copy and lists the draft image', /name: "Clubbing, CMSRU cut"/.test(pz.yaml) && /label: "Tetralogy of Fallot"/.test(pz.yaml) && /label: "Cold air"/.test(pz.yaml) &&
    new RegExp('image: "bronchiectasis-info\\.(webp|jpg)"  # in the inbox: drafts/' + D.cmsru).test(pz.yaml), pz.yaml.slice(0, 900));

  // ===== The badge: original vs copy, Reset one, Reset all =====
  await P.click(slot(1) + ' .adapt-badge'); await P.waitFor('!!document.getElementById("diff-1")');
  const diff = await P.text('#diff-1');
  check('B1 diff lists each change with original and copy', /Name/.test(diff) && /Causes of clubbing/.test(diff) && /Clue 2.*Original.*This puzzle/.test(diff) && /type Sticky note → Photo; new image/.test(diff) &&
    /swapped in ‘Cold air’ \(Sticky note\) from “Asthma triggers”/.test(diff) && (await P.count('#diff-1 [data-rv]')) === 4, diff);
  await P.click('#diff-1 [data-rv="1|c3"]'); await toastHas('/Clue 4 is back to the original/');
  let r = await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru]);
  check('B2 Reset one clue: the rest stays adapted', r.adapted && r.adapted.items[3].label === 'IBD' && !r.adapted.items[3].swap && r.adapted.items[2].label === 'Tetralogy of Fallot');
  check('B2 badge now 3 changes, panel still open', /^Adapted · 3 changes/.test(await P.text(slot(1) + ' .adapt-badge')) && (await P.count('#diff-1')) === 1);
  await P.click('#diff-1 [data-revert="1"]'); await toastHas('/Back to the original “Causes of clubbing”/');
  r = await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru]);
  check('B3 Reset all: no copy left, original name back', r.adapted === null && (await P.count(slot(1) + ' .adapt-badge')) === 0 && /Causes of clubbing/.test(await P.text(slot(1) + ' h4')));
  check('B3 history says it went back to the original', (await db1(`select count(*)::int n from public.review_events where submission_id = $1 and action = 'adapt' and note like 'went back%'`, [C.clubbing])).n === 1);
  // Edit again then Cancel: nothing saved.
  await P.click(slot(1) + ' [data-adapt]'); await P.waitFor('!!document.querySelector(".adapt-ed")');
  await P.type('.adapt-ed [data-adl="0"]', 'Something else'); await P.click('[data-adcancel="1"]'); await P.sleep(200);
  check('B4 Cancel keeps the original', (await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru])).adapted === null && (await P.count('.adapt-ed')) === 0);
  // Revert clue inside the editor.
  await P.click(slot(1) + ' [data-adapt]'); await P.waitFor('!!document.querySelector(".adapt-ed")');
  await P.type('.adapt-ed [data-adl="0"]', 'Changed'); await P.js('document.querySelector(".adapt-ed [data-adl=\\"0\\"]").blur()');
  await P.js('(() => { const s = document.querySelector(".adapt-ed [data-adz=\\"0\\"]"); s.value = "folder"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.sleep(100);
  check('B5 changed clue marked, Revert clue offered', (await P.count('.tw-clue[data-clue="0"].changed [data-adrv="0"]')) === 1);
  await P.click('[data-adrv="0"]'); await P.sleep(100);
  check('B5 Revert clue restores text and type', (await P.js('document.querySelector(".adapt-ed [data-adl=\\"0\\"]").value')) === 'Lung cancer' && (await P.js('document.querySelector(".adapt-ed [data-adz=\\"0\\"]").value')) === 'rack');
  await P.click('[data-adsave="1"]'); await toastHas('/No differences from the original/');
  check('B5 saving with no differences saves nothing', (await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru])).adapted === null);

  // A copy that turns a text clue into a photo without an image blocks publishing.
  await sql(`update public.draft_slots set adapted = jsonb_set((select payload from public.submissions where id = $2), '{items,2,zone}', '"photo"') where draft_id = $1 and tier = 1`, [D.cmsru, C.clubbing]);
  await P.click('#ed-refresh'); await P.waitFor('/needs an image/.test(document.getElementById("checks").textContent)');
  check('B6 image clue without an image (made by the copy) blocks', /“Causes of clubbing”: clue “Cyanotic heart disease” needs an image[^]*Blocks publishing/.test(await P.text('#checks')), await P.text('#checks'));
  await sql(`update public.draft_slots set adapted = null where draft_id = $1 and tier = 1`, [D.cmsru]);
  await P.click('#ed-refresh'); await P.waitFor('!/needs an image/.test(document.getElementById("checks").textContent)');

  // ===== Slot ⋯: Move…, Remove from draft with Undo =====
  await menu(slot(2), 'slotMove'); await P.waitFor('!!document.querySelector("[data-pick]")');
  await P.click('[data-pick="4"]'); await P.waitFor('!!document.querySelector("' + slot(4) + '.filled")');
  check('S1 Move… to Hardest', /hemoptysis/.test(await P.text(slot(4))) && !(await P.count(slot(2) + '.filled')), [await P.text('#slots'), await P.toast(), await P.text('#modal-root')]);
  await menu(slot(4), 'slotRm'); await toastHas('/Removed “Causes of hemoptysis” from Hardest/');
  check('S2 Remove from draft: slot empty, Undo offered', !(await P.count(slot(4) + '.filled')) && (await P.text('#toast .toast-btn')) === 'Undo');
  await P.click('#toast .toast-btn'); await toastHas('/Put back in Hardest/');
  await P.waitFor('!!document.querySelector("' + slot(4) + '.filled")');
  check('S2 Undo puts it back in the same tier', (await db1(`select submission_id from public.draft_slots where draft_id = $1 and tier = 4`, [D.cmsru])).submission_id === C.hemoptysis);
  await libAdd(C.imported, 2); await libAdd(C.cheese, 4); // no duplicate labels, so it can go Ready

  // ===== Ready, Needs a date, Publish now under ⋯ =====
  await P.click('#f-ready'); await toastHas('/Marked Ready/');
  check('R1 Ready without a date shows "Needs a date"', (await P.text('#f-nudge')) === 'Needs a date' && (await P.count('#flow .mnu-btn')) === 1 && !(await P.count('#f-pub')), [await P.text('#flow'), await P.text('#checks'), await P.toast(), await P.text('#slots')]);
  await menu('#flow', 'pubNow'); await P.waitFor('!!document.getElementById("pub-warn")');
  check('R2 Publish now warns exactly who and what it replaces', /^Goes live to all Cooper Medical School of Rowan University players immediately; replaces .+\.$/.test(await P.text('#pub-warn')), await P.text('#pub-warn'));
  await P.click('#pub-go'); await toastHas('/Queued/');
  check('R2 publish request saved', (await db1(`select kind, requested_by from public.publish_jobs where draft_id = $1`, [D.cmsru])).requested_by === U.ADMIN);

  // ===== Draft list: sort by date (undated last), title; tips =====
  await sql(`insert into public.drafts (title, status, owner_email, school, target_release) values ('Aaa dated later', 'planning', $1, 'cmsru', now() + interval '20 days'), ('Zzz dated soon', 'planning', $1, 'cmsru', now() + interval '3 days'), ('Mmm undated', 'planning', $1, 'cmsru', null)`, [U.ADMIN]);
  await P.js('location.hash = "#/planner"'); await P.waitFor('!!document.getElementById("draft-list")'); await P.click('#pl-refresh'); await P.sleep(600);
  const order = await P.js('[...document.querySelectorAll("#draft-list h3")].map((h) => h.textContent)');
  check('L1 release date order, undated last', order.indexOf('Zzz dated soon') < order.indexOf('Aaa dated later') && order.indexOf('Aaa dated later') < order.indexOf('Mmm undated'), order);
  check('L1 Ready draft card says "Needs a date"', /Needs a date/.test(await P.text('.draft-card[data-did="' + D.cmsru + '"]')));
  await P.js('(() => { const s = document.getElementById("dsort"); s.value = "title"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.sleep(150);
  check('L2 sort by title', (await P.js('document.querySelector("#draft-list h3").textContent')) === 'Aaa dated later');
  await openDraft(D.cmsru);
  check('T1 drag tip shows once', (await P.count('.tip[data-tip="plan-drag"]')) === 1);
  await P.click('[data-tipx="plan-drag"]'); await P.sleep(50);
  await P.js('location.hash = "#/planner"'); await P.sleep(400); await openDraft(D.cmsru);
  check('T1 dismissed tip stays dismissed', (await P.count('.tip[data-tip="plan-drag"]')) === 0);
  check('Z no console errors', P.errors.length === 0, P.errors);
}
