// Unit tests for inbox/ws-publish-spec.js (draft -> build spec). Run: node tools/publish_spec_test.mjs
// Needs python3 + PyYAML for the YAML round trip.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const S = await import(new URL('../inbox/ws-publish-spec.js', import.meta.url));
const { slugify, puzzleIdFor, releaseDate, imageRef, draftSpec, specToYaml } = S;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const clue = (label, zone, extra) => Object.assign({ label, zone, info: { title: label } }, extra || {});
const cat = (id, name, opts) => ({ id, kind: 'category', group_name: name, credit_mode: 'anonymous', credit_name: null, credit_line: null,
  payload: { name, explanation: name + ' explained.', items: [clue(name + ' a', 'corkboard'), clue(name + ' b', 'folder'), clue(name + ' c', 'rx'), clue(name + ' d', 'corkboard')] }, ...(opts || {}) });
const pgroup = (name, tier) => ({ name, tier, explanation: 'Why ' + name, items: [clue(name + ' 1', 'corkboard'), clue(name + ' 2', 'folder'), clue(name + ' 3', 'rx'), clue(name + ' 4', 'corkboard')] });
const full = { id: 'p1', kind: 'puzzle', group_name: 'Whole', credit_mode: 'named', credit_name: 'Marcus T.', credit_line: 'MS1',
  payload: { title: 'Whole', groups: [pgroup('W1', 1), pgroup('W2', 2), pgroup('W3', 3), pgroup('W4', 4)] } };
const draft = { id: 'd1', title: 'Fruit Findings', school: 'cmsru' };
const slot = (tier, sid, gi, cg) => ({ draft_id: 'd1', tier, submission_id: sid || null, group_index: gi == null ? null : gi, custom_group: cg || null });

t('slugify + id', () => {
  assert.equal(slugify('  Holes, Haze & Old Paint!! '), 'holes-haze-old-paint');
  assert.equal(puzzleIdFor('Starry Sky Society Puzzle', '2026-08-21'), 'starry-sky-society-2026-08-21');
  assert.equal(puzzleIdFor('Ünïcode only 😀', '2026-10-15'), 'n-code-only-2026-10-15');
  assert.equal(puzzleIdFor('???', '2026-10-15'), 'puzzle-2026-10-15');
  const long = puzzleIdFor('x'.repeat(130), '2026-10-15');
  assert.ok(long.length <= 120 && /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/.test(long));
});
t('ET dates across DST', () => {
  // EDT (UTC-4): 2026-10-15 03:30Z is Oct 14 11:30 PM ET; 10:00Z is Oct 15 6 AM ET
  assert.equal(releaseDate('scheduled', '2026-10-15T03:30:00Z'), '2026-10-14');
  assert.equal(releaseDate('scheduled', '2026-10-15T10:00:00Z'), '2026-10-15');
  // EST (UTC-5) after Nov 1 2026: 2026-11-05 04:30Z is Nov 4 11:30 PM ET; 05:00Z is midnight Nov 5
  assert.equal(releaseDate('scheduled', '2026-11-05T04:30:00Z'), '2026-11-04');
  assert.equal(releaseDate('scheduled', '2026-11-05T05:00:00Z'), '2026-11-05');
  // spring forward 2027-03-14: 06:59Z = 1:59 AM EST, 07:00Z = 3:00 AM EDT, same day
  assert.equal(releaseDate('scheduled', '2027-03-14T06:59:00Z'), '2027-03-14');
  assert.equal(releaseDate('scheduled', '2027-03-14T04:59:00Z'), '2027-03-13');
  // "now" ignores the scheduled date and uses today in ET
  assert.equal(releaseDate('now', '2026-12-31T12:00:00Z', Date.parse('2026-10-13T02:00:00Z')), '2026-10-12');
});
t('image refs', () => {
  assert.deepEqual(imageRef('abc-uuid/1-x-scope.webp'), { kind: 'storage', path: 'abc-uuid/1-x-scope.webp' });
  assert.deepEqual(imageRef('https://pathologyconnections.org/puzzles/a-2026-01-01/x-info.webp'), { kind: 'site', path: 'puzzles/a-2026-01-01/x-info.webp' });
  assert.equal(imageRef('https://example.com/cat.png').kind, 'url');
  assert.equal(imageRef('data:image/png;base64,AAAA').kind, 'data');
  assert.equal(imageRef(''), null);
});
t('category slots, credits, notes, images', () => {
  const a = cat('a', 'Pome fruit', { credit_mode: 'named', credit_name: 'John D.', credit_line: 'MS2' });
  a.payload.items[0] = clue('Apple core', 'photo', { info: { title: 'Apple core', image: 'a/x-info.jpg' }, source: 'Own photo', note: '  Seeds have amygdalin ' });
  a.payload.items[1] = clue('Pear slide', 'rack', { scope: { image: 'a/y-scope.png' } });
  const subs = new Map([['a', a], ['b', cat('b', 'Berries')], ['c', cat('c', 'Citrus')], ['e', cat('e', 'Stone fruit')]]);
  const r = draftSpec(draft, [slot(2, 'b'), slot(1, 'a'), slot(3, 'c'), slot(4, 'e')], subs, { date: '2026-10-15' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.id, 'fruit-findings-2026-10-15');
  assert.deepEqual(r.spec.groups.map((g) => g.tier), [1, 2, 3, 4]);
  const g1 = r.spec.groups[0];
  assert.deepEqual(g1.credit, { name: 'John D.', line: 'MS2' });
  assert.equal(r.spec.groups[1].credit, null);
  assert.equal(r.spec.credit, null);
  assert.equal(g1.items[0].note, 'Seeds have amygdalin');
  assert.equal(g1.items[0].image, 'apple-core-info.jpg');
  assert.equal(g1.items[0].source, 'Own photo');
  assert.equal(g1.items[1].scope_image, 'pear-slide-scope.png');
  assert.deepEqual(r.images.map((i) => [i.file, i.ref.kind]), [['apple-core-info.jpg', 'storage'], ['pear-slide-scope.png', 'storage']]);
});
t('full-puzzle groups -> puzzle credit only when all four come from it', () => {
  const subs = new Map([['p1', full], ['b', cat('b', 'Berries')]]);
  const all = draftSpec(draft, [slot(1, 'p1', 3), slot(2, 'p1', 0), slot(3, 'p1', 1), slot(4, 'p1', 2)], subs, { date: '2026-10-15' });
  assert.deepEqual(all.problems, []);
  assert.deepEqual(all.spec.credit, { name: 'Marcus T.', line: 'MS1' });
  assert.ok(all.spec.groups.every((g) => g.credit === null));
  assert.deepEqual(all.spec.groups.map((g) => g.name), ['W4', 'W1', 'W2', 'W3']); // slot tier wins over the group's own tier
  const mixed = draftSpec(draft, [slot(1, 'p1', 0), slot(2, 'p1', 1), slot(3, 'p1', 2), slot(4, 'b')], subs, { date: '2026-10-15' });
  assert.equal(mixed.spec.credit, null);
  assert.deepEqual(mixed.spec.groups.map((g) => g.credit && g.credit.name), ['Marcus T.', 'Marcus T.', 'Marcus T.', null]);
});
t('custom group slot (from the archive), duplicate ids', () => {
  const cg = { name: 'Berries', explanation: 'Reused.', credit: { name: 'John D.' }, anki: { nids: [123, -4, 'x'] }, article: [{ type: 'text', text: 'Hi' }, { type: 'image', text: 'no' }],
    items: [clue('Berries a', 'photo', { info: { title: 'Berries a', image: 'https://pathologyconnections.org/puzzles/old-2026-01-01/berries-a-info.webp' } }), clue('Berries b', 'folder'), clue('Berries c', 'rx'), clue('Berries d', 'corkboard')] };
  const subs = new Map([['b', cat('b', 'Berries')], ['c', cat('c', 'Citrus')], ['e', cat('e', 'Stone')]]);
  const r = draftSpec(draft, [slot(1, 'b'), slot(2, null, null, cg), slot(3, 'c'), slot(4, 'e')], subs, { date: '2026-10-15' });
  assert.deepEqual(r.problems, []);
  const g = r.spec.groups[1];
  assert.equal(g.id, 'g-berries-2');
  assert.deepEqual(g.credit, { name: 'John D.' });
  assert.deepEqual(g.anki, [123]);
  assert.deepEqual(g.article, [{ type: 'text', text: 'Hi' }]);
  assert.equal(g.items[0].id, 'berries-a-2');
  assert.deepEqual(r.images[0].ref, { kind: 'site', path: 'puzzles/old-2026-01-01/berries-a-info.webp' });
});
t('problems: empty slot, missing suggestion, short group, outside link', () => {
  const bad = cat('c', 'Citrus'); bad.payload.items.pop(); bad.payload.explanation = ' ';
  const ext = cat('x', 'Ext'); ext.payload.items[0] = clue('Far', 'photo', { info: { title: 'Far', image: 'https://example.com/a.png' } });
  const r = draftSpec(draft, [slot(1, 'gone'), slot(3, 'c'), slot(4, 'x')], new Map([['c', bad], ['x', ext]]), { date: '2026-10-15' });
  const p = r.problems.join(' ');
  assert.match(p, /Tier 1 \(Easy\): the suggestion in this slot is gone/);
  assert.match(p, /Tier 2 \(Medium\) is empty/);
  assert.match(p, /has no explanation/);
  assert.match(p, /3 clues instead of 4/);
  assert.match(p, /link to another website/);
});
t('YAML round trip (PyYAML) keeps every value', () => {
  const a = cat('a', 'Quotes "and" colons: yes'); a.payload.items[0] = clue('null', 'photo', { info: { title: 'null', image: 'a/1.webp' }, note: 'Line # not a comment', source: "O'Brien" });
  const subs = new Map([['a', a], ['b', cat('b', 'yes')], ['c', cat('c', '2026')], ['e', cat('e', 'Émigré ✓')]]);
  const r = draftSpec({ id: 'd1', title: 'True: False' }, [slot(1, 'a'), slot(2, 'b'), slot(3, 'c'), slot(4, 'e')], subs, { date: '2026-10-15' });
  const y = specToYaml(r.spec, { header: ['hello'], draftId: 'd1', imagesDir: '../x-src/' });
  assert.match(y, /^# hello\n# workspace-draft: d1\n/);
  const py = spawnSync('python3', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: y, encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const back = JSON.parse(py.stdout);
  assert.equal(back.title, 'True: False'); assert.equal(back.date, '2026-10-15'); assert.equal(back.id, r.id); assert.equal(back.images, '../x-src/');
  assert.equal(back.groups[0].name, 'Quotes "and" colons: yes'); assert.equal(back.groups[1].name, 'yes'); assert.equal(back.groups[2].name, '2026');
  assert.equal(back.groups[3].name, 'Émigré ✓');
  const it = back.groups[0].items[0];
  assert.equal(it.id, 'null'); assert.equal(it.label, 'null'); assert.equal(it.note, 'Line # not a comment'); assert.equal(it.source, "O'Brien"); assert.equal(it.image, 'null-info.webp');
  assert.equal(back.groups[0].tier, 1);
});
t('adapted copy (S3 "Edit for this puzzle") replaces name, explanation and clues; image from drafts/', () => {
  const subs = { a: cat('a', 'Alpha'), b: cat('b', 'Beta'), c: cat('c', 'Gamma'), e: cat('e', 'Delta') };
  const copy = JSON.parse(JSON.stringify(subs.a.payload));
  copy.name = 'Alpha, our cut'; copy.explanation = 'Tailored.'; copy.items[1] = clue('New photo', 'photo', { info: { title: 'New photo', image: 'drafts/d1/new-photo-x.webp' } });
  copy.items[3] = clue('Swapped in', 'corkboard', { swap: { sid: 'b', name: 'Beta' } });
  const rows = [Object.assign(slot(1, 'a'), { adapted: copy }), slot(2, 'b'), slot(3, 'c'), slot(4, 'e')];
  const r = draftSpec(draft, rows, subs, { date: '2026-10-22' });
  const g = r.spec.groups.find((x) => x.tier === 1);
  assert.equal(g.name, 'Alpha, our cut'); assert.equal(g.explanation, 'Tailored.');
  assert.deepEqual(g.items.map((x) => x.label), ['Alpha a', 'New photo', 'Alpha c', 'Swapped in']);
  assert.ok(r.images.some((im) => im.ref.kind === 'storage' && im.ref.path === 'drafts/d1/new-photo-x.webp' && im.tier === 1));
  assert.deepEqual(r.problems, []);
  assert.equal(subs.a.payload.name, 'Alpha'); // the original is untouched
  const plain = draftSpec(draft, [slot(1, 'a'), slot(2, 'b'), slot(3, 'c'), slot(4, 'e')], subs, { date: '2026-10-22' });
  assert.equal(plain.spec.groups[0].name, 'Alpha');
});
t('adapted copy with a swapped-in clue that has its own picture (from another category)', () => {
  const subs = { a: cat('a', 'Alpha'), b: cat('b', 'Beta'), c: cat('c', 'Gamma'), e: cat('e', 'Delta') };
  const copy = JSON.parse(JSON.stringify(subs.a.payload));
  copy.items[0] = clue('Slide from Beta', 'rack', { scope: { image: 'b/slide-scope.webp' }, swap: { sid: 'b', name: 'Beta' }, source: 'own' });
  copy.items[2] = clue('Replaced photo', 'photo', { info: { title: 'Replaced photo', image: 'drafts/d1/replaced.webp' }, source: 'own' });
  const r = draftSpec(draft, [Object.assign(slot(1, 'a'), { adapted: copy }), slot(2, 'b'), slot(3, 'c'), slot(4, 'e')], subs, { date: '2026-10-22' });
  const paths = r.images.filter((im) => im.tier === 1).map((im) => im.ref.kind + ':' + im.ref.path).sort();
  assert.deepEqual(paths, ['storage:b/slide-scope.webp', 'storage:drafts/d1/replaced.webp']);
  const g = r.spec.groups.find((x) => x.tier === 1);
  assert.equal(g.items[0].scope_image, 'slide-from-beta-scope.webp');
  assert.ok(!('swap' in g.items[0]), 'the swap note is workspace-only, not in the spec');
  assert.deepEqual(r.problems, []);
});
console.log(n + ' tests passed');
