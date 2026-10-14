// Publisher dry run for an adapted slot: tools/publish_drafts.mjs reads the
// draft's slots (with draft_slots.adapted), builds the spec from the adapted
// copy, and downloads its pictures: one uploaded for this draft
// (drafts/<draft id>/...) and one on a clue swapped in from another category.
// A local stand-in answers the PostgREST and Storage calls; no network, no git,
// nothing written to the site. Run: node tools/publish_drafts_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DRAFT = { id: '30000000-0000-4000-9000-000000000001', title: 'Adapted week', school: 'cmsru', status: 'ready', target_release: '2026-10-22T10:00:00Z' };
const SID = (n) => '40000000-0000-4000-8000-00000000000' + n;
const RIFF = (tag) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.from(tag.padEnd(16, '.'))]);
const clue = (label, zone, img) => Object.assign({ label, zone, info: Object.assign({ title: label }, img && zone !== 'rack' ? { image: img } : {}) },
  img && zone === 'rack' ? { scope: { image: img } } : {}, img ? { source: 'own photo' } : {});
const cat = (n, name, extra) => ({ id: SID(n), kind: 'category', group_name: name, credit_mode: 'named', credit_name: 'John D.', credit_line: null,
  payload: { name, explanation: name + ' explained.', items: (extra || ['a', 'b', 'c', 'd'].map((x) => clue(name + ' ' + x, 'corkboard'))) } });
const subs = [
  cat(1, 'Causes of clubbing', [clue('Lung cancer', 'corkboard'), clue('Clubbed fingers', 'photo', SID(1) + '/clubbed-fingers-info.webp'), clue('IBD', 'corkboard'), clue('Bronchiectasis', 'corkboard')]),
  cat(2, 'Asthma triggers'), cat(3, 'Lead poisoning signs'),
  cat(4, 'Lung slides', [clue('Squamous cell', 'rack', SID(4) + '/squamous-scope.webp'), clue('b', 'corkboard'), clue('c', 'corkboard'), clue('d', 'corkboard')]),
  cat(5, 'Spare'),
];
// Tier 1 holds an adapted copy of "Causes of clubbing": new name, clue 2's
// picture replaced by an upload for this draft, clue 4 swapped for the slide
// from "Lung slides" (its picture lives under that category's folder).
const copy = JSON.parse(JSON.stringify(subs[0].payload));
copy.name = 'Clubbing, our cut'; copy.explanation = 'Tailored for this week.';
copy.items[1] = clue('Clubbed fingers', 'photo', 'drafts/' + DRAFT.id + '/clubbed-fingers-mo1.webp');
copy.items[3] = Object.assign(clue('Squamous cell', 'rack', SID(4) + '/squamous-scope.webp'), { swap: { sid: SID(4), name: 'Lung slides' } });
const slots = [
  { draft_id: DRAFT.id, tier: 1, submission_id: SID(1), group_index: null, custom_group: null, adapted: copy },
  { draft_id: DRAFT.id, tier: 2, submission_id: SID(2), group_index: null, custom_group: null, adapted: null },
  { draft_id: DRAFT.id, tier: 3, submission_id: SID(3), group_index: null, custom_group: null, adapted: null },
  { draft_id: DRAFT.id, tier: 4, submission_id: SID(5), group_index: null, custom_group: null, adapted: null },
];
const files = new Map([
  ['drafts/' + DRAFT.id + '/clubbed-fingers-mo1.webp', RIFF('replaced')],
  [SID(4) + '/squamous-scope.webp', RIFF('swapped')],
  [SID(1) + '/clubbed-fingers-info.webp', RIFF('original')],
]);
let noAdaptedColumn = false;
const asked = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  asked.push(req.method + ' ' + u.pathname + u.search);
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.apikey !== 'sb_secret_test') return json(401, { message: 'no key' });
  if (u.pathname === '/rest/v1/draft_slots') {
    const sel = u.searchParams.get('select') || '';
    if (sel.includes('adapted') && noAdaptedColumn) return json(400, { message: 'column draft_slots.adapted does not exist' });
    return json(200, slots.map((s) => (sel.includes('adapted') ? s : Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'adapted')))));
  }
  if (u.pathname === '/rest/v1/submissions') {
    const ids = /^in\.\((.*)\)$/.exec(u.searchParams.get('id') || '');
    return json(200, subs.filter((r) => ids && ids[1].split(',').includes(r.id)));
  }
  const m = /^\/storage\/v1\/object\/submissions\/(.+)$/.exec(u.pathname);
  if (m) {
    const p = m[1].split('/').map(decodeURIComponent).join('/');
    if (!files.has(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/webp' }); res.end(files.get(p)); return;
  }
  json(404, { message: 'unexpected ' + u.pathname });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.SUPABASE_URL = 'http://127.0.0.1:' + srv.address().port;
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
const { readDraft, fetchImages } = await import('./publish_drafts.mjs');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pubtest-'));
try {
  await t('reads the adapted copy from draft_slots.adapted and builds the spec from it', async () => {
    const { built, id } = await readDraft(DRAFT, 'now');
    assert.ok(asked.some((a) => a.startsWith('GET /rest/v1/draft_slots') && a.includes('adapted')));
    const g = built.spec.groups.find((x) => x.tier === 1);
    assert.equal(g.name, 'Clubbing, our cut'); assert.equal(g.explanation, 'Tailored for this week.');
    assert.deepEqual(g.items.map((x) => x.label), ['Lung cancer', 'Clubbed fingers', 'IBD', 'Squamous cell']);
    assert.equal(id, built.id);
    assert.deepEqual(built.problems, []);
  });
  await t('downloads the replaced picture (drafts/<draft id>/) and the swapped-in clue\'s picture, not the replaced original', async () => {
    const { built } = await readDraft(DRAFT, 'now');
    const dir = path.join(tmp, 'img1'); fs.mkdirSync(dir);
    const before = asked.length;
    await fetchImages(built, dir);
    const got = asked.slice(before).filter((a) => a.startsWith('GET /storage/'));
    assert.ok(got.some((a) => a.includes('/drafts/' + DRAFT.id + '/clubbed-fingers-mo1.webp')));
    assert.ok(got.some((a) => a.includes('/' + SID(4) + '/squamous-scope.webp')));
    assert.ok(!got.some((a) => a.includes('clubbed-fingers-info.webp')), 'the original picture the copy replaced is not fetched');
    const g = built.spec.groups.find((x) => x.tier === 1);
    const photo = g.items[1], slide = g.items[3];
    assert.equal(fs.readFileSync(path.join(dir, photo.image)).toString('latin1').includes('replaced'), true);
    assert.equal(fs.readFileSync(path.join(dir, slide.scope_image)).toString('latin1').includes('swapped'), true);
    assert.equal(fs.readdirSync(dir).length, 2);
  });
  await t('a missing upload stops the run with a plain message (nothing half-built)', async () => {
    const { built } = await readDraft(DRAFT, 'now');
    files.delete(SID(4) + '/squamous-scope.webp');
    const dir = path.join(tmp, 'img2'); fs.mkdirSync(dir);
    await assert.rejects(fetchImages(built, dir), /Could not download the picture/);
    files.set(SID(4) + '/squamous-scope.webp', RIFF('swapped'));
  });
  await t('before the multischool migration (no adapted column) it publishes the originals', async () => {
    noAdaptedColumn = true;
    const { built } = await readDraft(DRAFT, 'now');
    noAdaptedColumn = false;
    assert.equal(built.spec.groups.find((x) => x.tier === 1).name, 'Causes of clubbing');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  srv.close();
}
console.log(n + ' tests passed');
