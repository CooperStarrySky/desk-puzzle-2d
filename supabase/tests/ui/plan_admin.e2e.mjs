// node supabase/tests/ui/plan_admin.e2e.mjs  (needs pg_server.mjs running)
// Planner as a CMSRU admin: library "Add to draft…" (tap a tier), the checks
// (Trash, already used), "Edit for this puzzle" per clue (text, type, new
// image with crop + upload, swap from another category), the Adapted badge
// with Reset per change and Reset all, preview + spec export using the copy,
// slot ⋯ (Move…, Remove with Undo), Publish now under ⋯ with its specific
// warning, "Needs a date", draft list sort, one-time tip.
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';
import { runPart2 } from './plan_admin_b.mjs';

await resetDb();
const P = await page();
const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
const slot = (t) => "#slots .slot[data-t='" + t + "']";
const openDraft = async (id) => { await P.js('location.hash = "#/planner/' + id + '"'); return P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#ck-panel .ck-head")'); };
const toastHas = (re) => P.waitFor(re + '.test(document.getElementById("toast").textContent)', 8000);
// Opens a ⋯ menu and picks an item (after any redraw in flight has settled).
const menu = async (sel, act) => {
  await P.sleep(400); await P.click(sel + ' .mnu-btn');
  await P.waitFor('!!document.querySelector(".mnu-pop:not([hidden]) [data-mact=\'' + act + '\']")', 3000);
  return P.click('.mnu-pop:not([hidden]) [data-mact="' + act + '"]');
};
const libAdd = async (sid, t) => {
  await P.click('#lib-list .lib-card[data-key="' + sid + '"] [data-view]'); await P.waitFor('!!document.getElementById("view-add")'); await P.click('#view-add'); await P.waitFor('!!document.querySelector("[data-pick]")');
  await P.js('document.getElementById("toast").hidden = true');
  await P.click('[data-pick="' + t + '"]'); await P.waitFor('/^(Placed|Replaced|Moved|Swapped)/.test(document.getElementById("toast").textContent) && !document.getElementById("toast").hidden', 8000);
  await P.sleep(300); return P.waitFor('!!document.querySelector("' + slot(t) + '.filled")');
};

check('A0 admin signs in', await P.signInAs(U.ADMIN)); await P.settle();
await P.js('location.hash = "#/planner"'); await P.waitFor('!!document.getElementById("draft-list")');
check('A1 privacy note names the school', /Only Cooper Medical School of Rowan University can see these drafts/.test(await P.text('#priv-note')));
check('A1 own draft only (no RV draft)', /CMSRU next week/.test(await P.text('#draft-list')) && !/RV private draft/.test(await P.text('#ws-main')));
check('A1 sort control, release date first', (await P.attr('#dsort', 'id')) === 'dsort' && (await P.js('document.getElementById("dsort").value')) === 'date');

check('A2 draft opens', await openDraft(D.cmsru));
check('A2 rail card has no add button; 👁 View is the way in', (await P.count('#lib-list [data-add]')) === 0 && (await P.count('#lib-list .lib-card[data-key="' + C.clubbing + '"] .lc-view')) === 1);
check('A2 library cards have grab handles (desktop)', (await P.count('#lib-list .lib-card .grip')) > 0 && (await P.attr('#lib-list .lib-card', 'draggable')) === 'true');
check('A2 trashed categories are not in the library', (await P.count('#lib-list .lib-card[data-key="' + C.blue + '"]')) === 0);
check('A3 tap a tier: clubbing → Easy', await libAdd(C.clubbing, 1));
check('A3 hemoptysis → Medium', await libAdd(C.hemoptysis, 2));
check('A3 slot has one main action + ⋯ menu', (await P.text(slot(1) + ' [data-adapt]')) === '✎ Edit for this puzzle' && (await P.count(slot(1) + ' .mnu-btn')) === 1);
await P.click(slot(1) + ' .mnu-btn'); await P.sleep(80);
check('A3 ⋯ = Move…, Details, Remove from draft', (await P.js('[...document.querySelectorAll(".mnu-pop:not([hidden]) .mnu-i")].map((x) => x.textContent).join("|")')) === 'Move…|Details|Remove from draft');
await P.key('Escape', 'Escape', 27);
const ck = await P.text('#checks');
check('A4 already-used warning (any school)', /“Causes of hemoptysis” was already used: Cooper Medical School of Rowan University on .*Rowan-Virtua SOM on .*\(adapted\)/.test(ck), ck);
await sql(`update public.submissions set status = 'trashed', trashed_by = $2, trashed_at = now() where id = $1`, [C.clubbing, U.LEAD]);
await P.click('#ed-refresh'); await P.waitFor('/in Trash/.test(document.getElementById("checks").textContent)');
check('A4 Trash warning on a slot', /“Causes of clubbing”: this category is in Trash/.test(await P.text('#checks')));
check('A4 existing checks still there (empty slot blocks)', /The Hardest slot is empty/.test(await P.text('#checks')));
await sql(`update public.submissions set status = 'new', trashed_by = null, trashed_at = null where id = $1`, [C.clubbing]);
await P.click('#ed-refresh'); await P.waitFor('!/in Trash/.test(document.getElementById("checks").textContent)');

// ===== Edit for this puzzle =====
await P.click(slot(1) + ' [data-adapt]'); await P.waitFor('!!document.querySelector(".adapt-ed")');
check('E1 editor opens in the slot, original untouched note', /original “Causes of clubbing” in the Category database is untouched/.test(await P.text('.adapt-ed')) && (await P.count('.ad-clue')) === 4);
await P.type('.adapt-ed [data-adl="2"]', 'Tetralogy of Fallot');
await P.js('(() => { const s = document.querySelector(".adapt-ed [data-adz=\\"1\\"]"); s.value = "photo"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.sleep(150);
check('E2 type change → Photo needs an image', /Needs an image/.test(await P.text('.ad-clue[data-clue="1"]')) && (await P.count('.ad-clue[data-clue="1"] [data-adimg]')) === 1);
await P.click('.ad-clue[data-clue="1"] [data-adimg]'); await P.waitFor('!!document.getElementById("ip-file")');
await P.js(`(async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 320, 200);
  const b = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([b], 'nail.png', { type: 'image/png' }));
  const i = document.getElementById('ip-file'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
check('E3 crop window opens with the piece shape', await P.waitFor('!!document.getElementById("cr-canvas")') && /Photograph/.test(await P.text('.crop-modal')));
await P.click('#cr-ok'); await toastHas('/New image ready/');
const up = await P.js('window.__mockState.uploads || []');
check('E3 upload goes to drafts/<draft id>/ as WebP', up.length === 1 && up[0].path.startsWith('drafts/' + D.cmsru + '/') && /\.(webp|jpg)$/.test(up[0].path), up);
check('E3 stored through the row rules', (await db1(`select count(*)::int n from storage.objects where name = $1`, [up[0] && up[0].path])).n === 1);
check('E3 editor shows the new image', /Image: new for this puzzle/.test(await P.text('.ad-clue[data-clue="1"]')));
await P.click('.ad-clue[data-clue="3"] [data-adsw]'); await P.waitFor('!!document.getElementById("sw-q")');
await P.type('#sw-q', 'asthma'); await P.sleep(150);
check('E4 swap search finds other categories, not this one', /Asthma triggers/.test(await P.text('#sw-list')) && !/Causes of clubbing/.test(await P.text('#sw-list')));
await P.clickText('#sw-list [data-pk]', 'Cold air'); await toastHas('/Clue 4 swapped/');
check('E4 swapped clue shown with its source', /Swapped in from “Asthma triggers”/.test(await P.text('.ad-clue[data-clue="3"]')) && (await P.js('document.querySelector(".adapt-ed [data-adl=\\"3\\"]").value')) === 'Cold air');
await P.type('.adapt-ed [data-ad="name"]', 'Clubbing, CMSRU cut');
await P.click('[data-adsave="1"]'); await toastHas('/Saved for this puzzle only \\(4 changes\\)/');
const row = await db1(`select adapted, submission_id from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru]);
const a = row.adapted || {};
check('E5 saved copy: name, text, type+image, swap', a.name === 'Clubbing, CMSRU cut' && a.items[2].label === 'Tetralogy of Fallot' && a.items[1].zone === 'photo' &&
  String(a.items[1].info.image).startsWith('drafts/' + D.cmsru + '/') && a.items[3].label === 'Cold air' && a.items[3].swap && a.items[3].swap.sid === C.asthma && row.submission_id === C.clubbing, a);
check('E5 original untouched', (await db1(`select payload->>'name' n, group_name g from public.submissions where id = $1`, [C.clubbing])).g === 'Causes of clubbing');
check('E5 badge "Adapted · 4 changes"', /^Adapted · 4 changes/.test(await P.text(slot(1) + ' .adapt-badge')) && /Clubbing, CMSRU cut/.test(await P.text(slot(1) + ' h4')));
check('E5 "adapt" history line, private to CMSRU', (await db1(`select count(*)::int n from public.review_events where submission_id = $1 and action = 'adapt' and school = 'cmsru'`, [C.clubbing])).n === 1);

await runPart2({ P, check, sql, db1, slot, openDraft, toastHas, menu, libAdd, a });
P.close();
process.exit(summary());
