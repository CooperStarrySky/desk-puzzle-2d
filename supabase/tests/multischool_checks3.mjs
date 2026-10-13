// Checks for multischool.test.mjs, part 3: drafts, comments, votes, usage,
// publishing, purge, the calendar, and the public key.
import { as } from './db_harness.mjs';
import { TEST_SCHOOL } from './multischool_checks2.mjs';
const err = (r) => !!r.error;
export const TD = '00000000-0000-4000-9000-0000000000a1';   // test school's draft
export const CD = '00000000-0000-4000-9000-0000000000c1';   // a new CMSRU draft

export async function checkDrafts(db, ok, ID, P, testSub) {
  const call = (who, sql, p) => as(db, who, sql, p);
  // The test school plans a puzzle (its own admin, through the website).
  let r = await call(P.OTHER, `insert into public.drafts (id, title, owner_email) values ($1, 'Test school week 1', $2) returning school`, [TD, P.OTHER]);
  ok(!err(r) && r.rows[0]?.school === TEST_SCHOOL, 'drafts: a new draft gets the maker\'s school', r.error);
  for (const [t, s] of [[1, testSub], [2, ID.sNew], [3, ID.s6], [4, ID.s7]]) {
    r = await call(P.OTHER, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, $2, $3)`, [TD, t, s]);
    if (err(r)) ok(false, 'drafts: test school fills slot ' + t, r.error);
  }
  r = await call(P.OTHER, `update public.drafts set status = 'scheduled', target_release = '2026-10-22T10:00:00Z' where id = $1 returning status`, [TD]);
  ok(!err(r) && r.rows[0]?.status === 'scheduled', 'drafts: test school schedules it', r.error);

  // Privacy both ways, owner sees all.
  const sees = async (who, table, col, id) => (await call(who, `select 1 from public.${table} where ${col} = $1`, [id])).rows.length;
  ok(await sees(P.ADMIN, 'drafts', 'id', TD) === 0, 'privacy: CMSRU admin cannot see the test school draft');
  ok(await sees(P.ADMIN, 'draft_slots', 'draft_id', TD) === 0, 'privacy: nor its slots');
  ok(await sees(P.ADMIN, 'draft_events', 'draft_id', TD) === 0, 'privacy: nor its history');
  ok(await sees(P.OTHER, 'drafts', 'id', ID.dPlan) === 0, 'privacy: test school cannot see CMSRU drafts');
  ok(await sees(P.OTHER, 'draft_slots', 'draft_id', ID.dPlan) === 0, 'privacy: nor CMSRU slots');
  ok(await sees(P.OTHER, 'draft_events', 'draft_id', ID.dPub) === 0, 'privacy: nor CMSRU draft history');
  ok(await sees(P.OTHER, 'comments', 'target_id', ID.dPlan) === 0, 'privacy: nor CMSRU draft comments');
  r = await call(P.OTHER, `select count(*)::int n from public.activity where draft_id in ($1, $2)`, [ID.dPlan, ID.dPub]);
  ok(r.rows[0]?.n === 0, 'privacy: CMSRU drafts absent from the test school\'s activity (incl. add/remove-from-draft lines)');
  ok(await sees(P.OWNER, 'drafts', 'id', TD) === 1 && await sees(P.OWNER, 'drafts', 'id', ID.dPlan) === 1, 'privacy: owner sees both schools\' drafts');
  ok(await sees(P.FAC, 'drafts', 'id', ID.dPlan) === 1, 'faculty: reads own school drafts');
  r = await call(P.OTHER, `update public.drafts set title = 'mine now' where id = $1 returning id`, [ID.dPlan]);
  ok(err(r) || r.rows.length === 0, 'privacy: test school cannot edit a CMSRU draft');
  r = await call(P.OTHER, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, 1, $2)`, [ID.dPub, ID.s8]);
  ok(err(r), 'privacy: test school cannot put slots in a CMSRU draft');
  r = await call(P.ADMIN, `insert into public.drafts (title, owner_email, school) values ('sneaky', $1, $2)`, [P.ADMIN, TEST_SCHOOL]);
  ok(err(r), 'privacy: CMSRU admin cannot make a draft for the test school');

  // Faculty: read, comment, approve; no edit, delete, or planning.
  r = await call(P.FAC, `update public.drafts set title = 'faculty title' where id = $1 returning id`, [ID.dPlan]);
  ok(err(r) || r.rows.length === 0, 'faculty: cannot edit a draft');
  r = await call(P.FAC, `delete from public.drafts where id = $1 returning id`, [ID.dPlan]);
  ok(err(r) || r.rows.length === 0, 'faculty: cannot delete a draft');
  r = await call(P.FAC, `update public.drafts set status = 'ready' where id = $1 returning id`, [ID.dPlan]);
  ok(err(r) || r.rows.length === 0, 'faculty: cannot change status');
  r = await call(P.FAC, `insert into public.drafts (title, owner_email) values ('fac', $1)`, [P.FAC]);
  ok(err(r), 'faculty: cannot make a draft');
  r = await call(P.FAC, `delete from public.draft_slots where draft_id = $1 returning tier`, [ID.dPlan]);
  ok(err(r) || r.rows.length === 0, 'faculty: cannot empty slots');
  r = await call(P.FAC, `insert into public.publish_jobs (draft_id, kind) values ($1, 'now')`, [ID.dPlan]);
  ok(err(r), 'faculty: cannot ask to publish');
  r = await call(P.FAC, `insert into public.comments (target_type, target_id, body) values ('draft', $1, 'Looks good to me') returning visibility`, [ID.dPlan]);
  ok(!err(r) && r.rows[0]?.visibility === 'school', 'faculty: comments on a draft (always school-only)', r.error);
  r = await call(P.FAC, `select public.approve_draft($1)`, [ID.dPlan]);
  ok(!err(r), 'faculty: approves a draft', r.error);
  r = await call(P.ADMIN, `select faculty_approved_by, status from public.drafts where id = $1`, [ID.dPlan]);
  ok(r.rows[0]?.faculty_approved_by === P.FAC && r.rows[0]?.status === 'scheduled', 'faculty: approval stamped, status untouched');
  r = await call(P.ADMIN, `update public.drafts set faculty_approved_by = $2 where id = $1`, [ID.dPlan, P.ADMIN]);
  ok(err(r), 'approve: admins cannot forge approval');
  r = await call(P.ADMIN, `select public.approve_draft($1)`, [ID.dPlan]);
  ok(err(r), 'approve: an admin cannot approve (faculty or owner only)');
  r = await call(P.OTHER, `select public.approve_draft($1)`, [ID.dPlan]);
  ok(err(r), 'approve: other school cannot approve');
  r = await call(P.OWNER, `select public.unapprove_draft($1)`, [ID.dPlan]);
  ok(!err(r), 'approve: owner can take approval back', r.error);
  r = await call(P.FAC, `select public.approve_draft($1)`, [ID.dPub]);
  ok(err(r), 'approve: a published draft is frozen');
  r = await call(P.FAC, `select action from public.draft_events where draft_id = $1 and action in ('approve', 'unapprove') order by at`, [ID.dPlan]);
  ok(r.rows.length === 2, 'approve: approve/unapprove in the draft history');

  // Owner of a draft must be able to plan in its school.
  r = await call(P.ADMIN, `update public.drafts set owner_email = $2 where id = $1`, [ID.dPlan, P.FAC]);
  ok(err(r), 'drafts: faculty cannot be a draft owner');
  r = await call(P.ADMIN, `update public.drafts set owner_email = $2 where id = $1`, [ID.dPlan, P.OTHER]);
  ok(err(r), 'drafts: another school\'s admin cannot own a CMSRU draft');
  r = await call(P.ADMIN, `insert into public.drafts (id, title, owner_email) values ($1, 'CMSRU spare', $2)`, [CD, P.ADMIN]);
  ok(!err(r), 'drafts: CMSRU admin makes another draft', r.error);
  r = await call(P.ADMIN, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, 1, $2)`, [CD, ID.sDecl]);
  ok(err(r), 'drafts: a trashed category cannot go into a draft');

  // Adapted copies.
  r = await call(P.ADMIN, `select payload from public.submissions where id = $1`, [ID.sNew]);
  const copy = JSON.parse(JSON.stringify(r.rows[0].payload));
  copy.name = 'Clubbing, adapted'; copy.items[0].info.image = `drafts/${ID.dPlan}/new.webp`; copy.items[2].label = 'Tetralogy of Fallot';
  const setAdapted = (who, a) => call(who, `update public.draft_slots set adapted = $3::jsonb where draft_id = $1 and tier = $2 returning tier`, [ID.dPlan, 1, a && JSON.stringify(a)]);
  r = await setAdapted(P.FAC, copy);
  ok(err(r) || r.rows.length === 0, 'adapt: faculty cannot adapt');
  r = await setAdapted(P.ADMIN, Object.assign({}, copy, { items: copy.items.slice(0, 3) }));
  ok(err(r), 'adapt: a copy needs 4 clues');
  const foreign = JSON.parse(JSON.stringify(copy)); foreign.items[1].info.image = `drafts/${TD}/theirs.webp`;
  r = await setAdapted(P.ADMIN, foreign);
  ok(err(r), 'adapt: cannot point at another draft\'s images');
  r = await setAdapted(P.ADMIN, copy);
  ok(!err(r) && r.rows.length === 1, 'adapt: CMSRU admin saves an adapted copy (new image + changed clue)', r.error);
  r = await call(P.ADMIN, `select submission_id, adapted ->> 'name' n from public.draft_slots where draft_id = $1 and tier = 1`, [ID.dPlan]);
  ok(r.rows[0]?.submission_id === ID.sNew && r.rows[0]?.n === 'Clubbing, adapted', 'adapt: slot keeps the source and the copy');
  r = await call(P.ADMIN, `select school from public.review_events where submission_id = $1 and action = 'adapt'`, [ID.sNew]);
  ok(r.rows.length === 1 && r.rows[0].school === 'cmsru', 'adapt: logged, private to CMSRU');
  r = await call(P.OTHER, `select 1 from public.review_events where submission_id = $1 and action in ('adapt', 'add_to_draft') and school = 'cmsru'`, [ID.sNew]);
  ok(r.rows.length === 0, 'adapt: the test school does not see CMSRU draft lines on a shared category');

  // Images for copies: drafts/<draft id>/... in the private bucket.
  await as(db, 'postgres', `insert into storage.objects (bucket_id, name) values ('submissions', $1)`, [ID.sNew + '/c0-info.webp']);
  const up = (who, name) => call(who, `insert into storage.objects (bucket_id, name) values ('submissions', $1)`, [name]);
  r = await up(P.ADMIN, `drafts/${ID.dPlan}/new.webp`);
  ok(!err(r), 'storage: CMSRU admin uploads an image for a CMSRU draft', r.error);
  ok(err(await up(P.OTHER, `drafts/${ID.dPlan}/evil.webp`)), 'storage: other school cannot upload into a CMSRU draft');
  ok(err(await up(P.FAC, `drafts/${ID.dPlan}/fac.webp`)), 'storage: faculty cannot upload');
  ok(err(await up(P.ADMIN, `drafts/${TD}/x.webp`)), 'storage: CMSRU admin cannot upload into the test school draft');
  ok(err(await up(P.ADMIN, `${ID.sNew}/c9-info.webp`)), 'storage: nobody uploads over student originals');
  ok(err(await up(P.ADMIN, `drafts/not-a-uuid/x.webp`)), 'storage: bad draft path refused');
  const read = async (who, name) => (await call(who, `select 1 from storage.objects where bucket_id = 'submissions' and name = $1`, [name])).rows.length;
  ok(await read(P.FAC, `drafts/${ID.dPlan}/new.webp`) === 1, 'storage: faculty reads own school draft images');
  ok(await read(P.OTHER, `drafts/${ID.dPlan}/new.webp`) === 0, 'storage: other school cannot read CMSRU draft images');
  ok(await read(P.OWNER, `drafts/${ID.dPlan}/new.webp`) === 1, 'storage: owner reads draft images');
  ok(await read(P.OTHER, ID.sNew + '/c0-info.webp') === 1, 'storage: every member reads category originals');
  ok(await read('anon', ID.sNew + '/c0-info.webp') === 0, 'storage: the public key reads no images');
  ok(await read(P.STRANGER, ID.sNew + '/c0-info.webp') === 0, 'storage: a signed-in stranger reads no images');
}
export async function checkCommentsVotes(db, ok, ID, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  const say = (who, body, vis, school) => call(who,
    `insert into public.comments (target_type, target_id, body, visibility, school) values ('submission', $1, $2, $3, $4) returning school, visibility`,
    [ID.s6, body, vis || null, school || null]);
  let r = await say(P.ADMIN, 'For everyone: nice category', 'all');
  ok(!err(r) && r.rows[0]?.visibility === 'all' && r.rows[0]?.school === 'cmsru', 'comments: CMSRU admin posts an all-schools comment', r.error);
  r = await say(P.LEAD, 'CMSRU only: we used this last year');
  ok(!err(r) && r.rows[0]?.visibility === 'school', 'comments: default is the school setting (my school only)', r.error);
  r = await say(P.LEAD, 'Pretending to be the test school', 'school', TEST_SCHOOL);
  ok(!err(r) && r.rows[0]?.school === 'cmsru', 'comments: cannot post as a school you are not in');
  r = await call(P.OTHER, `select body from public.comments where target_id = $1`, [ID.s6]);
  ok(r.rows.length === 1 && r.rows[0].body.startsWith('For everyone'), 'comments: other school sees only the all-schools one');
  r = await call(P.OTHER, `select note from public.review_events where submission_id = $1 and action = 'comment'`, [ID.s6]);
  ok(r.rows.length === 1 && r.rows[0].note.startsWith('For everyone'), 'comments: school-only text does not leak through the history');
  r = await call(P.OTHER, `select note from public.activity where submission_id = $1 and action = 'comment'`, [ID.s6]);
  ok(r.rows.length === 1, 'comments: nor through the activity feed');
  r = await call(P.FAC, `select count(*)::int n from public.comments where target_id = $1`, [ID.s6]);
  ok(r.rows[0]?.n === 3, 'comments: CMSRU sees all three');
  r = await call(P.OWNER, `select count(*)::int n from public.comments`);
  const ownerSees = r.rows[0]?.n;
  r = await as(db, 'postgres', `select count(*)::int n from public.comments`);
  ok(ownerSees === r.rows[0]?.n, 'comments: owner sees every comment');
  r = await call(P.ADMIN, `update public.comments set visibility = 'all' where body like 'CMSRU only%' returning visibility`);
  ok(err(r) || r.rows.every((x) => x.visibility === 'school'), 'comments: visibility cannot be changed after posting');
  r = await call(P.OTHER, `insert into public.comments (target_type, target_id, body) values ('draft', $1, 'hi')`, [ID.dPlan]);
  ok(err(r), 'comments: other school cannot comment on a CMSRU draft');
  // School settings: lead changes the default; admins and other schools cannot.
  r = await call(P.OTHER, `update public.school_settings set comment_default = 'all' where school = $1 returning school`, [TEST_SCHOOL]);
  ok(err(r) || r.rows.length === 0, 'settings: an admin cannot change school settings');
  r = await call(P.LEAD, `update public.school_settings set comment_default = 'all' where school = $1 returning school`, [TEST_SCHOOL]);
  ok(err(r) || r.rows.length === 0, 'settings: CMSRU lead cannot change the test school settings');
  r = await call(P.OTHERLEAD, `update public.school_settings set comment_default = 'all', faculty_badge = false where school = $1 returning updated_by`, [TEST_SCHOOL]);
  ok(!err(r) && r.rows[0]?.updated_by === P.OTHERLEAD, 'settings: test-school lead changes its own settings', r.error);
  r = await say(P.OTHER, 'Test school default now all');
  ok(!err(r) && r.rows[0]?.visibility === 'all', 'comments: new default applies to that school');
  r = await call(P.ADMIN, `update public.site_settings set trash_retention_days = 30 returning id`);
  ok(err(r) || r.rows.length === 0, 'settings: only the owner sets Trash retention');

  // Votes carry the voter's school.
  r = await call(P.OTHER, `insert into public.votes (submission_id) values ($1) returning school, voter_email`, [ID.sNew]);
  ok(!err(r) && r.rows[0]?.school === TEST_SCHOOL && r.rows[0]?.voter_email === P.OTHER, 'votes: stamped with the voter\'s school', r.error);
  r = await call(P.OTHER, `insert into public.votes (submission_id) values ($1)`, [ID.sNew]);
  ok(err(r), 'votes: still one per person');
  r = await call(P.ADMIN, `select count(*)::int total, count(*) filter (where school = 'cmsru')::int mine, count(distinct school)::int schools from public.votes where submission_id = $1`, [ID.sNew]);
  ok(r.rows[0]?.total === 3 && r.rows[0]?.mine === 2 && r.rows[0]?.schools === 2, 'votes: all / my school / # schools countable', JSON.stringify(r.rows[0]));
}
const CD2 = '00000000-0000-4000-9000-0000000000c2';

export async function checkPublishUsage(db, ok, ID, P, testSub) {
  const call = (who, sql, p) => as(db, who, sql, p);
  const fill = async (d, ids) => { for (let t = 1; t <= 4; t++) {
    const r = await call(P.ADMIN, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, $2, $3)`, [d, t, ids[t - 1]]);
    if (err(r)) ok(false, 'setup: fill ' + d + ' tier ' + t, r.error); } };
  let r = await call(P.ADMIN, `update public.draft_slots set submission_id = $2 where draft_id = $1 and tier = 3`, [ID.dPlan, ID.s7]);
  ok(!err(r), 'setup: swap the trashed category out of the CMSRU draft', r.error);
  await fill(CD, [ID.s8, ID.sUsed, ID.s6, testSub]);
  r = await call(P.ADMIN, `update public.drafts set status = 'ready' where id = $1`, [CD]);
  r = await call(P.ADMIN, `insert into public.drafts (id, title, owner_email) values ($1, 'CMSRU later', $2)`, [CD2, P.LEAD]);
  ok(!err(r), 'setup: a lead can own a draft', r.error);
  await fill(CD2, [ID.sNew, ID.sUsed, ID.s7, testSub]);
  r = await call(P.ADMIN, `update public.drafts set status = 'scheduled', target_release = '2026-10-29T10:00:00Z' where id = $1`, [CD2]);
  ok(!err(r), 'setup: second CMSRU draft scheduled', r.error);

  // Cross-school calendar: name and day only.
  r = await call(P.ADMIN, `select * from public.other_school_releases('2026-10-01', '2026-11-30')`);
  ok(!err(r) && r.rows.length === 1 && Object.keys(r.rows[0]).sort().join() === 'release_date,school_name'
    && r.rows[0].school_name === 'Test School of Medicine', 'calendar: CMSRU sees only "Test School, a date"', r.error || JSON.stringify(r.rows));
  r = await call(P.OTHER, `select school_name, release_date::text d from public.other_school_releases('2026-10-01', '2026-11-30')`);
  ok(r.rows.length === 2 && r.rows.every((x) => x.school_name === 'Cooper Medical School of Rowan University') && r.rows[0].d === '2026-10-22',
    'calendar: test school sees CMSRU\'s two release days, nothing else', JSON.stringify(r.rows));
  ok(err(await call('anon', `select * from public.other_school_releases('2026-10-01', '2026-11-30')`)), 'calendar: public key refused');
  ok(err(await call(P.STRANGER, `select * from public.other_school_releases('2026-10-01', '2026-11-30')`)), 'calendar: non-member refused');
  ok(err(await call(P.ADMIN, `select * from public.other_school_releases('2026-01-01', '2027-12-31')`)), 'calendar: huge ranges refused');

  // Publish the CMSRU draft (robot).
  r = await call('service', `update public.drafts set status = 'published', published_puzzle_id = 'next-week-2026-10-22' where id = $1`, [ID.dPlan]);
  ok(!err(r), 'publish: robot publishes the CMSRU draft', r.error);
  r = await call('postgres', `select submission_id, school, adapted, puzzle_date::text d from public.category_uses where draft_id = $1`, [ID.dPlan]);
  ok(r.rows.length === 4 && r.rows.every((u) => u.school === 'cmsru' && u.d === '2026-10-22'), 'publish: one usage row per category', JSON.stringify(r.rows));
  ok(r.rows.find((u) => u.submission_id === ID.sNew)?.adapted === true && r.rows.filter((u) => u.adapted).length === 1, 'publish: the adapted slot is marked adapted');
  r = await call('postgres', `select status from public.submissions where id = $1`, [ID.sNew]);
  ok(r.rows[0]?.status === 'used', 'publish: categories marked Used (old rule kept)');
  r = await call('postgres', `select id, status from public.drafts where id in ($1, $2, $3)`, [CD, CD2, TD]);
  const st = Object.fromEntries(r.rows.map((d) => [d.id, d.status]));
  ok(st[CD] === 'planning', 'publish: CMSRU Ready draft that lost a category -> Planning (old rule)');
  ok(st[CD2] === 'ready', 'publish: CMSRU Scheduled draft that lost a category -> Ready (old rule)');
  ok(st[TD] === 'scheduled', 'publish: the test school\'s draft keeps the shared category and its schedule');
  r = await call('postgres', `select count(*)::int n from public.draft_slots where draft_id = $1 and submission_id = $2`, [TD, ID.sNew]);
  ok(r.rows[0]?.n === 1, 'publish: shared category still in the other school\'s draft');
  r = await call(P.LEAD, `select notify_email from public.draft_events where draft_id = $1 and action = 'lost_slot'`, [CD2]);
  ok(r.rows[0]?.notify_email === P.LEAD, 'publish: the owner of a draft that lost a slot is told');

  const usage = async (who) => (await call(who, `select * from public.category_usage where submission_id = $1`, [ID.sNew])).rows[0];
  let u = await usage(P.ADMIN);
  ok(u && u.times_used === 1 && u.adapted === 1 && u.as_is === 0 && u.schools.join() === 'cmsru' && u.drafts_count === 0,
    'usage: CMSRU sees used 1x (adapted), in 0 of its drafts', JSON.stringify(u));
  u = await usage(P.OTHER);
  ok(u && u.times_used === 1 && u.drafts_count === 1, 'usage: test school sees the same use and its own draft', JSON.stringify(u));
  r = await call('service', `update public.drafts set status = 'published', published_puzzle_id = 'test-week-1-2026-10-22' where id = $1`, [TD]);
  ok(!err(r), 'publish: the test school publishes too', r.error);
  u = await usage(P.OWNER);
  ok(u && u.times_used === 2 && u.as_is === 1 && u.adapted === 1 && u.schools.join() === 'cmsru,test-school' && u.drafts_count === 0,
    'usage: used 2x (1 as-is, 1 adapted) by 2 schools', JSON.stringify(u));
  ok((await usage(P.STRANGER)) === undefined, 'usage: non-members see nothing');
}
export async function checkPurgeAndAnon(db, ok, ID, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  // Four trashed categories: old, recent, old-but-used, old-but-in-a-draft.
  const mk = async (tag) => (await call('service', `insert into public.submissions (group_name, payload, credit_mode, consent, receipt_code)
    values ($1, $2, 'anonymous', true, $3) returning id`,
    [tag, JSON.stringify({ name: tag, items: [] }), 'DP-PURG-' + tag.toUpperCase().padEnd(4, 'X').slice(0, 4)])).rows[0].id;
  const old = await mk('old'), recent = await mk('rcnt'), used = await mk('used'), inDraft = await mk('drft');
  await call(P.ADMIN, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, 1, $2)`, [CD, inDraft]);
  for (const id of [old, recent, used, inDraft]) await call(P.ADMIN, `select public.trash_submission($1, 'junk')`, [id]);
  await call('postgres', `update public.submissions set trashed_at = now() - interval '40 days' where id in ($1, $2, $3)`, [old, used, inDraft]);
  await call('postgres', `update public.submissions set trashed_at = now() - interval '10 days' where id = $1`, [recent]);
  await call('postgres', `insert into public.category_uses (submission_id, school, puzzle_id, adapted) values ($1, 'cmsru', 'x-2026-01-01', false)`, [used]);
  let r = await call('service', `select private.purge_trash() n`);
  ok(!err(r) && r.rows[0].n === 0, 'purge: does nothing while the setting is Never', r.error);
  ok(err(await call(P.ADMIN, `select private.purge_trash()`)), 'purge: website users cannot run it');
  r = await call(P.OWNER, `update public.site_settings set trash_retention_days = 30 returning trash_retention_days`);
  ok(!err(r) && r.rows[0]?.trash_retention_days === 30, 'settings: owner sets Trash retention to 30 days', r.error);
  r = await call('service', `select private.purge_trash() n`);
  ok(!err(r) && r.rows[0].n === 1, 'purge: deletes exactly one (old, unused, in no draft)', r.error || String(r.rows[0]?.n));
  r = await call('postgres', `select id from public.submissions where id in ($1, $2, $3, $4)`, [old, recent, used, inDraft]);
  const left = r.rows.map((x) => x.id);
  ok(!left.includes(old) && left.includes(recent) && left.includes(used) && left.includes(inDraft), 'purge: keeps recent, used, and in-draft ones');

  // Activity, per school.
  r = await call(P.OTHER, `select subject, action, school from public.activity`);
  ok(r.rows.length > 0 && !r.rows.some((x) => x.subject !== 'submission' && x.school === 'cmsru'), 'activity: test school sees no CMSRU draft or people lines');
  ok(!r.rows.some((x) => x.school_only && x.school === 'cmsru'), 'activity: nor CMSRU school-only lines');
  r = await call(P.OWNER, `select distinct action from public.activity`);
  const acts = r.rows.map((x) => x.action);
  ok(['trash', 'restore', 'edit', 'undo_edit', 'adapt', 'approve', 'member_add', 'member_role', 'member_move', 'member_remove', 'lost_slot']
    .every((a) => acts.includes(a)), 'activity: owner sees the new kinds of lines', acts.join(','));
  r = await call(P.OWNER, `select count(distinct school)::int n from public.activity where subject = 'draft'`);
  ok(r.rows[0]?.n === 2, 'activity: owner sees both schools\' drafts');

  // The public key and signed-in strangers read nothing private.
  r = await call('postgres', `select table_name from information_schema.tables where table_schema = 'public' order by 1`);
  const tables = r.rows.map((x) => x.table_name).filter((t) => t !== 'puzzle_stats');
  let anonLeaks = [], strangerLeaks = [];
  for (const t of tables) {
    const a = await call('anon', `select count(*)::int n from public."${t}"`);
    if (!a.error && a.rows[0].n > 0) anonLeaks.push(t);
    const s = await call(P.STRANGER, `select count(*)::int n from public."${t}"`);
    if (!s.error && s.rows[0].n > 0) strangerLeaks.push(t);
  }
  ok(anonLeaks.length === 0, `anon: reads nothing from ${tables.length} tables/views`, anonLeaks.join(','));
  ok(strangerLeaks.length === 0, 'stranger: a signed-in non-member reads nothing either', strangerLeaks.join(','));
  const rpcs = [
    `select public.add_member('a@b.co', 'cmsru', 'admin')`, `select public.change_role('a@b.co', 'cmsru', 'lead')`,
    `select public.move_school('a@b.co', 'cmsru', 'test-school')`, `select public.set_member_active('a@b.co', 'cmsru', true)`,
    `select public.set_my_profile('x', null)`, `select public.trash_submission('${ID.sNew}')`, `select public.restore_submission('${ID.sNew}')`,
    `select public.edit_submission('${ID.sNew}', '{"name":"x"}')`, `select public.approve_draft('${CD}')`,
    `select * from public.member_names()`, `select private.purge_trash()`, `select private.is_member()`];
  const opened = [];
  for (const q of rpcs) if (!(await call('anon', q)).error) opened.push(q);
  ok(opened.length === 0, 'anon: every new function refuses the public key', opened.join(' | '));
  ok(err(await call('anon', `insert into public.comments (target_type, target_id, body) values ('submission', '${ID.sNew}', 'x')`)), 'anon: cannot comment');
  ok(err(await call(P.STRANGER, `select public.trash_submission('${ID.sUsed}')`)), 'stranger: cannot trash');
  ok(err(await call(P.STRANGER, `insert into public.drafts (title, owner_email, school) values ('x', '${P.STRANGER}', 'cmsru')`)), 'stranger: cannot make drafts');
}
