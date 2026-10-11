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
for (const [k, v] of Object.entries(studio)) {
  const same = LIMITS[k] === v;
  console.log((same ? 'PASS ' : 'FAIL ') + `${k}: studio ${v}, server ${LIMITS[k]}`);
  if (!same) fails++;
}
const credit = /const CREDIT_NAME_MAX = (\d+), CREDIT_LINE_MAX = (\d+);/.exec(html);
const cOk = credit && Number(credit[1]) === LIMITS.creditName && Number(credit[2]) === LIMITS.creditLine;
console.log((cOk ? 'PASS ' : 'FAIL ') + 'credit name/line caps match');
if (!cOk) fails++;
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
