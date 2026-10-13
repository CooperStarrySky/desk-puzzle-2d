/* Puzzle workspace: who is in the workspace (members of each school, plus the
   site owner), your display name and avatar color, and the menu under your
   avatar in the header. You may change only your own name and color. */
import { S, $, $$, esc, lc, toast, openModal, busy, plainError, person, av, PALETTE } from './ws-core.js';

/* Loads who I am (my schools and roles), everyone's names, the schools and my
   school's settings. Strangers get nothing back, which is how the page knows
   you're not a member. Returns true for a member or the site owner. */
export async function loadPeople() {
  const [mine, own, names, schools, sets] = await Promise.all([
    S.sb.from('members').select('email, school, role, display_name, color, active').eq('email', S.me),
    S.sb.from('site_owners').select('email').eq('email', S.me),
    S.sb.rpc('member_names'),
    S.sb.from('schools').select('slug, name, status').order('name', { ascending: true }),
    S.sb.from('school_settings').select('school, comment_default, faculty_badge')]);
  const rows = (mine.data || []).filter((r) => r.active);
  S.owner = !own.error && (own.data || []).length > 0;
  if (!rows.length && !S.owner) return false;
  S.roles = {}; rows.forEach((r) => { S.roles[r.school] = r.role; });
  const ordered = rows.map((r) => r.school).sort((a, b) => (b === 'cmsru') - (a === 'cmsru') || (a < b ? -1 : 1));
  S.school = ordered[0] || null;
  S.schools = new Map((schools.data || []).map((x) => [x.slug, x]));
  S.settings = {}; (sets.data || []).forEach((x) => { S.settings[x.school] = x; });
  S.people.clear();
  (names.data || []).forEach((r) => S.people.set(lc(r.email), r));
  const me = rows.find((r) => r.school === S.school);
  S.myRow = me ? { email: me.email, display_name: me.display_name, color: me.color } : null;
  if (S.myRow && !S.people.has(S.me)) S.people.set(S.me, Object.assign({ schools: ordered }, S.myRow));
  return true;
}
export const needsProfile = () => !!S.myRow && !S.myRow.display_name;

export function renderMe() {
  const p = person(S.me);
  $('#me-btn').innerHTML = av(S.me) + '<span class="nm">' + esc(p.name) + '</span><span class="sr"> (account menu)</span>';
  $('#me-email').textContent = S.me || '';
}

/* The name + color dialog. first = the welcome version shown at first sign-in. */
export function openProfile(first, onSaved) {
  if (!S.myRow) { toast('Your email isn’t on the group list, so there’s no profile to edit.', 4000); return; }
  const cur = person(S.me);
  let color = S.myRow.color || PALETTE[0];
  openModal('<form class="stack" style="--gap:14px" id="pf-form" novalidate>' +
    '<h2 id="modal-h">' + (first ? 'Welcome! What should the group call you?' : 'Your profile') + '</h2>' +
    (first ? '<p class="muted">Your name shows on everything you do here: comments, 👍 and “Trashed by John D.”. You can change it later from the menu under your name.</p>' : '') +
    '<label class="field"><span>Display name (up to 40 characters)</span><input class="input" id="pf-name" maxlength="40" autocomplete="name" value="' + esc(S.myRow.display_name || '') + '" placeholder="e.g. John D."></label>' +
    '<fieldset class="fgroup"><legend class="eyebrow">Avatar color</legend><div class="swatches" role="radiogroup" aria-label="Avatar color">' +
    PALETTE.map((c, i) => '<button type="button" class="swatch" role="radio" data-c="' + c + '" style="--sw:' + c + '" aria-checked="' + (c === color) + '" tabindex="' + (c === color ? 0 : -1) + '" aria-label="Color ' + (i + 1) + '"></button>').join('') +
    '</div></fieldset>' +
    '<div class="prof-preview" aria-hidden="true"><span id="pf-av"></span><span id="pf-nm"></span></div>' +
    '<p class="err" id="pf-err" role="alert" hidden></p>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>' + (first ? 'Not now' : 'Cancel') + '</button>' +
    '<button class="btn primary" type="submit" id="pf-save">Save</button></div></form>',
  (m, close) => {
    const name = $('#pf-name', m);
    const paint = () => {
      const n = name.value.trim() || cur.name;
      const words = n.split(/[\s.]+/).filter(Boolean);
      const ini = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
      $('#pf-av', m).innerHTML = '<span class="av lg" style="--pc:' + esc(color) + '">' + esc(ini) + '</span>';
      $('#pf-nm', m).textContent = n;
      $$('.swatch', m).forEach((s) => { const on = s.dataset.c === color; s.setAttribute('aria-checked', String(on)); s.tabIndex = on ? 0 : -1; s.textContent = on ? '✓' : ''; });
    };
    name.addEventListener('input', paint);
    const sw = $('.swatches', m);
    sw.addEventListener('click', (e) => { const s = e.target.closest('.swatch'); if (s) { color = s.dataset.c; paint(); } });
    sw.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
      e.preventDefault();
      color = PALETTE[(PALETTE.indexOf(color) + d + PALETTE.length) % PALETTE.length]; paint();
      const on = $('.swatch[aria-checked="true"]', m); if (on) on.focus();
    });
    paint();
    const err = (t) => { const p = $('#pf-err', m); p.hidden = !t; p.textContent = t || ''; };
    $('#pf-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = name.value.trim().replace(/\s+/g, ' ');
      if (!v) { err('Type a name, like “John D.”.'); name.focus(); return; }
      if (v.length > 40) { err('Keep it to 40 characters.'); return; }
      await busy($('#pf-save', m), 'Saving…', async () => {
        const { error } = await S.sb.rpc('set_my_profile', { p_display_name: v, p_color: color });
        if (error) { err('Could not save: ' + plainError(error)); return; }
        S.myRow = Object.assign({}, S.myRow, { display_name: v, color });
        S.people.set(S.me, Object.assign({}, S.people.get(S.me), { display_name: v, color }));
        close(); renderMe(); toast('Saved. You’re ' + v + ' to the group.');
        if (onSaved) onSaved();
      });
    });
  });
}

/* The avatar menu: Edit profile, Change password, Sign out. */
export function initMenu() {
  const btn = $('#me-btn'), menu = $('#me-menu');
  const set = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => { const open = menu.hidden; set(open); if (open) { const f = $('.mi', menu); if (f) f.focus(); } });
  menu.addEventListener('click', (e) => { if (e.target.closest('.mi')) set(false); });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(false); btn.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = $$('.mi', menu); const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu-wrap')) set(false); });
  return set;
}
