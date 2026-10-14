// node supabase/tests/ui/orphans.e2e.mjs  (needs pg_server.mjs running)
// Orphan uploads in "Edit for this puzzle": a picture uploaded during an edit
// that is cancelled is deleted again; when two pictures are uploaded for the
// same clue and the copy is saved, only the one the copy uses stays; saved
// pictures survive a later cancelled edit. Storage only lets people delete
// their own uploads.
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';

await resetDb();
const P = await page();
const db1 = async (q, p) => ((await sql(q, p)).rows || [])[0] || {};
const slot = "#slots .slot[data-t='1']";
const toastHas = (re) => P.waitFor(re + '.test(document.getElementById("toast").textContent)', 8000);
const objs = async () => ((await sql(`select name from storage.objects where name like $1 order by created_at, name`, ['drafts/' + D.cmsru + '/%'])).rows || []).map((r) => r.name);
const uploads = () => P.js('(window.__mockState.uploads || []).map((u) => u.path)');
const openEdit = async () => { await P.click(slot + ' [data-adapt]'); const ok = await P.waitFor('!!document.querySelector(".adapt-ed")'); await P.sleep(300); return ok; };
const upload = async (color) => {
  await P.waitFor('!document.querySelector(".modal")', 4000); await P.sleep(300);
  await P.js('(() => { const t = document.getElementById("toast"); t.hidden = true; t.textContent = ""; })()');
  await P.click('.ad-clue[data-clue="1"] [data-adimg]'); if (!(await P.waitFor('!!document.getElementById("ip-file")', 4000))) return false;
  await P.js(`(async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '${color}'; x.fillRect(0, 0, 320, 200);
    const b = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([b], 'pic.png', { type: 'image/png' }));
    const i = document.getElementById('ip-file'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await P.waitFor('!!document.getElementById("cr-canvas")'); await P.click('#cr-ok');
  return toastHas('/New image ready/');
};
const toPhoto = async () => {
  await P.js('(() => { const s = document.querySelector(".adapt-ed [data-adz=\\"1\\"]"); s.value = "photo"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await P.sleep(150);
};

check('U0 admin signs in', await P.signInAs(U.ADMIN)); await P.settle();
await sql(`insert into public.draft_slots (draft_id, tier, submission_id) values ($1, 1, $2)`, [D.cmsru, C.clubbing]);
await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("' + slot + '.filled")');

// 1. Upload, then Cancel: the picture is deleted again.
check('U1 editor opens', await openEdit());
await toPhoto();
check('U1 picture uploaded', await upload('#c33') && (await objs()).length === 1);
const first = (await uploads())[0];
await P.click('[data-adcancel="1"]'); await P.sleep(400);
check('U1 cancelled edit: picture deleted', (await objs()).length === 0 && (await P.js('window.__mockState.removed || []')).includes(first));
check('U1 slot keeps no copy', (await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru])).adapted == null);

// 2. Two uploads for the same clue, then Save: only the used one stays.
await openEdit(); await toPhoto();
await upload('#3a3'); await upload('#33c');
const [a, b] = (await uploads()).slice(-2);
check('U2 two pictures uploaded', a !== b && (await objs()).length === 2);
await P.click('[data-adsave="1"]'); await toastHas('/Saved for this puzzle only/'); await P.sleep(400);
const saved = (await db1(`select adapted from public.draft_slots where draft_id = $1 and tier = 1`, [D.cmsru])).adapted || {};
const used = saved.items && saved.items[1] && saved.items[1].info && saved.items[1].info.image;
check('U2 saved copy uses the second picture', used === b, used);
check('U2 superseded picture deleted, used one kept', JSON.stringify(await objs()) === JSON.stringify([b]), await objs());

// 3. A later edit that uploads and is cancelled leaves the saved picture alone.
await openEdit(); await upload('#999');
const c = (await uploads()).slice(-1)[0];
await P.click('[data-adcancel="1"]'); await P.sleep(400);
check('U3 cancelled again: new one gone, saved one kept', JSON.stringify(await objs()) === JSON.stringify([b]) && c !== b, await objs());

// 4. Storage rules: someone else cannot delete it; the uploader could.
const other = await sql(`delete from storage.objects where name = $1 returning name`, [b], U.LEAD);
check('U4 another person cannot delete the upload', ((other.rows || []).length === 0) && (await objs()).length === 1, other);
check('U5 no console errors', P.errors.length === 0, P.errors);
P.close();
process.exit(summary() ? 1 : 0);
