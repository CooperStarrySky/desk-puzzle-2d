// Owner plays left out of class stats, the 4-point rating, and instant
// publishing's quiet no-op without pg_net/Vault (migrations 20261030120000,
// 20261030130000, 20261031120000). Runs in PGlite (db_harness.mjs). Never
// touches the live database.
import { freshDb, migrationFiles, applyMigration, as, counter } from './db_harness.mjs';

const { ok, done } = counter();
const db = await freshDb();
const FIRST_NEW = '20261030120000_instant_publish.sql';
const files = migrationFiles();
for (const f of files.filter((f) => f < FIRST_NEW)) await applyMigration(db, f);

const PID = 'trick-or-toxin-2026-10-30';
const OWNER = 'owner@example.com', JD = 'john.d@example.com';
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', C = '00000000-0000-4000-8000-000000000003';
await as(db, 'postgres', `insert into public.site_owners (email) values ($1) on conflict do nothing`, [OWNER]);
await as(db, 'service', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses, rating) values ($1, $2, 'won', 0, 4, 3), ($1, $3, 'lost', 4, 8, 5)`, [PID, A, B]);

for (const f of files.filter((f) => f >= FIRST_NEW)) await applyMigration(db, f);
let r = await as(db, 'postgres', `select rating, rating_5pt from public.plays order by anon_id`);
ok(r.rows[0].rating === null && r.rows[0].rating_5pt === 3 && r.rows[1].rating_5pt === 5, 'old 5-point ratings kept in rating_5pt, not counted', JSON.stringify(r.rows));
r = await as(db, 'postgres', `select rating_hist, rating_n from public.puzzle_stats where puzzle_id = $1`, [PID]);
ok(JSON.stringify(r.rows[0].rating_hist) === '[0,0,0,0]' && r.rows[0].rating_n === 0, 'rating_hist recounted to 4 slots', JSON.stringify(r.rows));
r = await as(db, 'service', `update public.plays set rating = 5 where anon_id = $1`, [A]);
ok(!!r.error, 'rating 5 refused now');
r = await as(db, 'service', `update public.plays set rating = 4 where anon_id = $1`, [A]);
ok(!r.error, 'rating 4 allowed');

r = await as(db, 'service', `insert into public.publish_jobs (draft_id, kind) select id, 'now' from public.drafts limit 0`);
ok(!r.error, 'publish trigger installs cleanly', r.error);
r = await as(db, 'postgres', `select private.kick_publisher(), private.publisher_check()`);
ok(!r.error, 'kick_publisher is a quiet no-op without pg_net / the Vault token', r.error);

r = await as(db, 'postgres', `select plays, std_wins from public.puzzle_stats where puzzle_id = $1`, [PID]);
ok(r.rows[0].plays === 2 && r.rows[0].std_wins === 1, 'both plays count before marking');
r = await as(db, JD, `select public.mark_owner_browser($1)`, [A]);
ok(!!r.error, 'a non-owner cannot mark a browser');
r = await as(db, 'anon', `select public.mark_owner_browser($1)`, [A]);
ok(!!r.error, 'the public key cannot mark a browser');
r = await as(db, OWNER, `select public.mark_owner_browser($1)`, [A]);
ok(!r.error, 'the owner marks their browser', r.error);
r = await as(db, 'postgres', `select plays, std_wins, rating_n from public.puzzle_stats where puzzle_id = $1`, [PID]);
ok(r.rows[0].plays === 1 && r.rows[0].std_wins === 0 && r.rows[0].rating_n === 0, "owner's past play left out right away", JSON.stringify(r.rows));
await as(db, 'service', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses) values ($1, $2, 'won', 1, 5)`, ['fruit-findings-2026-10-01', A]);
r = await as(db, 'postgres', `select plays from public.puzzle_stats where puzzle_id = 'fruit-findings-2026-10-01'`);
ok(!r.rows.length || r.rows[0].plays === 0, "owner's later plays left out too", JSON.stringify(r.rows));
await as(db, 'service', `insert into public.plays (puzzle_id, anon_id, outcome, mistakes, guesses) values ($1, $2, 'won', 0, 4)`, [PID, C]);
r = await as(db, 'postgres', `select plays from public.puzzle_stats where puzzle_id = $1`, [PID]);
ok(r.rows[0].plays === 2, 'other players still count');
r = await as(db, OWNER, `select public.mark_owner_browser($1)`, [A]);
ok(!r.error, 'marking again is harmless');
r = await as(db, JD, `select * from private.owner_browsers`);
ok(!!r.error, 'the owner-browser list is not readable by members');
r = await as(db, 'anon', `select count(*)::int n from public.plays`);
ok(!!r.error || r.rows[0].n === 0, 'plays stay private');
done();
