// node supabase/tests/studio_limits.test.mjs
// The Studio warns about sizes before sending (SEND_LIMITS in studio/index.html);
// the server enforces LIMITS in supabase/functions/submit/validate.js. This
// checks the two lists agree so students never pass the Studio and fail the server.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../functions/submit/validate.js';

const html = fs.readFileSync(fileURLToPath(new URL('../../studio/index.html', import.meta.url)), 'utf8');
const m = /const SEND_LIMITS = (\{[^}]*\});/.exec(html);
let fails = 0;
if (!m) { console.log('FAIL SEND_LIMITS not found in studio/index.html'); process.exit(1); }
const studio = Function('return ' + m[1])();
// The Studio must know every cap it checks before sending (categories only:
// the full-puzzle caps stay on the server for old files, not in the Studio).
for (const k of ['maxImageBytes', 'maxImages', 'maxBodyBytes', 'name', 'explanation', 'label', 'source', 'article', 'note']) {
  const has = k in studio;
  console.log((has ? 'PASS ' : 'FAIL ') + `studio SEND_LIMITS has ${k}`);
  if (!has) fails++;
}
// Pinned values from supabase/SUBMISSION_FORMAT.md (a change here is a contract change).
for (const [k, v] of Object.entries({ maxPuzzleImages: 16, maxPuzzleBodyBytes: 9437184, puzzleTitle: 120, maxImages: 8, maxBodyBytes: 7340032, note: 280 })) {
  const same = LIMITS[k] === v;
  console.log((same ? 'PASS ' : 'FAIL ') + `contract ${k} = ${v} (server ${LIMITS[k]})`);
  if (!same) fails++;
}
for (const [k, v] of Object.entries(studio)) {
  const same = LIMITS[k] === v;
  console.log((same ? 'PASS ' : 'FAIL ') + `${k}: studio ${v}, server ${LIMITS[k]}`);
  if (!same) fails++;
}
for (const k of ['maxPuzzleImages', 'maxPuzzleBodyBytes', 'puzzleTitle']) {
  const gone = !(k in studio);
  console.log((gone ? 'PASS ' : 'FAIL ') + `studio has no full-puzzle cap ${k} (full puzzles retired)`);
  if (!gone) fails++;
}
// Full-puzzle mode is gone from the Studio, and every send carries the school.
const checksStudio = [
  [!/data-mode="puzzle"|id="mode-puzzle"|submissionFromPuzzle|puzzleChecks/.test(html), 'no full-puzzle mode, checks, or sender left in the Studio'],
  [/kind: 'category', school: t\(c\.school\)/.test(html), 'the Studio sends kind "category" with the school'],
  [/\/rest\/v1\/rpc\/active_schools/.test(html), 'the Studio reads the school list from active_schools()'],
  [/problems\.push\('Pick your school'\)/.test(html), 'the Studio asks for a school before sending'],
];
for (const [c, m] of checksStudio) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const credit = /const CREDIT_NAME_MAX = (\d+), CREDIT_LINE_MAX = (\d+);/.exec(html);
const cOk = credit && Number(credit[1]) === LIMITS.creditName && Number(credit[2]) === LIMITS.creditLine;
console.log((cOk ? 'PASS ' : 'FAIL ') + 'credit name/line caps match');
if (!cOk) fails++;
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
