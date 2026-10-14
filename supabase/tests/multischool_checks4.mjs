// Checks for multischool.test.mjs, part 4 (stage S4): adding a school, last
// sign-in for the admin console, the Studio's public school list, settings
// rights, and tidying up draft uploads (own uploads only).
import { as, userId } from './db_harness.mjs';
import { TEST_SCHOOL } from './multischool_checks2.mjs';

const err = (r) => !!r.error;

export async function checkS4(db, ok, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  // ── Add school ──
  let r = await call(P.LEAD, `select public.add_school('pinebrook', 'Pinebrook College of Medicine', 'pb.lead@example.edu')`);
  ok(err(r), 'add_school: a school lead cannot add a school');
  r = await call('anon', `select public.add_school('pinebrook', 'Pinebrook College of Medicine', 'pb.lead@example.edu')`);
  ok(err(r), 'add_school: the public key cannot add a school');
  r = await call(P.OWNER, `select public.add_school('Pine Brook!', 'Pinebrook', 'pb.lead@example.edu')`);
  ok(err(r) && /Short code/.test(r.error), 'add_school: bad short code refused with a plain message', r.error);
  r = await call(P.OWNER, `select public.add_school('cmsru', 'Again', 'pb.lead@example.edu')`);
  ok(err(r) && /already taken/.test(r.error), 'add_school: taken short code refused', r.error);
  r = await call(P.OWNER, `select public.add_school('pinebrook', 'Pinebrook College of Medicine', 'not an email')`);
  ok(err(r), 'add_school: bad lead email refused (nothing created)');
  r = await call('postgres', `select count(*)::int n from public.schools where slug = 'pinebrook'`);
  ok(r.rows[0].n === 0, 'add_school: a refused call leaves no half-made school');
  r = await call(P.OWNER, `select public.add_school('pinebrook', 'Pinebrook College of Medicine', ' PB.Lead@Example.edu ')`);
  ok(!err(r), 'add_school: owner adds a school and its first lead', r.error);
  r = await call('postgres', `select s.status, m.role, m.email, (select count(*)::int from public.school_settings x where x.school = s.slug) sets,
    (select count(*)::int from public.member_events e where e.school = s.slug and e.action = 'member_add') evs
    from public.schools s join public.members m on m.school = s.slug where s.slug = 'pinebrook'`);
  const row = r.rows[0] || {};
  ok(row.status === 'setup' && row.role === 'lead' && row.email === 'pb.lead@example.edu' && row.sets === 1 && row.evs === 1,
    'add_school: school in setup, lead listed (email tidied), settings row, logged', JSON.stringify(row));
  r = await call('auth', `select private.hook_signup_admins_only(jsonb_build_object('user', jsonb_build_object('email', 'pb.lead@example.edu'))) h`);
  ok(!err(r) && !r.rows[0].h.error, 'add_school: the new lead may sign up with the emailed code', r.error);

  // ── The Studio's school list (public) ──
  r = await call('anon', `select * from public.active_schools()`);
  const keys = r.rows[0] ? Object.keys(r.rows[0]).sort().join(',') : '';
  ok(!err(r) && keys === 'name,slug', 'active_schools: the public key gets only slug and name', r.error || keys);
  ok(r.rows.some((x) => x.slug === 'cmsru') && !r.rows.some((x) => x.slug === 'pinebrook'), 'active_schools: active schools only (not ones in setup)');
  r = await call('anon', `select count(*)::int n from public.schools`);
  ok(err(r) || r.rows[0].n === 0, 'active_schools: the schools table itself stays closed to the public key');
  r = await call(P.OWNER, `update public.schools set status = 'active' where slug = 'pinebrook'`);
  ok(!err(r), 'schools: owner marks a school active', r.error);
  r = await call('anon', `select slug from public.active_schools()`);
  ok(r.rows.some((x) => x.slug === 'pinebrook'), 'active_schools: an activated school shows in the Studio list');
  r = await call(P.LEAD, `update public.schools set status = 'setup' where slug = 'pinebrook' returning slug`);
  ok(err(r) || r.rows.length === 0, 'schools: a lead cannot change a school status');

  // ── Last sign-in ──
  await call('postgres', `insert into auth.users (email, last_sign_in_at) values ($1, '2026-10-12T09:00:00Z'), ($2, '2026-10-11T08:00:00Z')`, [P.FAC, P.OTHER]);
  r = await call(P.LEAD, `select email, last_sign_in_at from public.people_sign_ins()`);
  const mine = new Map(r.rows.map((x) => [x.email, x.last_sign_in_at]));
  ok(!err(r) && mine.has(P.FAC) && mine.get(P.FAC) !== null, 'sign-ins: a lead sees when their own people last signed in', r.error);
  ok(!mine.has(P.OTHER), 'sign-ins: a lead sees nothing about other schools');
  ok(mine.has(P.ADMIN) && mine.get(P.ADMIN) === null, 'sign-ins: someone who never signed up shows as null');
  r = await call(P.OWNER, `select email from public.people_sign_ins()`);
  ok(r.rows.some((x) => x.email === P.OTHER) && r.rows.some((x) => x.email === 'pb.lead@example.edu'), 'sign-ins: the owner sees every school');
  r = await call(P.ADMIN, `select count(*)::int n from public.people_sign_ins()`);
  ok(!err(r) && r.rows[0].n === 0, 'sign-ins: an admin sees nobody\'s sign-ins');
  r = await call('anon', `select * from public.people_sign_ins()`);
  ok(err(r), 'sign-ins: the public key cannot call it');

  // ── Settings rights ──
  r = await call(P.LEAD, `update public.site_settings set trash_retention_days = 30 returning id`);
  ok(err(r) || r.rows.length === 0, 'settings: a lead cannot set Trash auto-delete');
  r = await call(P.OWNER, `update public.site_settings set trash_retention_days = 90 returning updated_by`);
  ok(!err(r) && r.rows[0] && r.rows[0].updated_by === P.OWNER, 'settings: owner sets Trash auto-delete (stamped)', r.error);
  r = await call(P.OWNER, `update public.site_settings set trash_retention_days = null returning id`);
  ok(!err(r) && r.rows.length === 1, 'settings: owner sets it back to Never');
  r = await call(P.LEAD, `update public.school_settings set faculty_badge = false, comment_default = 'all' where school = 'cmsru' returning school`);
  ok(!err(r) && r.rows.length === 1, 'settings: lead changes own school settings', r.error);
  r = await call(P.LEAD, `update public.school_settings set faculty_badge = false where school = $1 returning school`, [TEST_SCHOOL]);
  ok(err(r) || r.rows.length === 0, 'settings: lead cannot change another school\'s settings');
  r = await call(P.ADMIN, `update public.school_settings set faculty_badge = true where school = 'cmsru' returning school`);
  ok(err(r) || r.rows.length === 0, 'settings: an admin cannot change school settings');
  await call('postgres', `update public.school_settings set faculty_badge = true, comment_default = 'school' where school = 'cmsru'`);

  // ── Tidying up draft uploads: your own only ──
  r = await call(P.ADMIN, `insert into public.drafts (title) values ('S4 upload test') returning id`);
  ok(!err(r) && r.rows[0], 'uploads: admin makes a draft', r.error);
  const dId = r.rows[0] && r.rows[0].id;
  const up = (who, name) => call(who, `insert into storage.objects (bucket_id, name) values ('submissions', $1) returning owner`, [name]);
  const del = (who, name) => call(who, `delete from storage.objects where bucket_id = 'submissions' and name = $1 returning name`, [name]);
  r = await up(P.ADMIN, `drafts/${dId}/a.webp`);
  ok(!err(r) && r.rows[0].owner === userId(P.ADMIN), 'uploads: the uploader is recorded as owner', r.error);
  await up(P.LEAD, `drafts/${dId}/b.webp`);
  r = await del(P.LEAD, `drafts/${dId}/a.webp`);
  ok(!err(r) && r.rows.length === 0, 'uploads: someone else (even the lead) cannot delete your upload');
  r = await del(P.ADMIN, `drafts/${dId}/a.webp`);
  ok(!err(r) && r.rows.length === 1, 'uploads: you can delete your own upload');
  r = await del(P.FAC, `drafts/${dId}/b.webp`);
  ok(!err(r) && r.rows.length === 0, 'uploads: faculty cannot delete draft images');
}
