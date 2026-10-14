/* Puzzle workspace: the Schools part of the Admin console. Each school shows
   its status, people and setup steps; the site owner adds a school (name,
   short code, first lead's email: one step in the database, add_school) and
   switches a finished school on for the Studio's "Your school" list. */
import { S, $, $$, esc, lc, toast, openModal, busy, plainError } from './ws-core.js';
import { AM, EMAIL_OK, invitedDialog, leadSchools } from './ws-admin.js';

const STEPS = ['First lead signs up with the emailed code', 'Lead adds the school’s admins and faculty', 'School appears in the Studio’s “Your school” list'];
/* Which setup steps are done, from what the console can see. */
function stepsOf(slug) {
  const ppl = AM.people.filter((p) => p.school === slug && p.active);
  const leads = ppl.filter((p) => p.role === 'lead');
  const signed = AM.signIns ? leads.some((p) => AM.signIns.get(p.email)) : null;
  return [signed, ppl.some((p) => p.role !== 'lead'), (S.schools.get(slug) || {}).status === 'active'];
}
export function renderSchools(reload) {
  const keys = S.owner ? [...S.schools.keys()] : leadSchools();
  $('#schools').innerHTML = keys.map((k) => {
    const sc = S.schools.get(k) || { name: k, status: 'setup' }, live = sc.status === 'active', st = stepsOf(k);
    const n = AM.people.filter((p) => p.school === k && p.active).length;
    return '<article class="school-card" data-school="' + esc(k) + '"><div class="row spread"><h3>' + esc(sc.name) + '</h3><span class="st ' + (live ? 'st-ready' : 'st-planning') + '">' + (live ? 'Active' : 'Setting up') + '</span></div>' +
      '<p class="muted" style="font-size:.84rem">Short code <code>' + esc(k) + '</code> · ' + n + (n === 1 ? ' person' : ' people') + '</p>' +
      (live ? '' : '<ol class="steps">' + STEPS.map((t, i) => '<li class="' + (st[i] ? 'done' : '') + '"><span aria-hidden="true">' + (st[i] ? '✓' : '○') + '</span> ' + esc(t) +
        (st[i] ? '<span class="sr"> (done)</span>' : st[i] === null ? ' <span class="faint">(can’t tell)</span>' : ' <span class="faint">(waiting)</span>') + '</li>').join('') + '</ol>') +
      (S.owner ? '<div class="row" style="--gap:6px">' + (live
        ? '<button type="button" class="btn small ghost" data-sact="setup" data-k="' + esc(k) + '">Take off the Studio list</button>'
        : '<button type="button" class="btn small primary" data-sact="active" data-k="' + esc(k) + '">Turn on in the Studio list</button>') + '</div>' : '') + '</article>';
  }).join('') || '<p class="muted">No schools yet.</p>';
  $$('#schools [data-sact]').forEach((b) => b.addEventListener('click', () => setStatus(b, b.dataset.k, b.dataset.sact, reload)));
}
function setStatus(btn, slug, status, reload) {
  const name = (S.schools.get(slug) || {}).name || slug;
  const go = () => busy(btn, 'Saving…', async () => {
    const { error } = await S.sb.from('schools').update({ status }).eq('slug', slug);
    if (error) { toast('Could not change ' + name + ': ' + plainError(error), 5000); return; }
    toast(status === 'active' ? name + ' is now in the Studio’s “Your school” list' : name + ' is off the Studio list (its people keep their access)', 4500);
    await reload();
  });
  if (status === 'active') { go(); return; }
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Take ' + esc(name) + ' off the Studio list?</h2><p>Students won’t be able to pick it when they send a category. Its people, drafts, and categories stay as they are.</p>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="button" id="ss-ok">Take it off</button></div></div>', (m, close) => {
    $('#ss-ok', m).addEventListener('click', () => { close(); go(); });
  });
}
export const codeFrom = (name) => String(name || '').toLowerCase().replace(/school of.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '');
export function addSchoolDialog(reload) {
  openModal('<form class="stack" style="--gap:12px" novalidate><h2 id="modal-h">Add a school</h2><p class="muted">Step 1 of 2. Three things; the new lead does the rest.</p>' +
    '<label class="field"><span>School name</span><input class="input" id="as-n" maxlength="120" placeholder="e.g. Pinebrook College of Medicine"></label>' +
    '<label class="field"><span>Short code (used in links; lowercase letters, numbers, dashes)</span><input class="input" id="as-c" maxlength="24" placeholder="e.g. pinebrook"></label>' +
    '<label class="field"><span>First lead’s email</span><input class="input" id="as-e" type="email" autocomplete="off" placeholder="lead@school.edu"></label>' +
    '<p class="err" id="as-err" role="alert" hidden></p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="submit" id="as-go">Create school</button></div></form>', (m, close) => {
    let typed = false;
    $('#as-c', m).addEventListener('input', () => { typed = true; });
    $('#as-n', m).addEventListener('input', (e) => { if (!typed) $('#as-c', m).value = codeFrom(e.target.value); });
    $('form', m).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const n = $('#as-n', m).value.trim(), c = lc($('#as-c', m).value), e = lc($('#as-e', m).value), err = $('#as-err', m);
      const bad = n.length < 2 ? 'Add the school’s name.' : !/^[a-z0-9-]{2,24}$/.test(c) ? 'Short code: 2-24 lowercase letters, numbers, and dashes.'
        : S.schools.has(c) ? 'That short code is taken.' : !EMAIL_OK(e) ? 'Enter the lead’s full email.' : '';
      if (bad) { err.textContent = bad; err.hidden = false; return; }
      busy($('#as-go', m), 'Creating…', async () => {
        const { error } = await S.sb.rpc('add_school', { p_slug: c, p_name: n, p_lead_email: e });
        if (error) { err.textContent = plainError(error); err.hidden = false; return; }
        close(); await reload();
        setTimeout(() => nextSteps(n, e), 0);
      });
    });
  });
}
function nextSteps(name, email) {
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">' + esc(name) + ' is set up to start</h2><p>Step 2 of 2. What happens next:</p><ol class="steps">' +
    STEPS.map((t) => '<li><span aria-hidden="true">○</span> ' + esc(t) + '</li>').join('') + '</ol>' +
    '<p class="muted">The Schools list tracks these. The school isn’t in the Studio’s list until you turn it on there.</p>' +
    '<div class="modal-actions"><button class="btn" type="button" id="ns-note">What to send the lead…</button><button class="btn primary" type="button" data-dismiss>Done</button></div></div>', (m, close) => {
    $('#ns-note', m).addEventListener('click', () => { close(); invitedDialog(email, 'School lead', name); });
  });
}
