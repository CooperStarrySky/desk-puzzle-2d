// node supabase/tests/play_attempts.test.mjs   (PGLITE_MODULE=... if PGlite is installed elsewhere)
// 20261029120000_play_attempts.sql on a throwaway in-memory Postgres
// (db_harness.mjs). Never touches the live database.
// 1. Applies every migration before it, stores an old-style play row.
// 2. Applies it: the old row survives with null detail.
// 3. Valid detail is stored; every malformed shape is refused by a check rule.
// 4. plays stays unreadable/unwritable with the public key; puzzle_stats unchanged.
import { freshDb, migrationFiles, applyMigration, as, counter } from './db_harness.mjs';

const { ok, done } = counter();
const NEW = '20261029120000_play_attempts.sql';
const db = await freshDb();
const files = migrationFiles();
ok(files.includes(NEW), 'migration file present');
for (const f of files.filter((f) => f < NEW)) await applyMigration(db, f);

let k = 0;
const anon = () => '00000000-0000-4000-8000-' + String(++k).padStart(12, '0');
const PID = 'holes-haze-and-old-paint-2026-10-08';
const G = (i, okv, oa = false) => ({ i, ok: okv, one_away: oa });
const A = [G(['aspirin', 'exercise', 'air-pollution', 'chest-ct'], false, true), G(['a1', 'a2', 'a3', 'a4'], true),
  G(['b1', 'b2', 'b3', 'b4'], true), G(['c1', 'c2', 'c3', 'c4'], true), G(['d1', 'd2', 'd3', 'd4'], true)];

const OLD = anon();
let r = await as(db, 'service', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses) values ($1, $2, 'won', 0, 4)`, [PID, OLD]);
ok(!r.error, 'old-style row stored before the migration', r.error);

await applyMigration(db, NEW);
ok(true, 'migration applies on top of existing data');
r = await as(db, 'postgres', `select attempts, solve_order, revealed_group, hint_after from public.plays where anon_id = $1`, [OLD]);
ok(r.rows.length === 1 && Object.values(r.rows[0]).every((v) => v === null), 'old row kept, detail columns null');

const ins = (o = {}) => {
  const row = Object.assign({ puzzle_id: PID, anon_id: anon(), outcome: 'won', mistakes: 1, guesses: 5, hint_labels: false, hint_seeds: true,
    hint_category: true, attempts: A, solve_order: ['g-a', 'g-b', 'g-c', 'g-d'], revealed_group: 'g-d', hint_after: [null, 0, 2] }, o);
  return as(db, 'service', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses, hint_labels, hint_seeds, hint_category,
      attempts, solve_order, revealed_group, hint_after) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::text[], $11, $12::smallint[])`,
  [row.puzzle_id, row.anon_id, row.outcome, row.mistakes, row.guesses, row.hint_labels, row.hint_seeds, row.hint_category,
    row.attempts === null ? null : JSON.stringify(row.attempts), row.solve_order, row.revealed_group, row.hint_after]);
};

r = await ins();
ok(!r.error, 'valid detail stored by the server role', r.error);
r = await ins({ attempts: null, solve_order: null, revealed_group: null, hint_after: null });
ok(!r.error, 'all detail null (old client) stored', r.error);
const long = (c) => c + '-' + 'x'.repeat(95 - c.length); // exactly 96 chars
r = await ins({ outcome: 'lost', mistakes: 20, guesses: 40, solve_order: null, attempts: Array.from({ length: 40 }, (_, n) => G([long('a'), long('b'), long('c'), long('d' + (n % 10))], false)) });
ok(!r.error, '40 guesses of 96-char ids fits the size cap', r.error);

const bad = [
  ['attempts not an array', { attempts: { i: 1 } }],
  ['attempts empty', { attempts: [] }],
  ['41 attempts', { guesses: 40, attempts: Array.from({ length: 41 }, () => A[0]) }],
  ['more attempts than guesses', { guesses: 4, mistakes: 0 }],
  ['guess with 3 ids', { attempts: [G(['a', 'b', 'c'], false)] }],
  ['guess with duplicate ids', { attempts: [G(['a', 'a', 'b', 'c'], false)] }],
  ['upper-case id', { attempts: [G(['A', 'b', 'c', 'd'], false)] }],
  ['97-char id', { attempts: [G(['x'.repeat(97), 'b', 'c', 'd'], false)] }],
  ['number as id', { attempts: [G([1, 'b', 'c', 'd'], false)] }],
  ['ok as string', { attempts: [{ i: ['a', 'b', 'c', 'd'], ok: 'true', one_away: false }] }],
  ['missing one_away', { attempts: [{ i: ['a', 'b', 'c', 'd'], ok: false }] }],
  ['extra key', { attempts: [{ i: ['a', 'b', 'c', 'd'], ok: false, one_away: false, t: 1 }] }],
  ['correct and one_away', { attempts: [G(['a', 'b', 'c', 'd'], true, true)] }],
  ['5 correct', { guesses: 6, attempts: A.slice(1).concat([G(['e1', 'e2', 'e3', 'e4'], true), G(['f1', 'f2', 'f3', 'f4'], true)]) }],
  ['solve_order 5 long', { solve_order: ['a', 'b', 'c', 'd', 'e'] }],
  ['solve_order empty', { solve_order: [] }],
  ['solve_order duplicate', { solve_order: ['a', 'a'] }],
  ['solve_order bad id', { solve_order: ['a b'] }],
  ['solve_order 2-D', { solve_order: [['a', 'b'], ['c', 'd']] }],
  ['revealed_group bad id', { revealed_group: 'G!' }],
  ['revealed_group without category hint', { hint_category: false, hint_after: [null, 0, null] }],
  ['hint_after 2 long', { hint_after: [0, 0] }],
  ['hint_after 4', { hint_after: [null, 4, 2] }],
  ['hint_after negative', { hint_after: [null, -1, 2] }],
  ['hint_after for unused hint', { hint_after: [1, 0, 2] }],
];
for (const [label, o] of bad) {
  r = await ins(o);
  ok(!!r.error && /check|violates|malformed|dimension/i.test(r.error), 'refused: ' + label, r.error || 'stored');
}

// ── Still private ──
r = await as(db, 'anon', `select * from public.plays`);
ok(!!r.error, 'anon cannot read plays', r.error || 'readable');
r = await as(db, 'authenticated@example.edu', `select attempts from public.plays`);
ok(!!r.error, 'signed-in user cannot read plays', r.error || 'readable');
r = await as(db, 'anon', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses) values ($1, $2, 'won', 0, 4)`, [PID, anon()]);
ok(!!r.error, 'anon cannot write plays', r.error || 'written');
r = await as(db, 'anon', `select private.dp_valid_attempts('[]'::jsonb)`);
ok(!!r.error, 'anon cannot call the validators', r.error || 'callable');
r = await as(db, 'postgres', `select relrowsecurity from pg_class where oid = 'public.plays'::regclass`);
ok(r.rows[0] && r.rows[0].relrowsecurity === true, 'row level security still on for plays');
r = await as(db, 'postgres', `select count(*)::int as n from pg_policies where tablename = 'plays'`);
ok(r.rows[0] && r.rows[0].n === 0, 'still no row rule on plays (nobody with a public key gets rows)');
r = await as(db, 'anon', `select * from public.puzzle_stats where puzzle_id = $1`, [PID]);
ok(!r.error && r.rows.length === 1 && r.rows[0].plays === 4, 'anon reads totals; old + new rows counted (' + (r.rows[0] && r.rows[0].plays) + ')', r.error);
ok(r.rows[0] && !Object.keys(r.rows[0]).some((c) => /attempt|solve|reveal|after/.test(c)), 'no detail columns in public totals');

const { fails, passes } = done();
console.log(fails ? `\n${fails} FAIL (${passes} pass)` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
