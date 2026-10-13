// node supabase/tests/import_published.test.mjs
// Runs the SQL from tools/import_published_categories.mjs (twice) against a
// throwaway in-memory database with every migration applied. No network.
import { freshDb, migrationFiles, applyMigration, as, counter } from './db_harness.mjs';
import { readPublished, buildSql, matchCategory } from '../../tools/import_published_categories.mjs';

const { ok, done } = counter();
const cats = readPublished();
ok(cats.length >= 12 && cats.every((c) => c.payload.items.length === 4), `reads ${cats.length} published categories, 4 clues each`);
const hemo = cats.find((c) => /hemoptysis/i.test(c.payload.name));
const lead = cats.find((c) => /lead poisoning/i.test(c.payload.name));
ok(hemo && lead, 'finds "Causes of hemoptysis" and "Lead poisoning"');
const imgClue = cats.flatMap((c) => c.payload.items).find((i) => i.info && i.info.image);
ok(imgClue && /^puzzles\/[^/]+\/[^/]+\.(webp|png|jpe?g)$/.test(imgClue.info.image), 'image clues keep their public site path');

// Pure matching rule.
ok(matchCategory(hemo.payload, hemo.payload)?.adapted === false, 'match: identical = as-is');
const tweaked = { name: lead.payload.name, items: lead.payload.items.slice(0, 2).concat([{ label: 'Other 1' }, { label: 'Other 2' }]) };
ok(matchCategory(lead.payload, tweaked)?.adapted === true, 'match: same name + 2 shared clues = adapted');
ok(matchCategory(lead.payload, { name: 'Something else', items: tweaked.items }) === null, 'match: different name + 2 shared clues = no link');

const db = await freshDb();
for (const f of migrationFiles()) await applyMigration(db, f);
const studio = (id, name, labels, code) => db.query(
  `insert into public.submissions (id, group_name, payload, credit_mode, credit_name, consent, receipt_code)
   values ($1, $2, $3, 'named', 'John D.', true, $4)`,
  [id, name, JSON.stringify({ name, explanation: 'x', items: labels.map((l) => ({ label: l, info: { title: l } })) }), code]);
const A = '00000000-0000-4000-8000-0000000000aa', B = '00000000-0000-4000-8000-0000000000bb', C = '00000000-0000-4000-8000-0000000000cc';
await studio(A, hemo.payload.name, hemo.payload.items.map((i) => i.label), 'DP-AAAA-AAAA');
await studio(B, lead.payload.name, tweaked.items.map((i) => i.label), 'DP-BBBB-BBBB');
await studio(C, 'Unrelated', ['W', 'X', 'Y', 'Z'], 'DP-CCCC-CCCC');

const sql = buildSql(cats);
const run = async () => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
let e = await run();
ok(!e, 'import SQL runs', e);
const count = async (q, p) => (await as(db, 'postgres', q, p)).rows[0]?.n;
const added = cats.length - 2;
ok(await count(`select count(*)::int n from public.submissions where source = 'published'`) === added, `adds ${added} new categories (2 linked)`);
ok(await count(`select count(*)::int n from public.category_uses`) === cats.length, 'one usage row per published category');
let r = await as(db, 'postgres', `select s.status, u.adapted, u.puzzle_id from public.submissions s join public.category_uses u on u.submission_id = s.id where s.id = $1`, [A]);
ok(r.rows[0]?.status === 'used' && r.rows[0]?.adapted === false && r.rows[0]?.puzzle_id === hemo.puzzleId, 'links "Causes of hemoptysis" to the existing suggestion, as-is');
r = await as(db, 'postgres', `select u.adapted from public.category_uses u where u.submission_id = $1`, [B]);
ok(r.rows[0]?.adapted === true, 'links the changed "Lead poisoning" as adapted');
ok(await count(`select count(*)::int n from public.category_uses where submission_id = $1`, [C]) === 0, 'leaves unrelated suggestions alone');
r = await as(db, 'postgres', `select status, school, credit_name, used_in, source_ref from public.submissions where source = 'published' limit 1`);
ok(r.rows[0]?.status === 'used' && r.rows[0]?.school === 'cmsru' && r.rows[0]?.credit_name === 'Puzzle group' && r.rows[0]?.used_in === r.rows[0]?.source_ref,
  'new rows: used, cmsru, credit "Puzzle group", source_ref = puzzle id');
ok(await count(`select count(*)::int n from public.submissions where search @@ to_tsquery('english', 'hemoptysis')`) >= 1, 'imported rows are searchable');
e = await run();
ok(!e, 'import SQL runs a second time', e);
ok(await count(`select count(*)::int n from public.submissions where source = 'published'`) === added
  && await count(`select count(*)::int n from public.category_uses`) === cats.length, 'second run changes nothing');
r = await as(db, 'anon', `select count(*)::int n from public.category_uses`);
ok(!!r.error || r.rows[0].n === 0, 'public key still reads no usage rows');

const { fails, passes } = done();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
