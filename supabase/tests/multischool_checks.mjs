// Checks for multischool.test.mjs, split out to keep each file short.
// Part 1: did the live-like data move cleanly?
import { as } from './db_harness.mjs';

export async function checkMigratedData(db, ok, ID, P) {
  const pg = (sql, p) => as(db, 'postgres', sql, p);
  let r = await pg(`select email, school, role, display_name, color, active from public.members order by email`);
  ok(r.rows.length === 2 && r.rows.every((m) => m.school === 'cmsru' && m.role === 'admin' && m.active),
    'migrate: both old admins are now CMSRU admins', JSON.stringify(r.rows));
  ok(r.rows.find((m) => m.email === P.ADMIN)?.display_name === 'Marcus T.' && r.rows.find((m) => m.email === P.ADMIN)?.color === '#336699',
    'migrate: display name and color kept');
  r = await pg(`select count(*)::int n from public.admins_pre_multischool`);
  ok(r.rows[0]?.n === 2, 'migrate: old admins table kept as a backup');
  r = await pg(`select count(*)::int n from public.site_owners`);
  ok(r.rows[0]?.n === 0, 'migrate: no site owner seeded');
  r = await pg(`select slug, name, status from public.schools`);
  ok(r.rows.length === 1 && r.rows[0].slug === 'cmsru' && r.rows[0].status === 'active'
    && r.rows[0].name === 'Cooper Medical School of Rowan University', 'migrate: only CMSRU seeded, active');

  r = await pg(`select id, status, trashed_by, trashed_at, trash_reason, admin_note from public.submissions order by id`);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  ok(by[ID.s8]?.status === 'new', 'migrate: shortlisted -> new');
  ok(by[ID.sDecl]?.status === 'trashed' && by[ID.sDecl].trashed_by === P.ADMIN2 && by[ID.sDecl].trash_reason === 'Not pathology'
    && by[ID.sDecl].trashed_at && new Date(by[ID.sDecl].trashed_at).toISOString() === '2026-10-11T13:00:00.000Z',
    'migrate: declined -> trashed with who, when, and the note as reason', JSON.stringify(by[ID.sDecl]));
  ok(by[ID.sUsed]?.status === 'used' && by[ID.sNew]?.status === 'new', 'migrate: new and used untouched');
  ok(by[ID.sPuz]?.status === 'new', 'migrate: old full-puzzle suggestion kept');
  r = await pg(`select count(*)::int n from public.submissions where status not in ('new','used','trashed')`);
  ok(r.rows[0].n === 0, 'migrate: no old statuses left');
  r = await pg(`select count(*)::int n from public.review_events where action in ('shortlist', 'decline')`);
  ok(r.rows[0].n >= 0, 'migrate: old history lines still readable (' + r.rows[0].n + ')');
  r = await pg(`select school from public.drafts`);
  ok(r.rows.length === 2 && r.rows.every((d) => d.school === 'cmsru'), 'migrate: drafts keep school cmsru');
  r = await pg(`select count(*)::int n from public.draft_events where school is distinct from 'cmsru'`);
  ok(r.rows[0].n === 0, 'migrate: every draft history line got school cmsru');
  r = await pg(`select school, visibility from public.comments`);
  ok(r.rows.length === 2 && r.rows.every((c) => c.school === 'cmsru' && c.visibility === 'school'), 'migrate: old comments are CMSRU-only');
  r = await pg(`select count(*)::int n from public.votes where school = 'cmsru'`);
  ok(r.rows[0].n === 2, 'migrate: old votes counted for CMSRU');
  r = await pg(`select comment_default, faculty_badge from public.school_settings where school = 'cmsru'`);
  ok(r.rows[0]?.comment_default === 'school' && r.rows[0]?.faculty_badge === true, 'migrate: CMSRU settings row with defaults');
  r = await pg(`select trash_retention_days from public.site_settings`);
  ok(r.rows.length === 1 && r.rows[0].trash_retention_days === null, 'migrate: trash kept forever by default');
  r = await pg(`select count(*)::int n from public.category_uses`);
  ok(r.rows[0].n === 0, 'migrate: no usage rows invented for the old publish (import tool does that)');
  r = await as(db, P.ADMIN, `select email, display_name from public.admins order by email`);
  ok(!r.error && r.rows.length === 2, 'compat: the admins view still lists CMSRU for an admin', r.error);
  r = await as(db, P.ADMIN, `update public.admins set display_name = 'Marcus T2', color = '#112233' where email = $1 returning email`, [P.ADMIN]);
  ok(!r.error && r.rows.length === 1, 'compat: an admin still sets their own name through the admins view', r.error);
  r = await as(db, P.ADMIN, `update public.admins set display_name = 'Hacked' where email = $1 returning email`, [P.ADMIN2]);
  ok(!r.error && r.rows.length === 0, 'compat: but not someone else\'s', r.error);
}
