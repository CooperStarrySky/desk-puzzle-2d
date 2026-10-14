// Checks for multischool.test.mjs, part 2: two schools, people, sign-up hook,
// Trash, and fixing originals.
import { as } from './db_harness.mjs';

export const TEST_SCHOOL = 'test-school';

export async function setupSchools(db, P) {
  await db.query(`insert into public.schools (slug, name, status) values ($1, 'Test School of Medicine', 'active')`, [TEST_SCHOOL]);
  await db.query(`insert into public.site_owners (email) values ($1)`, [P.OWNER]);
  await db.query(`insert into public.members (email, school, role, added_by) values
    ($1, 'cmsru', 'lead', 'test'), ($2, 'cmsru', 'faculty', 'test'), ($3, $5, 'admin', 'test'), ($4, $5, 'lead', 'test')`,
    [P.LEAD, P.FAC, P.OTHER, P.OTHERLEAD, TEST_SCHOOL]);
}

const err = (r) => !!r.error;

export async function checkPeople(db, ok, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  let r = await as(db, 'postgres', `select count(*)::int n from public.school_settings where school = $1`, [TEST_SCHOOL]);
  ok(r.rows[0].n === 1, 'schools: a new school gets its settings row');

  r = await call(P.LEAD, `select public.add_member('new.admin@example.edu', 'cmsru', 'admin', 'New A.')`);
  ok(!err(r), 'people: lead adds an admin to own school', r.error);
  r = await call(P.LEAD, `select public.add_member('new.lead@example.edu', 'cmsru', 'lead')`);
  ok(err(r), 'people: lead cannot create a lead');
  r = await call(P.LEAD, `select public.add_member('x@example.edu', $1, 'admin')`, [TEST_SCHOOL]);
  ok(err(r), 'people: lead cannot add people to another school');
  r = await call(P.LEAD, `select public.change_role($1, 'cmsru', 'admin')`, [P.FAC]);
  ok(!err(r), 'people: lead changes faculty -> admin', r.error);
  r = await call(P.LEAD, `select public.change_role($1, 'cmsru', 'faculty')`, [P.FAC]);
  ok(!err(r), 'people: and back to faculty', r.error);
  r = await call(P.LEAD, `select public.change_role($1, 'cmsru', 'lead')`, [P.ADMIN]);
  ok(err(r), 'people: lead cannot promote someone to lead');
  r = await call(P.LEAD, `select public.set_member_active($1, $2, false)`, [P.OTHER, TEST_SCHOOL]);
  ok(err(r), 'people: lead cannot remove someone at another school');
  r = await call(P.OTHERLEAD, `select public.set_member_active($1, 'cmsru', false)`, [P.LEAD]);
  ok(err(r), 'people: other school\'s lead cannot touch CMSRU');
  r = await call(P.ADMIN, `select public.add_member('y@example.edu', 'cmsru', 'faculty')`);
  ok(err(r), 'people: an admin cannot manage people');
  r = await call(P.FAC, `select public.add_member('y@example.edu', 'cmsru', 'faculty')`);
  ok(err(r), 'people: faculty cannot manage people');
  r = await call(P.LEAD, `insert into public.members (email, school, role) values ('z@example.edu', 'cmsru', 'lead')`);
  ok(err(r), 'people: nobody inserts into members directly');
  r = await call(P.LEAD, `select public.move_school('new.admin@example.edu', 'cmsru', $1)`, [TEST_SCHOOL]);
  ok(err(r), 'people: only the owner moves people between schools');
  r = await call(P.OWNER, `select public.move_school('new.admin@example.edu', 'cmsru', $1)`, [TEST_SCHOOL]);
  ok(!err(r), 'people: owner moves someone to another school', r.error);
  r = await call(P.OWNER, `select public.add_member('lead2@example.edu', $1, 'lead')`, [TEST_SCHOOL]);
  ok(!err(r), 'people: owner adds a school lead', r.error);

  // Removing access takes effect at once; restoring brings it back.
  r = await call(P.LEAD, `select public.set_member_active($1, 'cmsru', false)`, [P.ADMIN2]);
  ok(!err(r), 'people: lead removes an admin\'s access', r.error);
  r = await call(P.ADMIN2, `select count(*)::int n from public.submissions`);
  ok(!err(r) && r.rows[0].n === 0, 'people: removed admin reads nothing');
  r = await call('auth', `select private.hook_signup_admins_only(jsonb_build_object('user', jsonb_build_object('email', $1::text))) h`, [P.ADMIN2]);
  ok(!err(r) && r.rows[0].h.error, 'hook: removed member cannot sign up', r.error);
  r = await call(P.LEAD, `select public.set_member_active($1, 'cmsru', true)`, [P.ADMIN2]);
  ok(!err(r), 'people: lead restores access', r.error);
  r = await call(P.ADMIN2, `select count(*)::int n from public.submissions`);
  ok(r.rows[0]?.n > 0, 'people: restored admin reads again');

  const hook = async (email) => (await call('auth',
    `select private.hook_signup_admins_only(jsonb_build_object('user', jsonb_build_object('email', $1::text))) h`, [email]));
  r = await hook(P.LEAD.toUpperCase());
  ok(!err(r) && JSON.stringify(r.rows[0].h) === '{}', 'hook: an active member may sign up (case ignored)', r.error);
  r = await hook(P.OTHER);
  ok(!err(r) && JSON.stringify(r.rows[0].h) === '{}', 'hook: a member of another school may sign up');
  r = await hook(P.OWNER);
  ok(!err(r) && JSON.stringify(r.rows[0].h) === '{}', 'hook: the site owner may sign up');
  r = await hook(P.STRANGER);
  ok(!err(r) && r.rows[0].h.error?.http_code === 403, 'hook: a stranger is refused');
  r = await call(P.LEAD, `select private.hook_signup_admins_only('{}'::jsonb)`);
  ok(err(r), 'hook: website users cannot call the hook');

  r = await call(P.OTHER, `select email from public.members where school = 'cmsru'`);
  ok(!err(r) && r.rows.length === 0, 'people: other school cannot list CMSRU\'s members table');
  r = await call(P.OTHER, `select email, schools from public.member_names()`);
  ok(!err(r) && r.rows.some((x) => x.email === P.ADMIN), 'people: but sees names for avatars via member_names()');
  r = await call(P.STRANGER, `select * from public.member_names()`);
  ok(!err(r) && r.rows.length === 0, 'people: a stranger gets no names');
  r = await call(P.OTHER, `select action from public.member_events where school = 'cmsru'`);
  ok(r.rows.length === 0, 'people: other school does not see CMSRU people changes');
  r = await call(P.FAC, `select action from public.member_events where school = 'cmsru'`);
  ok(r.rows.some((x) => x.action === 'member_remove') && r.rows.some((x) => x.action === 'member_role'), 'people: CMSRU sees its people changes');
}

export async function checkTrash(db, ok, ID, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  let r = await call(P.FAC, `select public.trash_submission($1, 'junk')`, [ID.s8]);
  ok(err(r), 'trash: faculty cannot trash');
  r = await call(P.FAC, `update public.submissions set status = 'trashed' where id = $1 returning id`, [ID.s8]);
  ok(err(r) || r.rows.length === 0, 'trash: faculty cannot trash by direct update either');
  r = await call(P.ADMIN, `select public.trash_submission($1, 'duplicate')`, [ID.s8]);
  ok(!err(r), 'trash: CMSRU admin trashes', r.error);
  r = await call(P.ADMIN, `select status, trashed_by, trash_reason from public.submissions where id = $1`, [ID.s8]);
  ok(r.rows[0]?.status === 'trashed' && r.rows[0].trashed_by === P.ADMIN && r.rows[0].trash_reason === 'duplicate', 'trash: stamped who and why');
  r = await call(P.ADMIN, `update public.submissions set trash_reason = 'x' where id = $1 returning trashed_by`, [ID.s8]);
  ok(!err(r), 'trash: reason can be edited');
  r = await call(P.ADMIN, `select action, note from public.review_events where submission_id = $1 and action = 'trash'`, [ID.s8]);
  ok(r.rows.length === 1 && r.rows[0].note === 'duplicate', 'trash: logged in history');
  r = await call(P.OTHER, `select public.restore_submission($1)`, [ID.s8]);
  ok(!err(r), 'trash: an admin of ANOTHER school can restore (bank-wide)', r.error);
  r = await call(P.OTHER, `select status, trashed_by from public.submissions where id = $1`, [ID.s8]);
  ok(r.rows[0]?.status === 'new' && r.rows[0].trashed_by === null, 'trash: restored to New, trash stamp cleared');
  r = await call(P.OTHER, `select action from public.review_events where submission_id = $1 and action = 'restore'`, [ID.s8]);
  ok(r.rows.length === 1, 'trash: restore logged');
  r = await call(P.ADMIN, `select public.trash_submission($1)`, [ID.sUsed]);
  r = await call(P.ADMIN, `select public.restore_submission($1)`, [ID.sUsed]);
  r = await call(P.ADMIN, `select status from public.submissions where id = $1`, [ID.sUsed]);
  ok(r.rows[0]?.status === 'used', 'trash: a used category restores to Used');
  r = await as(db, 'postgres', `insert into public.review_events (submission_id, action) values ($1, 'shortlist')`, [ID.s8]);
  ok(err(r), 'trash: no new shortlist history lines');
  r = await call(P.ADMIN, `update public.submissions set status = 'shortlisted' where id = $1`, [ID.s8]);
  ok(err(r), 'trash: shortlisted is no longer a status');
  r = await as(db, 'service', `insert into public.submissions (kind, group_name, payload, credit_mode, consent, receipt_code)
    values ('puzzle', 'P', '{}', 'anonymous', true, 'DP-PUZZ-0001')`);
  ok(err(r), 'submit: new full-puzzle suggestions are refused');
  r = await as(db, 'service', `insert into public.submissions (kind, group_name, payload, credit_mode, consent, receipt_code, school)
    values ('category', 'Test-school category', $1, 'anonymous', true, 'DP-TEST-0002', $2) returning id`,
    [JSON.stringify({ name: 'Test-school category', explanation: 'e', items: [1, 2, 3, 4].map((i) => ({ label: 'Clue ' + i, info: { title: 'Clue ' + i } })) }), TEST_SCHOOL]);
  ok(!err(r), 'submit: new single categories still go in', r.error);
  return r.rows[0]?.id;
}

export async function checkEdits(db, ok, ID, P, testSub) {
  const call = (who, sql, p) => as(db, who, sql, p);
  const edit = (who, id, patch) => call(who, `select public.edit_submission($1, $2::jsonb) n`, [id, JSON.stringify(patch)]);
  let r = await edit(P.OTHER, ID.sNew, { name: 'Hijacked' });
  ok(err(r), 'edit: another school\'s admin cannot fix CMSRU\'s original');
  r = await edit(P.FAC, ID.sNew, { name: 'Faculty fix' });
  ok(err(r), 'edit: faculty cannot fix originals');
  r = await edit(P.ADMIN, ID.sNew, { name: 'Causes of digital clubbing', 'items.1.label': 'Bronchiectasis (any cause)', 'items.0.note': 'Paraneoplastic' });
  ok(!err(r) && r.rows[0].n === 3, 'edit: CMSRU admin fixes 3 fields', r.error);
  r = await call(P.ADMIN, `select group_name, payload from public.submissions where id = $1`, [ID.sNew]);
  const s = r.rows[0];
  ok(s?.group_name === 'Causes of digital clubbing' && s.payload.name === 'Causes of digital clubbing', 'edit: name and group_name both changed');
  ok(s?.payload.items[1].info.title === 'Bronchiectasis (any cause)', 'edit: clue label keeps info.title in step');
  r = await call(P.OTHER, `select id from public.submissions where search @@ websearch_to_tsquery('english', 'digital')`);
  ok(r.rows.some((x) => x.id === ID.sNew), 'edit: search finds the new wording');
  r = await call(P.OTHER, `select id from public.submissions where search @@ websearch_to_tsquery('english', 'paraneoplastic')`);
  ok(r.rows.some((x) => x.id === ID.sNew), 'edit: search finds the new clue note');
  r = await edit(P.ADMIN, ID.sNew, { 'items.0.image': 'x' });
  ok(err(r), 'edit: only text fields can be edited');
  r = await edit(P.ADMIN, ID.sNew, { 'items.2.label': 'x'.repeat(81) });
  ok(err(r), 'edit: Studio length limits apply');
  r = await edit(P.ADMIN, ID.sNew, { 'items.7.label': 'x' });
  ok(err(r), 'edit: no such clue');
  r = await call(P.OTHER, `select path, editor_email from public.submission_edits where submission_id = $1`, [ID.sNew]);
  ok(r.rows.length === 3, 'edit: history readable by every member');
  r = await call(P.ADMIN, `select id from public.submission_edits where submission_id = $1 and path = 'items.1.label'`, [ID.sNew]);
  const labelEdit = r.rows[0]?.id;
  r = await call(P.OTHER, `select public.undo_submission_edit($1)`, [labelEdit]);
  ok(err(r), 'undo: another school cannot undo');
  r = await call(P.LEAD, `select public.undo_submission_edit($1)`, [labelEdit]);
  ok(!err(r), 'undo: CMSRU lead undoes the label fix', r.error);
  r = await call(P.LEAD, `select payload -> 'items' -> 1 ->> 'label' l, payload -> 'items' -> 1 -> 'info' ->> 'title' t from public.submissions where id = $1`, [ID.sNew]);
  ok(r.rows[0]?.l === 'Bronchiectasis' && r.rows[0]?.t === 'Bronchiectasis', 'undo: label is back');
  r = await call(P.LEAD, `select public.undo_submission_edit($1)`, [labelEdit]);
  ok(err(r), 'undo: cannot undo twice');
  r = await call(P.ADMIN, `select id from public.submission_edits where submission_id = $1 and path = 'name'`, [ID.sNew]);
  const nameEdit = r.rows[0]?.id;
  await edit(P.OWNER, ID.sNew, { name: 'Causes of clubbing (owner)' });
  r = await call(P.ADMIN, `select public.undo_submission_edit($1)`, [nameEdit]);
  ok(err(r), 'undo: refused when the field changed again since');
  r = await call(P.ADMIN, `select public.undo_submission_edit(id) from public.submission_edits where submission_id = $1 and path = 'name' and editor_email = $2`, [ID.sNew, P.OWNER]);
  ok(!err(r), 'undo: newest first works (owner edit undone by CMSRU admin)', r.error);
  r = await call(P.ADMIN, `select public.undo_submission_edit($1)`, [nameEdit]);
  ok(!err(r), 'undo: then the older one', r.error);
  r = await call(P.ADMIN, `select group_name from public.submissions where id = $1`, [ID.sNew]);
  ok(r.rows[0]?.group_name === 'Causes of clubbing', 'undo: name fully restored');
  r = await call(P.ADMIN, `select count(*)::int n from public.review_events where submission_id = $1 and action in ('edit', 'undo_edit')`, [ID.sNew]);
  ok(r.rows[0]?.n === 5, 'edit: edits and undos are in the history', String(r.rows[0]?.n));
  r = await edit(P.OTHER, testSub, { explanation: 'Fixed by its own school' });
  ok(!err(r), 'edit: test-school admin fixes its own school\'s original', r.error);
  r = await edit(P.ADMIN, testSub, { explanation: 'CMSRU meddling' });
  ok(err(r), 'edit: CMSRU admin cannot fix the test school\'s original');
  r = await call(P.ADMIN, `update public.submissions set payload = '{}' where id = $1 returning id`, [ID.sNew]);
  ok(err(r), 'edit: payload cannot be overwritten directly');
}
