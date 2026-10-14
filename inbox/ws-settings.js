/* Puzzle workspace: Settings (the ⚙ button in the header) and the one-line
   "What's new" note on the Category database.
   Settings: per school, the Faculty approved seal on/off and what new
   comments start as (the school's lead or the site owner may change them);
   for every school, how long the Trash keeps things (site owner only; the
   clean-up job that uses it is scheduled separately, see supabase/SETUP.md);
   and "Show What's new" again. Everyone can open it; locked rows say why. */
import { S, $, esc, toast, openModal, plainError, prefGet, prefSet, schFull } from './ws-core.js';

const AUTODEL = [['', 'Never (default)'], ['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '1 year']];
const WN_KEY = () => 'dp2d:ws-whatsnew-multischool:' + S.me; // '' open line, 'gone' dismissed, 'open' list shown
export const WHATS = [
  ['Category database', 'The inbox is now one shared database for every school. 👍, Add to draft, and Move to Trash. The shortlist is gone.'],
  ['Trash with Restore', 'Declined suggestions moved to the Trash, with the same filters and Undo.'],
  ['Usage on every category', 'Times used, as-is or adapted, at which schools, in which drafts.'],
  ['Edit for this puzzle', 'Tailor a category inside a draft (text, piece type, image, or a clue swapped in). The original stays as it was.'],
  ['Faculty and the approval seal', 'Faculty can comment and approve drafts. Approval never blocks scheduling.'],
  ['Schools', 'Drafts stay inside their school. The Calendar shows when other schools release, without titles.'],
  ['Calmer Activity', 'Repeated actions fold into one line; the badge counts only what’s new since your last visit.'],
  ['Admin console', 'The site owner and school leads add people, change roles, and add schools (Admin tab).'],
  ['Studio', 'Students send one category at a time and pick their school. Full-puzzle submissions are gone.'],
];

/* Header ⚙ button, shown once someone is in the workspace. */
export function initSettings() {
  const b = $('#gear-btn'); if (!b) return;
  b.addEventListener('click', openSettings);
}
const canSchool = (k) => S.owner || S.roles[k] === 'lead';
function schoolBox(k) {
  const st = S.settings[k] || { faculty_badge: true, comment_default: 'school' }, off = canSchool(k) ? '' : ' disabled';
  return '<fieldset class="set-box" id="set-sch" data-school="' + esc(k) + '"><legend>' + esc(schFull(k)) + '</legend>' +
    '<div class="set-row"><div><b id="fac-l">Faculty approved seal</b><p class="muted">Faculty can stamp a draft “Faculty approved”. The seal shows on drafts, the Calendar, and the Archive. It never blocks scheduling.</p></div>' +
    '<button type="button" class="switch" role="switch" id="set-fac" aria-labelledby="fac-l" aria-checked="' + (st.faculty_badge !== false) + '"' + off + '><span></span></button></div>' +
    '<div class="set-row"><div><b id="cmd-l">New comments start as</b><p class="muted">People can still switch it on each comment.</p></div>' +
    '<select class="input" id="set-cm" aria-labelledby="cmd-l"' + off + '><option value="school"' + (st.comment_default !== 'all' ? ' selected' : '') + '>🔒 My school only</option>' +
    '<option value="all"' + (st.comment_default === 'all' ? ' selected' : '') + '>🌐 All schools</option></select></div>' +
    (off ? '<p class="lock-note">Only this school’s lead or the site owner can change these.</p>' : '') + '</fieldset>';
}
export async function openSettings() {
  const mine = S.owner ? [...S.schools.keys()] : Object.keys(S.roles);
  let k = mine.includes(S.school) ? S.school : mine[0];
  const site = await S.sb.from('site_settings').select('trash_retention_days').limit(1);
  const days = !site.error && site.data && site.data[0] ? site.data[0].trash_retention_days : null;
  const cur = days == null ? '' : String(days), known = AUTODEL.some((o) => o[0] === cur);
  openModal('<div class="stack" style="--gap:14px"><h2 id="modal-h">Settings</h2>' +
    (mine.length > 1 ? '<label class="field" style="max-width:320px"><span>Show settings for</span><select class="input" id="set-pick">' +
      mine.map((s) => '<option value="' + esc(s) + '"' + (s === k ? ' selected' : '') + '>' + esc(schFull(s)) + '</option>').join('') + '</select></label>' : '') +
    '<div id="set-sch-wrap">' + (k ? schoolBox(k) : '') + '</div>' +
    '<fieldset class="set-box"><legend>Category database (every school)</legend><div class="set-row"><div><b id="ad-l">Delete trashed categories for good after</b>' +
    '<p class="muted">“Never” keeps everything in the Trash until someone restores it. Categories that went out in a puzzle or sit in a draft are always kept.</p></div>' +
    '<select class="input" id="set-ad" aria-labelledby="ad-l"' + (S.owner ? '' : ' disabled') + '>' +
    (known ? '' : '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' days</option>') +
    AUTODEL.map((o) => '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
    (S.owner ? '' : '<p class="lock-note">Only the site owner can change this.</p>') + '</fieldset>' +
    '<fieldset class="set-box"><legend>This browser</legend><div class="set-row"><div><b>What’s new</b><p class="muted">Show the What’s new note on the Category database again.</p></div>' +
    '<button type="button" class="btn small" id="set-wn">Show What’s new</button></div></fieldset>' +
    '<div class="modal-actions"><button class="btn primary" type="button" data-dismiss>Done</button></div></div>', (m) => {
    const wire = () => {
      const f = $('#set-fac', m), c = $('#set-cm', m);
      if (f && !f.disabled) f.addEventListener('click', () => saveSchool(k, { faculty_badge: f.getAttribute('aria-checked') !== 'true' }, () => {
        f.setAttribute('aria-checked', String(S.settings[k].faculty_badge));
        toast('Faculty approved seal ' + (S.settings[k].faculty_badge ? 'on' : 'off') + ' for ' + schFull(k));
      }));
      if (c && !c.disabled) c.addEventListener('change', () => saveSchool(k, { comment_default: c.value }, () =>
        toast('New comments at ' + schFull(k) + ' now start as ' + (c.value === 'all' ? 'All schools' : 'My school only'))));
    };
    wire();
    const pick = $('#set-pick', m);
    if (pick) pick.addEventListener('change', () => { k = pick.value; $('#set-sch-wrap', m).innerHTML = schoolBox(k); wire(); });
    const ad = $('#set-ad', m);
    if (!ad.disabled) ad.addEventListener('change', async () => {
      const v = ad.value === '' ? null : Number(ad.value);
      const { error } = await S.sb.from('site_settings').update({ trash_retention_days: v }).eq('id', true);
      if (error) { toast('Could not save: ' + plainError(error), 5000); return; }
      toast('Trash: ' + (v == null ? 'kept until restored (never deleted)' : 'deleted for good after ' + (AUTODEL.find((o) => o[0] === String(v)) || ['', v + ' days'])[1]));
    });
    $('#set-wn', m).addEventListener('click', () => { prefSet(WN_KEY(), null); toast('What’s new is back on the Category database'); renderWhatsNew(); });
  });
}
async function saveSchool(k, patch, done) {
  const { data, error } = await S.sb.from('school_settings').update(patch).eq('school', k).select('school, faculty_badge, comment_default');
  if (error || !data || !data.length) { toast('Could not save: ' + (error ? plainError(error) : 'not allowed'), 5000); return; }
  S.settings[k] = Object.assign({}, S.settings[k], data[0]);
  done();
}

/* The one-line, dismissible What's new note at the top of the Category database. */
export function renderWhatsNew() {
  const head = $('#ws-main .view-head'); if (!head || !$('#sug-list')) return;
  let el = $('#wn-line');
  const st = prefGet(WN_KEY()) || '';
  if (st === 'gone') { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'wn-line'; head.insertAdjacentElement('afterend', el); }
  const open = st === 'open';
  el.className = 'wn' + (open ? ' open' : '');
  el.innerHTML = '<p class="wn-closed"><button type="button" class="linkish" id="wn-x" aria-expanded="' + open + '" aria-controls="wn-list">What’s new in this release (' + WHATS.length + ')</button>' +
    '<button type="button" class="wn-dismiss" id="wn-gone" aria-label="Dismiss What’s new">×</button></p>' +
    (open ? '<ol class="wn-list" id="wn-list">' + WHATS.map((w) => '<li><b>' + esc(w[0]) + '</b> ' + esc(w[1]) + '</li>').join('') + '</ol>' : '');
  $('#wn-x', el).addEventListener('click', () => { prefSet(WN_KEY(), open ? null : 'open'); renderWhatsNew(); $('#wn-x').focus(); });
  $('#wn-gone', el).addEventListener('click', () => { prefSet(WN_KEY(), 'gone'); renderWhatsNew(); toast('What’s new hidden. Bring it back from ⚙ Settings.'); const h = $('#ws-main h1'); if (h) { h.tabIndex = -1; h.focus(); } });
}
