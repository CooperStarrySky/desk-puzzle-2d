/* Puzzle workspace: the Admin console (#/admin). The site owner manages every
   school's people and the schools list; a school lead manages their own
   school's admins and faculty. Everything goes through the database's people
   functions (add_member, change_role, move_school, set_member_active,
   add_school), which check the same rules again. Nobody's password is ever
   set here: new people sign up themselves with the emailed code. */
import { S, $, $$, esc, lc, toast, openModal, busy, plainError, schFull, ago } from './ws-core.js';
import { loadPeople } from './ws-profile.js';
import { renderSchools, addSchoolDialog } from './ws-admin-schools.js';

export const ROLE_WORDS = { owner: 'Site owner', lead: 'School lead', admin: 'School admin', faculty: 'Faculty' };
const ROLE_CAN = [
  ['owner', 'Everything, at every school: people, schools, settings, all drafts.'],
  ['lead', 'Runs one school: adds and removes its admins and faculty, sets school settings.'],
  ['admin', 'Own school’s drafts, planner, scheduling, Trash, fixing originals received by the school.'],
  ['faculty', 'Same view as an admin: drafts, comments, can approve puzzles. Can’t trash or manage people.'],
];
export const EMAIL_OK = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
export const AM = { people: [], owners: [], signIns: null, sch: '', loaded: false };

/* Schools I run: every school for the owner, else the ones where I'm lead. */
export const leadSchools = () => (S.owner ? [...S.schools.keys()] : Object.keys(S.roles).filter((k) => S.roles[k] === 'lead'));
export const canConsole = () => S.owner || leadSchools().length > 0;
const canManage = (p) => S.owner || (S.roles[p.school] === 'lead' && p.role !== 'lead');
const nameOf = (p) => p.display_name || (S.people.get(p.email) || {}).display_name || p.email.split('@')[0];
export const inboxLink = () => location.origin + location.pathname.replace(/[^/]*$/, '');

export async function loadAdmin() {
  const [m, o, si] = await Promise.all([
    S.sb.from('members').select('email, school, role, display_name, active, added_at').order('email', { ascending: true }),
    S.owner ? S.sb.from('site_owners').select('email') : Promise.resolve({ data: [] }),
    S.sb.rpc('people_sign_ins')]);
  if (m.error) throw m.error;
  AM.people = (m.data || []).filter((p) => S.owner || leadSchools().includes(p.school));
  AM.owners = (o.data || []).map((x) => lc(x.email));
  // Last sign-in comes from the sign-in system through people_sign_ins();
  // if that is unavailable the column is simply left out.
  AM.signIns = si.error ? null : new Map((si.data || []).map((x) => [lc(x.email), x.last_sign_in_at]));
  AM.loaded = true;
}
const statusOf = (p) => (!p.active ? ['Access removed', 'st-trashed']
  : AM.signIns && !AM.signIns.get(p.email) ? ['Not signed up yet', 'st-planning'] : ['Active', 'st-ready']);

export async function showAdmin() {
  const main = $('#ws-main');
  if (!canConsole()) { main.innerHTML = '<div class="view-head"><div><h1>Admin console</h1></div></div><p class="muted">Only the site owner and school leads use the Admin console.</p>'; return; }
  if (!AM.loaded) main.innerHTML = '<div class="view-head"><div><h1>People and schools</h1></div></div><p class="muted" role="status">Loading…</p>';
  try { await loadAdmin(); } catch (e) { main.innerHTML = '<p class="err" role="alert">Could not load the people list: ' + esc(plainError(e)) + '</p>'; return; }
  renderAdmin();
}
export function renderAdmin() {
  const own = S.owner, mine = leadSchools(), main = $('#ws-main');
  const schoolsWithPeople = [...S.schools.keys()].filter((k) => AM.people.some((p) => p.school === k));
  main.innerHTML = '<div class="view-head"><div><p class="eyebrow">Admin console · ' + (own ? 'site owner' : 'school lead, ' + esc(mine.map(schFull).join(', '))) + '</p><h1>People and schools</h1></div></div>' +
    (own ? '' : '<p class="priv-note">As school lead you manage ' + esc(mine.map(schFull).join(', ')) + '’s admins and faculty. Other schools and new schools are the site owner’s job.</p>') +
    '<section class="panel stack adm-sec" aria-labelledby="rl-h"><h2 id="rl-h">Roles</h2><div class="role-grid">' +
    ROLE_CAN.map((r) => '<div class="role-card"><span class="role-tag r-' + r[0] + '">' + ROLE_WORDS[r[0]] + '</span><p>' + esc(r[1]) + '</p></div>').join('') + '</div></section>' +
    '<section class="stack adm-sec" aria-labelledby="pp-h"><div class="row spread"><h2 id="pp-h">People</h2><button type="button" class="btn primary" id="add-person">Add person</button></div>' +
    (own && schoolsWithPeople.length > 1 ? '<div class="chips" role="group" aria-label="Show people from">' + [['', 'All schools']].concat(schoolsWithPeople.map((k) => [k, schFull(k)])).map((o) =>
      '<button type="button" class="chip" data-asch="' + esc(o[0]) + '" aria-pressed="' + (AM.sch === o[0]) + '">' + esc(o[1]) + '</button>').join('') + '</div>' : '') +
    '<div id="people"></div></section>' +
    '<section class="stack adm-sec" aria-labelledby="sc-h"><div class="row spread"><h2 id="sc-h">Schools</h2>' + (own ? '<button type="button" class="btn" id="add-school">Add school…</button>' : '') + '</div><div class="school-grid" id="schools"></div></section>';
  $('#add-person').addEventListener('click', addPersonDialog);
  if ($('#add-school')) $('#add-school').addEventListener('click', () => addSchoolDialog(reloadAdmin));
  $$('[data-asch]').forEach((b) => b.addEventListener('click', () => { AM.sch = b.dataset.asch; $$('[data-asch]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderPeople(); }));
  renderPeople(); renderSchools(reloadAdmin);
}
export async function reloadAdmin() {
  try { await loadAdmin(); await loadPeople(); } catch (e) { toast('Could not refresh: ' + plainError(e), 5000); }
  renderAdmin();
}
function renderPeople() {
  const list = AM.people.filter((p) => !AM.sch || p.school === AM.sch);
  const showLast = !!AM.signIns;
  const ownerRows = S.owner && !AM.sch ? AM.owners.map((e) => '<tr><td><b>' + esc((S.people.get(e) || {}).display_name || e.split('@')[0]) + '</b>' + (e === S.me ? ' <span class="faint">(you)</span>' : '') + '</td><td>' + esc(e) +
    '</td><td>All schools</td><td><span class="role-tag r-owner">Site owner</span></td>' + (showLast ? '<td>' + lastHtml(e) + '</td>' : '') + '<td><span class="st st-ready">Active</span></td><td><span class="faint">Owner</span></td></tr>').join('') : '';
  $('#people').innerHTML = '<div class="tbl-wrap"><table class="tbl ppl"><caption class="sr">People with workspace access</caption><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">School</th><th scope="col">Role</th>' +
    (showLast ? '<th scope="col">Last sign-in</th>' : '') + '<th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>' + ownerRows +
    list.map((p, i) => {
      const st = statusOf(p), m = canManage(p), k = AM.people.indexOf(p);
      return '<tr data-row="' + i + '"><td><b>' + esc(nameOf(p)) + '</b>' + (p.email === S.me ? ' <span class="faint">(you)</span>' : '') + '</td><td>' + esc(p.email) + '</td><td>' + esc(schFull(p.school)) + '</td>' +
        '<td><span class="role-tag r-' + esc(p.role) + '">' + esc(ROLE_WORDS[p.role] || p.role) + '</span></td>' + (showLast ? '<td>' + lastHtml(p.email) + '</td>' : '') +
        '<td><span class="st ' + st[1] + '">' + st[0] + '</span></td><td><div class="row" style="--gap:4px">' +
        (!m ? '<span class="faint" style="font-size:.78rem">Site owner only</span>'
          : !p.active ? '<button type="button" class="btn small" data-pa="restore" data-k="' + k + '">Give access back</button>'
            : '<button type="button" class="btn small" data-pa="role" data-k="' + k + '">Change role</button>' +
              (S.owner ? '<button type="button" class="btn small" data-pa="move" data-k="' + k + '">Move school</button>' : '') +
              '<button type="button" class="btn small danger" data-pa="remove" data-k="' + k + '">Remove access</button>') + '</div></td></tr>';
    }).join('') + '</tbody></table></div>' +
    (list.length ? '' : '<p class="muted">Nobody here yet.</p>') +
    '<p class="faint" style="font-size:.8rem">Nobody’s password is ever set here. New people sign up at the workspace link with an emailed code and choose their own.</p>';
  $$('#people [data-pa]').forEach((b) => b.addEventListener('click', () => personAction(b.dataset.pa, AM.people[Number(b.dataset.k)], b)));
}
const lastHtml = (email) => { const t = AM.signIns && AM.signIns.get(email); return t ? '<span title="' + esc(new Date(t).toLocaleString()) + '">' + esc(ago(t)) + '</span>' : '<span class="faint">never</span>'; };
const roleOpts = (cur) => (S.owner ? ['lead', 'admin', 'faculty'] : ['admin', 'faculty']).map((r) => '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + ROLE_WORDS[r] + '</option>').join('');
const schOpts = (list, cur) => list.map((k) => '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(schFull(k)) + '</option>').join('');

/* One dialog with a single field and a primary button that runs an RPC. */
function rpcDialog(title, body, label, run) {
  openModal('<form class="stack" style="--gap:12px" novalidate><h2 id="modal-h">' + esc(title) + '</h2>' + body +
    '<p class="err" role="alert" hidden></p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="submit">' + esc(label) + '</button></div></form>', (m, close) => {
    const err = $('.err', m), f = $('form', m);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('.btn.primary', m), 'Saving…', async () => {
        const out = await run(m);
        if (typeof out === 'string') { err.textContent = out; err.hidden = false; return; }
        close(); await reloadAdmin();
      });
    });
  });
}
const rpcErr = async (name, args) => { const { error } = await S.sb.rpc(name, args); return error ? plainError(error) : null; };
function personAction(a, p, btn) {
  const n = nameOf(p);
  if (a === 'restore') {
    busy(btn, 'Saving…', async () => {
      const e = await rpcErr('set_member_active', { p_email: p.email, p_school: p.school, p_active: true });
      if (e) { toast('Could not give access back: ' + e, 5000); return; }
      toast(n + ' can sign in again'); await reloadAdmin();
    });
  } else if (a === 'role') {
    rpcDialog('Change role for ' + n, '<label class="field"><span>Role at ' + esc(schFull(p.school)) + '</span><select class="input" id="pr">' + roleOpts(p.role) + '</select></label>', 'Save role', async (m) => {
      const r = $('#pr', m).value;
      const e = await rpcErr('change_role', { p_email: p.email, p_school: p.school, p_role: r });
      if (e) return e;
      toast(n + ' is now ' + ROLE_WORDS[r] + ' at ' + schFull(p.school));
      return null;
    });
  } else if (a === 'move') {
    rpcDialog('Move ' + n + ' to another school', '<p class="muted">They’ll see the new school’s drafts and lose access to ' + esc(schFull(p.school)) + '’s drafts.</p><label class="field"><span>School</span><select class="input" id="pm">' +
      schOpts([...S.schools.keys()].filter((k) => k !== p.school), '') + '</select></label>', 'Move', async (m) => {
      const to = $('#pm', m).value; if (!to) return 'Pick a school.';
      const e = await rpcErr('move_school', { p_email: p.email, p_from: p.school, p_to: to });
      if (e) return e;
      toast('Moved ' + n + ' to ' + schFull(to));
      return null;
    });
  } else if (a === 'remove') {
    rpcDialog('Remove access for ' + n + '?', '<p>' + esc(n) + ' won’t be able to use the workspace for ' + esc(schFull(p.school)) + '. Their past comments, votes, and history stay. You can give access back later.</p>', 'Remove access', async () => {
      const e = await rpcErr('set_member_active', { p_email: p.email, p_school: p.school, p_active: false });
      if (e) return e;
      toast('Removed workspace access for ' + n);
      return null;
    });
  }
}
function addPersonDialog() {
  const mine = leadSchools(), def = AM.sch || S.school || mine[0];
  rpcDialog('Add a person', '<label class="field"><span>Email</span><input class="input" id="ap-e" type="email" autocomplete="off" placeholder="name@school.edu"></label>' +
    '<label class="field"><span>School</span><select class="input" id="ap-s"' + (mine.length > 1 ? '' : ' disabled') + '>' + schOpts(mine, mine.includes(def) ? def : mine[0]) + '</select></label>' +
    '<label class="field"><span>Role</span><select class="input" id="ap-r">' + roleOpts('admin') + '</select></label>' +
    '<p class="note-box">They sign up at the workspace link with this email and an emailed code, then choose their own password. You never set or see it.</p>', 'Add person', async (m) => {
    const e = lc($('#ap-e', m).value), sch = $('#ap-s', m).value, role = $('#ap-r', m).value;
    if (!EMAIL_OK(e)) { $('#ap-e', m).focus(); return 'Enter a full email address.'; }
    const err = await rpcErr('add_member', { p_email: e, p_school: sch, p_role: role });
    if (err) return err;
    setTimeout(() => invitedDialog(e, ROLE_WORDS[role], schFull(sch)), 0);
    return null;
  });
}
/* What to tell the new person (nothing is emailed from here). */
export function invitedDialog(email, role, school) {
  const msg = 'You’ve been added to the Desk Puzzle workspace as ' + role + ' at ' + school + '. Go to ' + inboxLink() + ', choose “Create account”, use ' + email + ', and enter the code that arrives by email. You pick your own password.';
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">' + esc(email) + ' can sign up now</h2>' +
    '<p class="muted">Nothing was emailed from here. Send them this note (or just the link):</p><p class="note-box" id="inv-msg">' + esc(msg) + '</p>' +
    '<div class="modal-actions"><button class="btn" type="button" id="inv-copy">Copy note</button><button class="btn primary" type="button" data-dismiss>Done</button></div></div>', (m) => {
    $('#inv-copy', m).addEventListener('click', () => {
      const ok = () => toast('Note copied');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(msg).then(ok, () => toast('Select the note and copy it')); else toast('Select the note and copy it');
    });
  });
}
export const resetAdmin = () => { AM.people = []; AM.owners = []; AM.signIns = null; AM.sch = ''; AM.loaded = false; };
