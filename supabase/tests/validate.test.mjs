// node supabase/tests/validate.test.mjs
// Unit tests for supabase/functions/submit/validate.js, plus a consistency
// check: the same samples go through tools/import_submission.py
// check_submission(), and both must agree (same pass/fail, same messages for
// the rules they share). Exit 1 on any failure.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateSubmission, decodeImage, itemIds, receiptCode, LIMITS } from '../functions/submit/validate.js';
import { goodSample, goodSampleV2, goodPuzzleSample, PNG_1x1, WEBP_1x1, clone } from './samples.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// Each case: name, mutate(sample), expected message fragment, serverOnly (Python has no such limit)
const bigWebp = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(720 * 1024)]).toString('base64');
const cases = [
  ['wrong format', (s) => { s.format = 'other'; }, 'not a Desk Puzzle submission'],
  ['no consent', (s) => { s.consent = false; }, 'consent box was not ticked'],
  ['bad tier', (s) => { s.suggestedTier = 5; }, 'suggested difficulty should be 1-4, got 5'],
  ['named credit without name', (s) => { s.credit = { mode: 'named', name: '  ' }; }, 'asked for credit but gave no name'],
  ['credit name too long', (s) => { s.credit = { mode: 'named', name: 'x'.repeat(61) }; }, 'credit name is 61 characters (max 60)'],
  ['bad email', (s) => { s.contact = { email: 'not-an-email' }; }, 'contact email does not look like an email address'],
  ['no group name', (s) => { s.group.name = ''; }, 'the category has no name'],
  ['three clues', (s) => { s.group.items.pop(); }, 'expected 4 clues, found 3'],
  ['bad zone', (s) => { s.group.items[0].zone = 'desk'; }, "clue 1 has an unknown kind of piece 'desk'"],
  ['photo without title', (s) => { s.group.items[2].info.title = ''; }, 'clue 3 is a photograph and needs a title'],
  ['image on sticky note', (s) => { s.group.items[0].info.image = PNG_1x1; }, 'clue 1 is a sticky note (text only) but has an image'],
  ['image without source', (s) => { delete s.group.items[2].source; }, 'clue 3 has an image but no source note'],
  ['damaged image', (s) => { s.group.items[2].info.image = 'data:image/png;base64,iVBORw0KGgo@@'; }, 'clue 3 image is not an embedded image'],
  ['fake PNG bytes', (s) => { s.group.items[2].info.image = 'data:image/png;base64,' + Buffer.from('hello world, not a png').toString('base64'); }, 'clue 3 image cannot be opened as an image'],
  ['bad Anki id', (s) => { s.group.anki = { nids: [12, -3] }; }, 'Anki note ID -3 is not a positive whole number'],
  ['article image block', (s) => { s.group.article = [{ type: 'image', src: 'x.webp' }]; }, 'teaching note block 1 is an image'],
  ['puzzle in a version 1 file', (s) => { s.kind = 'puzzle'; }, 'whole puzzles need a version 2 file'],
  ['version 3', (s) => { s.version = 3; }, 'version is 3; this tool reads version 1 or 2'],
  ['GIF image', (s) => { s.group.items[2].info.image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; }, 'only WebP, PNG, and JPEG are accepted', true],
  ['oversize image', (s) => { s.group.items[2].info.image = bigWebp; }, 'clue 3 image is too big', true],
  ['explanation too long', (s) => { s.group.explanation = 'x'.repeat(LIMITS.explanation + 1); }, 'the explanation is 401 characters (max 400)', true],
];

// ── JS validator ──
const good = validateSubmission(goodSample());
ok(good.problems.length === 0, 'good sample passes' + (good.problems.length ? ': ' + good.problems.join(' | ') : ''));
ok(good.images.length === 3 && good.images.every((im) => im.bytes.length > 10), 'good sample yields 3 decoded images');
ok(validateSubmission(null).problems[0].includes('not a submission'), 'null is rejected');
const samples = [['good', goodSample(), null, false]];
for (const [name, mut, want, serverOnly] of cases) {
  const s = goodSample(); mut(s);
  const r = validateSubmission(s);
  ok(r.problems.some((m) => m.includes(want)), `rejects ${name} -> ${r.problems[0] || '(passed!)'}`);
  samples.push([name, s, want, !!serverOnly]);
}
// ── Version 2 category and full puzzle ──
// Each case: name, base sample maker, mutate, expected fragment, serverOnly
const v2cases = [
  ['v2 slide with info.image', goodSampleV2, (s) => { s.group.items[3].info.image = WEBP_1x1; }, 'clue 4 is a microscope slide, so its picture goes under the microscope (scope.image), not info.image'],
  ['v2 photo with a microscope image', goodSampleV2, (s) => { s.group.items[2].scope = { image: WEBP_1x1 }; }, 'clue 3 is a photograph; only microscope slides have a microscope image'],
  ['puzzle duplicate tiers', goodPuzzleSample, (s) => { s.puzzle.groups[1].tier = 3; }, 'each difficulty 1-4 must be used exactly once; got 3, 3, 4, 2'],
  ['puzzle bad tier', goodPuzzleSample, (s) => { s.puzzle.groups[0].tier = 0; }, 'category 1: difficulty should be 1-4, got 0'],
  ['puzzle missing tier', goodPuzzleSample, (s) => { delete s.puzzle.groups[3].tier; }, 'category 4: difficulty should be 1-4, got None'],
  ['puzzle with 3 categories', goodPuzzleSample, (s) => { s.puzzle.groups.pop(); }, 'expected 4 categories, found 3'],
  ['puzzle with 5 categories', goodPuzzleSample, (s) => { s.puzzle.groups.push(clone(s.puzzle.groups[0])); }, 'expected 4 categories, found 5'],
  ['puzzle category with 3 clues', goodPuzzleSample, (s) => { s.puzzle.groups[2].items.pop(); }, 'category 3: expected 4 clues, found 3'],
  ['puzzle category with 5 clues', goodPuzzleSample, (s) => { s.puzzle.groups[2].items.push(clone(s.puzzle.groups[2].items[0])); }, 'category 3: expected 4 clues, found 5'],
  ['puzzle no title', goodPuzzleSample, (s) => { s.puzzle.title = ' '; }, 'the puzzle has no title'],
  ['puzzle missing', goodPuzzleSample, (s) => { delete s.puzzle; }, 'the file has no puzzle in it'],
  ['puzzle slide with info.image', goodPuzzleSample, (s) => { s.puzzle.groups[1].items[3].info.image = PNG_1x1; }, 'category 2: clue 4 is a microscope slide, so its picture goes under the microscope'],
  ['puzzle image without source', goodPuzzleSample, (s) => { delete s.puzzle.groups[1].items[2].source; }, 'category 2: clue 3 has an image but no source note'],
  ['puzzle image on sticky note', goodPuzzleSample, (s) => { s.puzzle.groups[0].items[0].info.image = PNG_1x1; }, 'category 1: clue 1 is a sticky note (text only) but has an image'],
  ['puzzle no group name', goodPuzzleSample, (s) => { s.puzzle.groups[3].name = ''; }, 'category 4: the category has no name'],
  ['puzzle no consent', goodPuzzleSample, (s) => { s.consent = false; }, 'consent box was not ticked'],
  ['puzzle oversize image', goodPuzzleSample, (s) => { s.puzzle.groups[0].items[2].info.image = bigWebp; }, 'category 1: clue 3 image is too big', true],
  ['puzzle title too long', goodPuzzleSample, (s) => { s.puzzle.title = 'x'.repeat(LIMITS.puzzleTitle + 1); }, 'the puzzle title is 121 characters (max 120)', true],
];
const v2good = validateSubmission(goodSampleV2());
ok(v2good.problems.length === 0 && v2good.images.length === 2, 'v2 category sample passes with 2 images' + (v2good.problems.length ? ': ' + v2good.problems.join(' | ') : ''));
const v2noTitle = goodSampleV2(); v2noTitle.group.items.forEach((it) => { delete it.info.title; });
ok(validateSubmission(v2noTitle).problems.length === 0, 'v2 needs no separate title (photo/slide without info.title passes)');
const pzGood = validateSubmission(goodPuzzleSample());
ok(pzGood.problems.length === 0, 'puzzle sample passes' + (pzGood.problems.length ? ': ' + pzGood.problems.join(' | ') : ''));
ok(pzGood.images.length === 4 && pzGood.images.map((im) => im.group + ':' + im.item + ':' + im.field).join(',') === '0:2:info,0:3:scope,1:2:info,1:3:scope', 'puzzle images carry group, clue, and field');
samples.push(['v2 good', goodSampleV2(), null, false], ['puzzle good', goodPuzzleSample(), null, false]);
for (const [name, make, mut, want, serverOnly] of v2cases) {
  const s = make(); mut(s);
  const r = validateSubmission(s);
  ok(r.problems.some((m) => m.includes(want)), `rejects ${name} -> ${r.problems[0] || '(passed!)'}`);
  samples.push([name, s, want, !!serverOnly]);
}
const sixteen = goodPuzzleSample();
sixteen.puzzle.groups.forEach((g) => g.items.forEach((it, i) => {
  if (i % 2) { it.zone = 'rack'; it.scope = { image: WEBP_1x1 }; } else { it.zone = 'photo'; it.info.image = PNG_1x1; }
  it.source = 'own';
}));
const r16 = validateSubmission(sixteen);
ok(r16.problems.length === 0 && r16.images.length === 16, '16 images allowed in a full puzzle (one per clue)');
const many = goodSample();
many.group.items.forEach((it) => { it.zone = 'photo'; it.info.image = PNG_1x1; it.scope = { image: PNG_1x1 }; it.source = 'own'; });
ok(validateSubmission(many).problems.length === 0, 'v1 category keeps its old rules (photo with both images still accepted)');

const nine = goodSample();
nine.group.items.forEach((it) => { it.zone = 'rack'; it.info.title = 'T'; it.info.image = WEBP_1x1; it.scope = { image: WEBP_1x1 }; it.source = 'own'; });
ok(validateSubmission(nine).problems.length === 0, '8 images allowed (4 slides with card + scope image)');
ok(decodeImage(WEBP_1x1).ext === 'webp' && decodeImage(PNG_1x1).ext === 'png', 'decodeImage webp/png');
ok(JSON.stringify(itemIds([{ label: 'Blood smear' }, { label: 'Blood smear' }, { label: '!!' }, {}])) === '["blood-smear","blood-smear-2","clue","clue-2"]', 'itemIds dedupe like import_submission.py');
const code = receiptCode((n) => new Uint8Array(n).map((_, i) => i * 7));
ok(/^DP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), 'receipt format ' + code);

// ── Same samples through import_submission.py ──
const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
from import_submission import check_submission
out = []
for s in json.load(sys.stdin):
    problems, parsed = check_submission(s)
    out.append(problems)
print(json.dumps(out))
`;
const res = spawnSync('python3', ['-c', py], { input: JSON.stringify(samples.map((x) => x[1])), encoding: 'utf8', maxBuffer: 64 << 20 });
if (res.status !== 0) { ok(false, 'python import_submission.py ran: ' + res.stderr.slice(-400)); }
else {
  const pyOut = JSON.parse(res.stdout);
  samples.forEach(([name, s, want, serverOnly], i) => {
    const js = validateSubmission(s).problems;
    const pyP = pyOut[i];
    if (serverOnly) {
      ok(js.length > 0, `consistency ${name}: server-only limit (Python: ${pyP.length ? 'rejects too' : 'accepts'})`);
    } else {
      const same = js.length === pyP.length && js.every((m, k) => m === pyP[k]);
      ok(same, `consistency ${name}: JS and Python agree` + (same ? '' : `\n     JS: ${JSON.stringify(js)}\n     PY: ${JSON.stringify(pyP)}`));
    }
  });
}
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
