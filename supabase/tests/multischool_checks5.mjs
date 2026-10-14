// Checks for multischool.test.mjs, part 5: 20261014120000_school_color.sql.
// Each school's pill color: CMSRU starts crimson, new schools slate; only the
// school's lead or the site owner changes it (through set_school_color);
// the public key still can't read schools, and active_schools stays slug + name.
import { as } from './db_harness.mjs';
import { TEST_SCHOOL } from './multischool_checks2.mjs';

const err = (r) => !!r.error;

export async function checkSchoolColor(db, ok, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  const color = async (slug) => ((await call('postgres', `select color from public.schools where slug = $1`, [slug])).rows[0] || {}).color;
  ok(await color('cmsru') === '#9e1b32', 'color: CMSRU starts crimson', await color('cmsru'));
  ok(await color(TEST_SCHOOL) === '#4a5568', 'color: other schools start slate grey', await color(TEST_SCHOOL));
  let r = await call(P.ADMIN, `select slug, color from public.schools where slug = $1`, [TEST_SCHOOL]);
  ok(!err(r) && r.rows[0]?.color === '#4a5568', 'color: members read every school\'s color', r.error);

  r = await call(P.LEAD, `select public.set_school_color('cmsru', '#7A1F2B') c`);
  ok(!err(r) && r.rows[0]?.c === '#7a1f2b' && await color('cmsru') === '#7a1f2b', 'color: lead changes own school color (stored lowercase)', r.error);
  r = await call(P.LEAD, `select public.set_school_color($1, '#123456')`, [TEST_SCHOOL]);
  ok(err(r) && await color(TEST_SCHOOL) === '#4a5568', 'color: lead cannot change another school\'s color');
  r = await call(P.ADMIN, `select public.set_school_color('cmsru', '#000000')`);
  ok(err(r) && await color('cmsru') === '#7a1f2b', 'color: an admin cannot change it');
  r = await call(P.FAC, `select public.set_school_color('cmsru', '#000000')`);
  ok(err(r) && await color('cmsru') === '#7a1f2b', 'color: faculty cannot change it');
  r = await call(P.OTHERLEAD, `select public.set_school_color($1, '#2f6b3a')`, [TEST_SCHOOL]);
  ok(!err(r) && await color(TEST_SCHOOL) === '#2f6b3a', 'color: test-school lead changes its own', r.error);
  r = await call(P.OWNER, `select public.set_school_color('cmsru', '#9e1b32')`);
  ok(!err(r) && await color('cmsru') === '#9e1b32', 'color: site owner changes any school', r.error);
  for (const bad of ['red', '#12345', '#12345g', 'url(x)', '']) {
    r = await call(P.OWNER, `select public.set_school_color('cmsru', $1)`, [bad]);
    ok(err(r), 'color: refuses "' + bad + '"');
  }
  r = await call(P.OWNER, `select public.set_school_color('no-such-school', '#123456')`);
  ok(err(r), 'color: unknown school refused');
  r = await call(P.LEAD, `update public.schools set color = '#000000' where slug = 'cmsru' returning slug`);
  ok(err(r) || r.rows.length === 0, 'color: a lead cannot update the schools table directly');
  r = await call('postgres', `update public.schools set color = 'blue' where slug = 'cmsru'`);
  ok(err(r), 'color: the check constraint refuses non-hex values');

  r = await call('anon', `select public.set_school_color('cmsru', '#000000')`);
  ok(err(r) && await color('cmsru') === '#9e1b32', 'color: the public key cannot change it');
  r = await call('anon', `select count(*)::int n from public.schools`);
  ok(err(r) || r.rows[0].n === 0, 'color: the schools table stays closed to the public key');
  r = await call('anon', `select * from public.active_schools()`);
  const keys = r.rows && r.rows[0] ? Object.keys(r.rows[0]).sort().join(',') : '';
  ok(!err(r) && keys === 'name,slug', 'color: active_schools still gives only slug and name', r.error || keys);
}
