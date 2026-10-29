// node supabase/tests/record_attempts.test.mjs
// The optional guess detail on 'finish' (attempts, solveOrder, revealedGroup,
// hintAfter): valid, malformed, oversized and old-client payloads. Fake DB, no network.
import { createHandler, cleanAttempts, cleanSolveOrder, cleanHintAfter, MAX_BODY_BYTES } from '../functions/record/handler.js';

let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const ORIGIN = 'https://pathologyconnections.org';
const NOW = new Date('2026-10-30T15:00:00Z');
const PID = 'cases-2026-10-30';
let n = 0;
const anon = () => '3f1c2b4a-9d8e-4f00-a1b2-' + String(++n).padStart(12, '0');

function fakeDb(opts = {}) {
  const st = { record_rate: [], submit_rate: [], plays: [] };
  const from = (name) => {
    const api = {
      select() { return api; }, delete() { return api; }, eq() { return api; }, gte() { return api; }, lt() { return api; },
      insert(row) {
        if (name === 'plays' && opts.checkFail && row.attempts !== null) return Promise.resolve({ error: { code: '23514', message: 'check' } });
        st[name].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      },
      then(res, rej) { return Promise.resolve({ count: 0, data: null, error: null }).then(res, rej); },
    };
    return api;
  };
  return { st, from };
}
const setup = (dbOpts) => { const db = fakeDb(dbOpts); return { db, handle: createHandler({ supabase: db, now: () => NOW }) }; };
const post = (body) => new Request('https://x.supabase.co/functions/v1/record', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
});
const G = (ids, ok, oa = false) => ({ i: ids, ok, one_away: oa });
const A1 = ['aspirin', 'exercise', 'air-pollution', 'influenza-virus'];
const A2 = ['cana2edta', 'blue-gray-gum-line', 'blood-smear', 'neurodevelopmental-delay'];
const A3 = ['chest-ct', 'wet-mount', 'chest-x-ray', 'goodpasture-syndrome'];
const A4 = ['brain-mri', 'candidiasis', 'caseous-necrosis', 'emphysematous-lung'];
const WRONG = ['aspirin', 'exercise', 'air-pollution', 'chest-ct'];
const ORDER = ['g-asthma-triggers', 'g-lead-poisoning', 'g-hemoptysis', 'g-cheese'];
const good = (o = {}) => Object.assign({
  event: 'finish', puzzleId: PID, anonId: anon(), outcome: 'won', mistakes: 1, guesses: 5,
  hints: { labels: false, seeds: true, category: true }, casual: false,
  attempts: [G(WRONG, false, true), G(A1, true), G(A2, true), G(A3, true), G(A4, true)],
  solveOrder: ORDER, revealedGroup: 'g-cheese', hintAfter: { labels: null, seeds: 0, category: 2 },
}, o);
async function send(body, dbOpts) {
  const { db, handle } = setup(dbOpts);
  const r = await handle(post(body));
  return { status: r.status, row: db.st.plays[0], db };
}

// ── Valid ──
{
  const { status, row } = await send(good());
  ok(status === 200, 'full payload -> 200');
  ok(row.attempts.length === 5 && row.attempts[0].one_away === true && row.attempts[1].ok === true &&
    JSON.stringify(row.attempts[2]) === JSON.stringify({ i: A2, ok: true, one_away: false }), 'attempts stored in order with i/ok/one_away');
  ok(JSON.stringify(row.solve_order) === JSON.stringify(ORDER), 'solve_order stored');
  ok(row.revealed_group === 'g-cheese', 'revealed_group stored');
  ok(JSON.stringify(row.hint_after) === '[null,0,2]', 'hint_after stored as [labels, seeds, category]');
  const lost = await send(good({ outcome: 'lost', mistakes: 4, guesses: 5, attempts: [G(WRONG, false), G(WRONG.slice().reverse(), false), G(A1, true), G(['a', 'b', 'c', 'd'], false), G(['a', 'b', 'c', 'e'], false)],
    solveOrder: ['g-asthma-triggers'], hints: { labels: false, seeds: false, category: false }, revealedGroup: null, hintAfter: { labels: null, seeds: null, category: null } }));
  ok(lost.status === 200 && lost.row.attempts.length === 5 && lost.row.solve_order.length === 1, 'lost game with 1 solve stored');
  ok(lost.row.revealed_group === null && lost.row.hint_after === null, 'no hints -> revealed_group and hint_after null');
}
// ── Old client ──
{
  const b = good(); delete b.attempts; delete b.solveOrder; delete b.revealedGroup; delete b.hintAfter;
  const { status, row } = await send(b);
  ok(status === 200 && row && row.attempts === null && row.solve_order === null && row.revealed_group === null && row.hint_after === null,
    'old client without the new fields -> 200, detail null');
}
// ── Malformed: field dropped, play kept ──
{
  const cases = [
    ['attempts not array', { attempts: 'x' }, 'attempts'],
    ['attempts empty', { attempts: [] }, 'attempts'],
    ['guess with 3 ids', { attempts: [G(A1.slice(0, 3), true)] }, 'attempts'],
    ['guess with 5 ids', { attempts: [G(A1.concat('x'), true)] }, 'attempts'],
    ['duplicate id in a guess', { attempts: [G(['a', 'a', 'b', 'c'], false)] }, 'attempts'],
    ['upper-case id', { attempts: [G(['A', 'b', 'c', 'd'], false)] }, 'attempts'],
    ['id with space', { attempts: [G(['a b', 'b', 'c', 'd'], false)] }, 'attempts'],
    ['id too long', { attempts: [G(['x'.repeat(97), 'b', 'c', 'd'], false)] }, 'attempts'],
    ['id not string', { attempts: [G([1, 'b', 'c', 'd'], false)] }, 'attempts'],
    ['ok not boolean', { attempts: [{ i: A1, ok: 1, one_away: false }] }, 'attempts'],
    ['one_away missing', { attempts: [{ i: A1, ok: true }] }, 'attempts'],
    ['extra key in guess', { attempts: [{ i: A1, ok: true, one_away: false, t: 5 }] }, 'attempts'],
    ['ok and one_away both true', { attempts: [G(A1, true, true)] }, 'attempts'],
    ['5 correct guesses', { guesses: 6, attempts: [G(A1, true), G(A2, true), G(A3, true), G(A4, true), G(['a', 'b', 'c', 'd'], true)] }, 'attempts'],
    ['more guesses listed than guesses', { guesses: 4, mistakes: 0, attempts: [G(A1, true), G(A2, true), G(A3, true), G(A4, true), G(WRONG, false)] }, 'attempts'],
    ['solveOrder not array', { solveOrder: 'g' }, 'solve_order'],
    ['solveOrder 5 long', { solveOrder: ORDER.concat('g-x') }, 'solve_order'],
    ['solveOrder duplicate', { solveOrder: ['g-a', 'g-a', 'g-b', 'g-c'] }, 'solve_order'],
    ['solveOrder bad id', { solveOrder: ['G!', 'g-a', 'g-b', 'g-c'] }, 'solve_order'],
    ['won with 3 in solveOrder', { solveOrder: ORDER.slice(0, 3) }, 'solve_order'],
    ['revealedGroup bad id', { revealedGroup: '<script>' }, 'revealed_group'],
    ['revealedGroup without category hint', { revealedGroup: 'g-cheese', hints: { labels: false, seeds: true, category: false }, hintAfter: { labels: null, seeds: 0, category: null } }, 'revealed_group'],
    ['hintAfter 4', { hintAfter: { labels: null, seeds: 4, category: 2 } }, 'hint_after'],
    ['hintAfter float', { hintAfter: { labels: null, seeds: 0.5, category: 2 } }, 'hint_after'],
    ['hintAfter for unused hint', { hintAfter: { labels: 1, seeds: 0, category: 2 } }, 'hint_after'],
    ['hintAfter missing key', { hintAfter: { seeds: 0, category: 2 } }, 'hint_after'],
    ['hintAfter extra key', { hintAfter: { labels: null, seeds: 0, category: 2, x: 1 } }, 'hint_after'],
    ['hintAfter array', { hintAfter: [null, 0, 2] }, 'hint_after'],
  ];
  for (const [label, o, col] of cases) {
    const { status, row } = await send(good(o));
    const others = ['attempts', 'solve_order', 'revealed_group', 'hint_after'].filter((k) => k !== col);
    ok(status === 200 && row && row[col] === null && row.outcome === 'won' && others.every((k) => row[k] !== null || (k === 'revealed_group' && o.hints)),
      'dropped, play kept: ' + label);
  }
}
// ── Oversized ──
{
  const longIds = (k) => ['a', 'b', 'c', 'd'].map((c) => c + '-' + String(k).padStart(3, '0') + '-' + 'x'.repeat(88));
  const many = Array.from({ length: 40 }, (_, k) => G(longIds(k), false));
  let r = await send(good({ casual: true, outcome: 'lost', mistakes: 20, guesses: 40, attempts: many, solveOrder: null }));
  ok(r.status === 200 && r.row.attempts && r.row.attempts.length === 40, '40 guesses of 96-char ids fits in the body cap and is stored (' + JSON.stringify(many).length + ' chars)');
  r = await send(good({ casual: true, outcome: 'lost', mistakes: 20, guesses: 40, attempts: many.concat([G(A1, false)]), solveOrder: null }));
  ok(r.status === 400 || (r.status === 200 && r.row.attempts === null), '41 guesses -> attempts dropped (guesses caps at 40 too)');
  r = await send(good({ guesses: 40, mistakes: 1, casual: true, attempts: Array.from({ length: 41 }, () => G(WRONG, false)) }));
  ok(r.status === 200 && r.row.attempts === null, '41 attempts with guesses 40 -> attempts dropped, play kept');
  const big = JSON.stringify(good()).slice(0, -1) + ',"pad":"' + 'x'.repeat(MAX_BODY_BYTES) + '"}';
  r = await send(big);
  ok(r.status === 413 && !r.row, 'body over MAX_BODY_BYTES -> 413');
  r = await send(good({ extra: 1 }));
  ok(r.status === 400 && !r.row, 'unknown top-level key still refuses the whole event');
}
// ── Database check refuses the detail: play saved without it ──
{
  const { status, row, db } = await send(good(), { checkFail: true });
  ok(status === 200 && db.st.plays.length === 1 && row.attempts === null && row.solve_order === null && row.hint_after === null && row.outcome === 'won',
    'check violation (23514) -> retried without detail, play kept');
}
// ── Unit helpers ──
ok(cleanAttempts([G(A1, true)], 0) === null, 'cleanAttempts: guesses 0 -> null');
ok(cleanSolveOrder(['g-a'], 'lost') !== null && cleanSolveOrder([], 'lost') === null, 'cleanSolveOrder: lost game 1 ok, empty null');
ok(cleanHintAfter({ labels: null, seeds: null, category: null }, { labels: true, seeds: true, category: true }) === null, 'cleanHintAfter: all null -> null');

console.log(fails ? `\n${fails} FAIL (${passes} pass)` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
