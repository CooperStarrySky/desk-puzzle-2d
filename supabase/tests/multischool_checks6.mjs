// Checks for multischool.test.mjs, part 6: 20261015120000_live_sync.sql.
// Live syncing: who may join which private Realtime channel (the row rules on
// realtime.messages, asked the way Realtime asks them: with the channel topic
// set), what the database sends after a change (small notes, no content), and
// that a broken Realtime never blocks a save.
import { as, userId } from './db_harness.mjs';
import { TEST_SCHOOL } from './multischool_checks2.mjs';

const err = (r) => !!r.error;
const BANK = 'ws:bank', CMSRU = 'ws:school:cmsru', TEST = 'ws:school:' + TEST_SCHOOL;

/* Runs sql as someone with realtime.topic set, like Realtime's own join check. */
export async function rt(db, who, topic, sql, params = []) {
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
      if (who !== 'postgres') {
        const role = who === 'anon' ? 'anon' : 'authenticated';
        const claims = role === 'authenticated' ? { email: who, role, sub: userId(who) } : { role };
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await tx.exec(`set local role ${role}`);
      }
      return (await tx.query(sql, params)).rows;
    });
    return { rows, error: null };
  } catch (e) { return { rows: [], error: e.message || String(e) }; }
}
/* May `who` receive `ext` messages on `topic`? (A probe row exists per topic.) */
export async function canHear(db, who, topic, ext = 'broadcast') {
  const r = await rt(db, who, topic, `select count(*)::int n from realtime.messages where topic = $1 and extension = $2`, [topic, ext]);
  return !r.error && r.rows[0].n > 0;
}
/* May `who` publish `ext` on `topic`? (A probe that gets in is removed again.) */
export async function canSend(db, who, topic, ext = 'presence') {
  const r = await rt(db, who, topic, `insert into realtime.messages (topic, extension, payload, event) values ($1, $2, '{}', 'probe') returning id`, [topic, ext]);
  if (!r.error) await db.query(`delete from realtime.messages where id = $1`, [r.rows[0].id]);
  return !r.error;
}

export async function checkLiveSync(db, ok, ID, P) {
  const call = (who, sql, p) => as(db, who, sql, p);
  // A probe row per topic and kind, so "can read" has something to find.
  for (const t of [BANK, CMSRU, TEST, 'ws:schoolXcmsru', 'ws:school:cmsru-x']) {
    for (const x of ['broadcast', 'presence']) await db.query(`insert into realtime.messages (topic, extension, payload, event) values ($1, $2, '{}', 'probe')`, [t, x]);
  }
  // ── Joining channels ──
  for (const who of [P.LEAD, P.ADMIN, P.FAC]) {
    const n = who.split('@')[0];
    ok(await canHear(db, who, BANK), 'live: ' + n + ' (CMSRU) hears the shared bank');
    ok(await canHear(db, who, CMSRU), 'live: ' + n + ' hears CMSRU notes');
    ok(await canHear(db, who, CMSRU, 'presence'), 'live: ' + n + ' sees who is online at CMSRU');
    ok(!(await canHear(db, who, TEST)), 'live: ' + n + ' cannot join the test school\'s channel');
    ok(!(await canHear(db, who, TEST, 'presence')), 'live: ' + n + ' cannot see who is online at the test school');
  }
  ok(await canHear(db, P.OTHER, TEST) && await canHear(db, P.OTHER, TEST, 'presence'), 'live: test-school admin hears its own school');
  ok(!(await canHear(db, P.OTHER, CMSRU)) && !(await canHear(db, P.OTHER, CMSRU, 'presence')), 'live: test-school admin cannot join CMSRU (private drafts, presence)');
  ok(await canHear(db, P.OTHER, BANK), 'live: test-school admin hears the shared bank');
  ok(await canHear(db, P.OWNER, CMSRU) && await canHear(db, P.OWNER, TEST) && await canHear(db, P.OWNER, BANK), 'live: the site owner hears every school');
  ok(!(await canHear(db, P.LEAD, BANK, 'presence')), 'live: no presence on the shared bank');
  ok(!(await canHear(db, P.LEAD, 'ws:schoolXcmsru')) && !(await canHear(db, P.LEAD, 'ws:school:cmsru-x')), 'live: look-alike topics are refused');
  for (const t of [BANK, CMSRU, TEST]) {
    ok(!(await canHear(db, 'anon', t)) && !(await canHear(db, 'anon', t, 'presence')), 'live: the public key cannot join ' + t);
    ok(!(await canHear(db, P.STRANGER, t)), 'live: a signed-in stranger cannot join ' + t);
  }
  // ── Publishing ──
  ok(await canSend(db, P.ADMIN, CMSRU), 'live: CMSRU admin may share presence at CMSRU');
  ok(await canSend(db, P.FAC, CMSRU), 'live: faculty may share presence at their school');
  ok(!(await canSend(db, P.OTHER, CMSRU)), 'live: test-school admin cannot share presence at CMSRU');
  ok(!(await canSend(db, P.ADMIN, CMSRU, 'broadcast')), 'live: nobody may broadcast from the page (school topic)');
  ok(!(await canSend(db, P.OWNER, BANK, 'broadcast')), 'live: nobody may broadcast from the page (bank, even the owner)');
  ok(!(await canSend(db, P.ADMIN, BANK)), 'live: no presence on the bank');
  ok(!(await canSend(db, 'anon', CMSRU)) && !(await canSend(db, 'anon', BANK, 'broadcast')), 'live: the public key cannot send anything');
  ok(!(await canSend(db, P.STRANGER, CMSRU)), 'live: a stranger cannot share presence');
  await db.query(`delete from realtime.messages where event = 'probe'`);
  await checkNotes(db, ok, ID, P, call);
}

/* What the database sends after a change. */
async function checkNotes(db, ok, ID, P, call) {
  let last = 0;
  const since = async () => {
    const r = await db.query(`select id, topic, event, payload from realtime.messages where id > $1 and extension = 'broadcast' order by id`, [last]);
    if (r.rows.length) last = Number(r.rows[r.rows.length - 1].id);
    return r.rows;
  };
  const one = (rows, topic, t) => rows.find((m) => m.topic === topic && m.payload.t === t);
  let r = await call(P.ADMIN, `insert into public.drafts (title, owner_email) values ('Live sync draft', $1) returning id`, [P.ADMIN]);
  const LD = r.rows[0]?.id;
  for (const [t, s] of [[1, ID.sNew], [2, ID.s6]]) await call(P.ADMIN, `insert into public.draft_slots (draft_id, tier, submission_id) values ($1, $2, $3)`, [LD, t, s]);
  ok(!err(r) && (await call(P.ADMIN, `select count(*)::int n from public.draft_slots where draft_id = $1`, [LD])).rows[0].n === 2, 'notes: setup draft with two slots', r.error);
  await since();

  r = await call(P.LEAD, `update public.drafts set title = 'Secret title zebra' where id = $1`, [LD]);
  let m = await since(), n = one(m, CMSRU, 'drafts');
  ok(!err(r) && n && n.event === 'change' && n.payload.op === 'update' && n.payload.by === P.LEAD && n.payload.items[0].id === LD,
    'notes: a draft rename sends a note to CMSRU only', r.error || JSON.stringify(m));
  ok(!m.some((x) => x.topic !== CMSRU), 'notes: nothing about a CMSRU draft goes to the bank or another school', JSON.stringify(m.map((x) => x.topic)));
  ok(!JSON.stringify(m).includes('zebra'), 'notes: no draft content in the note (title stays out)');

  r = await call(P.LEAD, `select public.swap_draft_slots($1, 1, 2)`, [LD]);
  m = await since(); n = one(m, CMSRU, 'draft_slots');
  ok(!err(r) && n && n.payload.items.some((i) => i.d === LD && i.t === 1) && n.payload.items.some((i) => i.t === 2), 'notes: a slot swap sends draft + tiers to CMSRU', r.error || JSON.stringify(m));

  const say = (who, body, vis) => call(who, `insert into public.comments (target_type, target_id, body, visibility) values ('submission', $1, $2, $3) returning id`, [ID.s6, body, vis]);
  r = await say(P.ADMIN, 'Private walrus remark', 'school');
  m = await since();
  ok(!err(r) && one(m, CMSRU, 'comments') && !one(m, BANK, 'comments'), 'notes: a school-only comment goes to the school, not the bank', r.error || JSON.stringify(m));
  ok(!JSON.stringify(m).includes('walrus'), 'notes: no comment text in the note');
  const cid = r.rows[0]?.id;
  r = await call(P.ADMIN, `update public.comments set body = 'Edited walrus' where id = $1`, [cid]);
  m = await since();
  ok(!err(r) && one(m, CMSRU, 'comments')?.payload.op === 'update' && !one(m, BANK, 'comments'), 'notes: editing a school-only comment stays in the school', r.error || JSON.stringify(m));
  r = await say(P.ADMIN, 'Public remark', 'all');
  m = await since();
  ok(!err(r) && one(m, BANK, 'comments') && !one(m, CMSRU, 'comments'), 'notes: an all-schools comment goes to the bank', r.error || JSON.stringify(m));
  r = await call(P.FAC, `insert into public.comments (target_type, target_id, body) values ('draft', $1, 'Draft remark') returning id`, [LD]);
  m = await since(); n = one(m, CMSRU, 'comments');
  ok(!err(r) && n && n.payload.items[0].type === 'draft' && !one(m, BANK, 'comments'), 'notes: a draft comment goes to the draft\'s school only', r.error || JSON.stringify(m));

  r = await call(P.ADMIN, `insert into public.votes (submission_id) values ($1)`, [ID.s7]);
  m = await since(); n = one(m, BANK, 'votes');
  ok(!err(r) && n && n.payload.items[0].sid === ID.s7 && n.payload.by === P.ADMIN, 'notes: a vote goes to the bank', r.error || JSON.stringify(m));
  r = await call(P.ADMIN, `delete from public.votes where submission_id = $1 and voter_email = $2`, [ID.s7, P.ADMIN]);
  m = await since();
  ok(!err(r) && one(m, BANK, 'votes')?.payload.op === 'delete', 'notes: taking a vote back goes to the bank too', r.error || JSON.stringify(m));

  r = await as(db, 'service', `insert into public.submissions (kind, group_name, payload, credit_mode, consent, receipt_code)
    values ('category', 'Live note test', $1, 'anonymous', true, 'DP-LIVE-0001') returning id`,
    [JSON.stringify({ name: 'Live note test', explanation: 'e', items: [1, 2, 3, 4].map((i) => ({ label: 'Clue ' + i, info: { title: 'Clue ' + i } })) })]);
  const sid = r.rows[0]?.id;
  m = await since(); n = one(m, BANK, 'submissions');
  ok(!err(r) && n && n.payload.op === 'insert' && n.payload.by === null, 'notes: a new category from the website goes to the bank', r.error || JSON.stringify(m));
  r = await call(P.LEAD, `select public.trash_submission($1, 'duplicate')`, [sid]);
  m = await since(); n = one(m, BANK, 'submissions');
  ok(!err(r) && n && n.payload.op === 'update' && n.payload.items[0].id === sid && n.payload.by === P.LEAD, 'notes: trashing goes to the bank, with who did it', r.error || JSON.stringify(m));
  ok(!JSON.stringify(m).includes('duplicate'), 'notes: no trash reason in the note');

  r = await call(P.OTHER, `insert into public.drafts (title, owner_email) values ('Test school live', $1) returning id`, [P.OTHER]);
  m = await since();
  ok(!err(r) && r.rows.length && one(m, TEST, 'drafts') && !m.some((x) => x.topic === CMSRU), 'notes: a test-school draft change never reaches CMSRU', r.error || JSON.stringify(m));

  r = await db.query(`insert into public.review_events (submission_id, actor_email, action, school)
    select $1, 'bulk@example.edu', 'comment', null from generate_series(1, 60)`, [sid]);
  m = await since(); n = one(m, BANK, 'review_events');
  ok(m.filter((x) => x.payload.t === 'review_events').length === 1 && n && n.payload.n === 60 && n.payload.items === null,
    'notes: a 60-row bulk change sends one note (no id list)', JSON.stringify(m.map((x) => x.payload.n)));

  // Safe failure: Realtime broken or missing never blocks a save.
  await db.exec(`alter table realtime.messages rename to messages_off`);
  r = await call(P.LEAD, `update public.drafts set title = 'Saved without Realtime' where id = $1 returning title`, [LD]);
  ok(!err(r) && r.rows[0]?.title === 'Saved without Realtime', 'safe: a save still works when sending fails', r.error);
  await db.exec(`alter table realtime.messages_off rename to messages`);
  await db.exec(`alter function realtime.send(jsonb, text, text, boolean) rename to send_off`);
  r = await call(P.ADMIN, `insert into public.votes (submission_id) values ($1)`, [ID.s7]);
  ok(!err(r), 'safe: a save still works when Realtime is not installed', r.error);
  await db.exec(`alter function realtime.send_off(jsonb, text, text, boolean) rename to send`);
  await call(P.ADMIN, `delete from public.votes where submission_id = $1 and voter_email = $2`, [ID.s7, P.ADMIN]);

  for (const who of ['anon', P.ADMIN]) {
    r = await call(who, `select private.rt_emit('ws:school:cmsru', 'drafts', 'update', '[{"id":1}]')`);
    ok(err(r), 'safe: ' + (who === 'anon' ? 'the public key' : 'a member') + ' cannot send notes by hand');
  }
  r = await call(P.ADMIN, `delete from public.drafts where id = $1`, [LD]);
  m = await since();
  ok(!err(r) && one(m, CMSRU, 'drafts')?.payload.op === 'delete' && !one(m, CMSRU, 'draft_slots'), 'notes: deleting a draft sends one draft note (its slots go quietly)', r.error || JSON.stringify(m.map((x) => x.payload.t)));
}
