// node supabase/tests/multischool.test.mjs
// Row rules and data move for 20261013120000_multischool.sql, on a throwaway
// in-memory Postgres (see db_harness.mjs). Never touches the live database.
//
// 1. Applies every migration before multischool, then seeds data shaped like
//    the live database today (admins, shortlisted/declined suggestions, a
//    published draft, comments, votes).
// 2. Applies the multischool migration on top and checks the data moved cleanly.
// 3. Adds a second (test) school and plays every role against the rules.
import { freshDb, migrationFiles, applyMigration, as, counter } from './db_harness.mjs';

const { ok, done } = counter();
const NEW = '20261013120000_multischool.sql';

const OWNER = 'thirth.p@example.edu';      // site owner (no school row)
const LEAD = 'john.doe@example.edu';       // CMSRU lead
const ADMIN = 'marcus.t@example.edu';      // CMSRU admin (was on the old admins list)
const ADMIN2 = 'jd.admin@example.edu';     // CMSRU admin (was on the old admins list)
const FAC = 'dr.lee@example.edu';          // CMSRU faculty
const OTHER = 'aisha.k@example.edu';       // admin at the test school
const OTHERLEAD = 'nina.w@example.edu';    // lead at the test school
const STRANGER = 'nobody@example.com';

const ID = {
  sNew: '00000000-0000-4000-8000-000000000001',
  sShort: '00000000-0000-4000-8000-000000000002',
  sDecl: '00000000-0000-4000-8000-000000000003',
  sUsed: '00000000-0000-4000-8000-000000000004',
  sPuz: '00000000-0000-4000-8000-000000000005',
  s6: '00000000-0000-4000-8000-000000000006',
  s7: '00000000-0000-4000-8000-000000000007',
  s8: '00000000-0000-4000-8000-000000000008',
  dPub: '00000000-0000-4000-9000-000000000001',
  dPlan: '00000000-0000-4000-9000-000000000002',
};

const clue = (label, img) => ({ label, zone: img ? 'photo' : 'rack', info: Object.assign({ title: label }, img ? { image: img } : {}), source: img ? 'CC BY' : undefined });
const cat = (name, labels, imgPrefix) => ({
  name, explanation: name + ' explained',
  items: labels.map((l, i) => clue(l, imgPrefix && i === 0 ? imgPrefix + '/c0-info.webp' : null)),
});

async function seedLiveLike(db) {
  const q = (sql, p) => db.query(sql, p);
  await q(`insert into public.admins (email, display_name, color) values
    ($1, 'Marcus T.', '#336699'), ($2, 'John D.', null)`, [ADMIN, ADMIN2]);
  const sub = (id, status, name, labels, extra = {}) => q(
    `insert into public.submissions (id, kind, status, group_name, payload, credit_mode, credit_name, consent, receipt_code,
       admin_note, reviewed_by, reviewed_at, used_in)
     values ($1, $2, $3, $4, $5, 'named', 'John D.', true, $6, $7, $8, $9, $10)`,
    [id, extra.kind || 'category', status, name, extra.payload || cat(name, labels, id), 'DP-' + id.slice(-4) + '-TEST',
      extra.note || null, extra.by || null, extra.at || null, extra.usedIn || null]);
  await sub(ID.sNew, 'new', 'Causes of clubbing', ['Lung cancer', 'Bronchiectasis', 'Cyanotic heart disease', 'IBD']);
  await sub(ID.sShort, 'shortlisted', 'Causes of hemoptysis', ['TB', 'Bronchiectasis', 'Lung cancer', 'Goodpasture'],
    { by: ADMIN, at: '2026-10-11T12:00:00Z' });
  await sub(ID.sDecl, 'declined', 'Things that are blue', ['Sky', 'Sea', 'Cyanosis', 'Methylene'],
    { by: ADMIN2, at: '2026-10-11T13:00:00Z', note: 'Not pathology' });
  await sub(ID.sUsed, 'new', 'Asthma triggers', ['Dust', 'Cold air', 'Aspirin', 'Exercise']);
  await sub(ID.sPuz, 'new', 'Whole puzzle', [], { kind: 'puzzle', payload: { title: 'Whole puzzle', groups: [] } });
  await sub(ID.s6, 'new', 'Lead poisoning signs', ['Basophilic stippling', 'Burton line', 'Wrist drop', 'Anemia']);
  await sub(ID.s7, 'new', 'Cheese-related', ['Tyramine', 'Listeria', 'Casein', 'Rennet']);
  await sub(ID.s8, 'new', 'Spare category', ['A', 'B', 'C', 'D']);
  // A published draft (via the robot) and a planning draft sharing one category.
  await q(`insert into public.drafts (id, title, status, owner_email, target_release) values
    ($1, 'Cheese, asthma, lead, hemoptysis', 'ready', $3, '2026-10-15T10:00:00Z'),
    ($2, 'Next week', 'scheduled', $4, '2026-10-22T10:00:00Z')`, [ID.dPub, ID.dPlan, ADMIN, ADMIN2]);
  const slot = (d, t, s, gi = null) => q(`insert into public.draft_slots (draft_id, tier, submission_id, group_index) values ($1, $2, $3, $4)`, [d, t, s, gi]);
  await slot(ID.dPub, 1, ID.s7); await slot(ID.dPub, 2, ID.sUsed); await slot(ID.dPub, 3, ID.s6); await slot(ID.dPub, 4, ID.sShort);
  await slot(ID.dPlan, 1, ID.sNew); await slot(ID.dPlan, 2, ID.s8); await slot(ID.dPlan, 3, ID.sDecl); await slot(ID.dPlan, 4, ID.sPuz, 0);
  await q(`insert into public.comments (target_type, target_id, author_email, body) values
    ('submission', $1, $3, 'Love this one'), ('draft', $2, $3, 'Swap tier 2?')`, [ID.sNew, ID.dPlan, ADMIN]);
  await q(`insert into public.votes (submission_id, voter_email) values ($1, $2), ($1, $3)`, [ID.sNew, ADMIN, ADMIN2]);
}

async function main() {
  const db = await freshDb();
  for (const f of migrationFiles().filter((f) => f < NEW)) await applyMigration(db, f);
  await seedLiveLike(db);
  // Publish the first draft the old way (robot), before the new migration.
  let r = await as(db, 'service', `update public.drafts set status = 'published', published_puzzle_id = 'cheese-asthma-lead-hemoptysis-2026-10-15' where id = $1`, [ID.dPub]);
  ok(!r.error, 'seed: old-style publish works before the migration', r.error);
  r = await as(db, 'postgres', `select status from public.submissions where id = $1`, [ID.sShort]);
  ok(r.rows[0]?.status === 'used', 'seed: published category was marked used (was shortlisted)');
  await db.query(`update public.submissions set status = 'shortlisted', reviewed_by = $2 where id = $1`, [ID.s8, ADMIN]);

  try {
    await applyMigration(db, NEW);
    ok(true, 'migration applies on live-like data');
  } catch (e) {
    ok(false, 'migration applies on live-like data', e.message);
    return;
  }
  const { checkMigratedData } = await import('./multischool_checks.mjs');
  const P = { OWNER, LEAD, ADMIN, ADMIN2, FAC, OTHER, OTHERLEAD, STRANGER };
  await checkMigratedData(db, ok, ID, P);
  const c2 = await import('./multischool_checks2.mjs');
  await c2.setupSchools(db, P);
  await c2.checkPeople(db, ok, P);
  const testSub = await c2.checkTrash(db, ok, ID, P);
  await c2.checkEdits(db, ok, ID, P, testSub);
  const c3 = await import('./multischool_checks3.mjs');
  await c3.checkDrafts(db, ok, ID, P, testSub);
  await c3.checkCommentsVotes(db, ok, ID, P);
  await c3.checkPublishUsage(db, ok, ID, P, testSub);
  await c3.checkPurgeAndAnon(db, ok, ID, P);
  const c4 = await import('./multischool_checks4.mjs');
  await c4.checkS4(db, ok, P);
  // Later migrations on top (school pill color, ...).
  try {
    for (const f of migrationFiles().filter((f) => f > NEW)) await applyMigration(db, f);
    ok(true, 'later migrations apply on top');
  } catch (e) { ok(false, 'later migrations apply on top', e.message); return; }
  const c5 = await import('./multischool_checks5.mjs');
  await c5.checkSchoolColor(db, ok, P);
}

await main();
const { fails, passes } = done();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
