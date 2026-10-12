/* Puzzle workspace: accounts. Email + password; new accounts and password resets
   are confirmed with an 8-digit code typed on this page. Emails never carry a link,
   because Rowan's email scanner opens links and uses them up.
   Moved unchanged from the old single-file inbox (only sb -> S.sb, route -> onRoute). */
import { S, $, $$, toast, openModal, plainError, prefGet, prefSet, keepSignedIn, KEEP_KEY, EMAIL_KEY } from './ws-core.js';

let onRoute = () => {};
let holdAuth = false;    // true while a reset code has signed you in but no new password is saved yet
export const isHolding = () => holdAuth;

const GATE_MSG = 'This inbox is only for the CMSRU puzzle group.';
const RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_VIEWS = {
  signin: { form: 'f-signin', tab: 'signin', title: 'Sign in to the inbox' },
  signup: { form: 'f-signup', tab: 'signup', title: 'Create your account' },
  'signup-code': { form: 'f-signup-code', tab: 'signup', title: 'Check your email' },
  forgot: { form: 'f-forgot', tab: 'forgot', title: 'Reset your password' },
  'forgot-code': { form: 'f-forgot-code', tab: 'forgot', title: 'Check your email' },
  newpw: { form: 'f-newpw', tab: 'forgot', title: 'Choose a new password' },
};
let authView = 'signin';
let authEmail = '';      // the email a code was sent to

const cooldown = { signup: { until: 0, email: '' }, recovery: { until: 0, email: '' } }; // per kind, for one email

/* Supabase error -> plain English. Codes are from Supabase Auth's error list. */
export function authError(e) {
  const code = String((e && e.code) || '');
  const m = String((e && (e.message || e.error_description)) || e || '');
  if (/CMSRU puzzle group/i.test(m) || /^hook/.test(code)) return GATE_MSG;
  if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered|already exists/i.test(m)) return 'That email already has an account. Sign in, or reset your password.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(m)) return 'Email or password is wrong.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(m)) return 'This email hasn’t been confirmed yet.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit|too many|only request this after/i.test(m)) return 'Too many emails just now. Wait a minute and try again.';
  if (code === 'otp_expired' || /token has expired|token.*invalid|invalid.*(code|token|otp)/i.test(m)) return 'That code expired or isn’t right. Request a new one and use the newest code.';
  if (code === 'same_password' || /different from the old/i.test(m)) return 'That’s already your password. Choose a different one.';
  if (code === 'weak_password' || /password should|at least 8|weak password/i.test(m)) return 'That password is too short. Use at least 8 characters.';
  if (code === 'signup_disabled' || /signups not allowed/i.test(m)) return 'New accounts are switched off right now. Ask Thirth.';
  if (code === 'email_address_invalid' || /unable to validate email|invalid format/i.test(m)) return 'That doesn’t look like an email address.';
  return plainError(e);
}
function say(text, kind, button) {
  const msg = $('#signin-msg');
  msg.hidden = !text; msg.className = kind === 'ok' ? 'note-box' : 'err-box';
  msg.textContent = text || '';
  if (button) { msg.append(' '); msg.append(button); }
}
function rememberChoice(email) {
  const keep = $('#signin-keep').checked;
  prefSet(KEEP_KEY, keep ? '1' : '0');
  prefSet(EMAIL_KEY, keep ? email : null);
}
function currentEmailField() { const f = $('#' + AUTH_VIEWS[authView].form); return f && $('input[type=email]', f); }
export function setAuthView(name) {
  const from = currentEmailField();
  const typed = from ? from.value.trim() : '';
  authView = name;
  const v = AUTH_VIEWS[name];
  Object.keys(AUTH_VIEWS).forEach((k) => { $('#' + AUTH_VIEWS[k].form).hidden = k !== name; });
  $$('[role=tab]', $('#v-signin')).forEach((t) => {
    const on = t.dataset.auth === v.tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1;
  });
  $('[role=tablist]', $('#v-signin')).hidden = name === 'newpw';
  $('#auth-title').textContent = v.title;
  const to = currentEmailField();
  if (to && typed && !to.value) to.value = typed;
  say('');
  const first = $('#' + v.form + ' input:not([type=checkbox])');
  if (first && $('#v-signin').hidden === false) first.focus();
}
/* Buttons stay disabled while a request is out, so nothing is sent twice. */
async function busy(btn, label, fn) {
  if (btn.disabled) return undefined;
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; refreshCooldowns(); }
}
function secondsLeft(kind, email) {
  const c = cooldown[kind];
  return c.email === email ? Math.ceil((c.until - Date.now()) / 1000) : 0;
}
function refreshCooldowns() {
  $$('[data-resend]').forEach((b) => {
    const left = secondsLeft(b.dataset.resend, authEmail);
    if (left > 0) { b.disabled = true; b.textContent = 'Resend code (' + left + ' s)'; }
    else if (b.textContent !== 'Sending…') { b.disabled = false; b.textContent = 'Resend code'; }
  });
}
function startCooldown(kind) { cooldown[kind] = { until: Date.now() + RESEND_SECONDS * 1000, email: authEmail }; refreshCooldowns(); }
function codeFrom(id) { return $('#' + id).value.replace(/\s+/g, ''); }
function passwordsOk(pw, again) {
  if (pw.length < 8) { say('Passwords need at least 8 characters.'); return false; }
  if (pw !== again) { say('The two passwords don’t match.'); return false; }
  return true;
}
async function signIn(ev) {
  ev.preventDefault();
  const email = $('#signin-email').value.trim();
  const password = $('#signin-password').value;
  if (!EMAIL_RE.test(email)) { say('That doesn’t look like an email address.'); return; }
  if (!password) { say('Type your password.'); return; }
  rememberChoice(email);
  await busy($('#signin-btn'), 'Signing in…', async () => {
    const { error } = await S.sb.auth.signInWithPassword({ email, password });
    if (!error) { $('#signin-password').value = ''; say(''); onRoute(); return; }
    const text = authError(error);
    if (text.startsWith('This email hasn’t been confirmed')) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.id = 'signin-confirm-resend'; b.textContent = 'Email me a new code';
      b.addEventListener('click', () => resendCode('signup', email, b));
      say(text + ' Finish setting up with the code we emailed you, or get a new one.', 'err', b);
      return;
    }
    say(text);
  });
}
async function signUp(ev) {
  ev.preventDefault();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-password').value;
  if (!EMAIL_RE.test(email)) { say('That doesn’t look like an email address.'); return; }
  if (!passwordsOk(password, $('#signup-confirm').value)) return;
  rememberChoice(email);
  await busy($('#signup-btn'), 'Creating…', async () => {
    const { data, error } = await S.sb.auth.signUp({ email, password });
    if (error) { say(authError(error)); return; }
    const user = data && data.user;
    // With "Confirm email" on, Supabase hides whether an email already has an
    // account: it answers with a user that has no identities and sends nothing.
    if (user && Array.isArray(user.identities) && user.identities.length === 0) {
      say('That email already has an account. Sign in, or reset your password.'); return;
    }
    $('#signup-password').value = ''; $('#signup-confirm').value = '';
    if (data && data.session) { onRoute(); return; } // "Confirm email" switched off: already signed in
    showCodeStep('signup', email);
  });
}
function showCodeStep(kind, email) {
  authEmail = email;
  const view = kind === 'signup' ? 'signup-code' : 'forgot-code';
  setAuthView(view);
  $('#' + (kind === 'signup' ? 'signup' : 'forgot') + '-code-note').textContent = 'We emailed you a 8-digit code at ' + email +
    '. Type it below. School email can take a few minutes and may land in Junk. Only the newest code works.';
  startCooldown(kind);
}
async function resendCode(kind, email, btn) {
  email = email || authEmail;
  if (secondsLeft(kind, email) > 0) { say('You can ask for another code in ' + secondsLeft(kind, email) + ' seconds.'); return; }
  await busy(btn, 'Sending…', async () => {
    const { error } = kind === 'signup' ? await S.sb.auth.resend({ type: 'signup', email }) : await S.sb.auth.resetPasswordForEmail(email);
    if (error) { say(authError(error)); return; }
    if (authView !== (kind === 'signup' ? 'signup-code' : 'forgot-code') || email !== authEmail) { showCodeStep(kind, email); return; }
    startCooldown(kind);
    say('New code sent. Use the newest one.', 'ok');
  });
}
async function confirmSignup(ev) {
  ev.preventDefault();
  const token = codeFrom('signup-code');
  if (!/^[0-9]{6,10}$/.test(token)) { say('The code is the 8 digits in the email.'); return; }
  rememberChoice(authEmail);
  await busy($('#signup-code-btn'), 'Checking…', async () => {
    const { error } = await S.sb.auth.verifyOtp({ email: authEmail, token, type: 'signup' });
    if (error) { say(authError(error)); return; }
    $('#signup-code').value = ''; say(''); setAuthView('signin');
    onRoute();
  });
}
async function forgot(ev) {
  ev.preventDefault();
  const email = $('#forgot-email').value.trim();
  if (!EMAIL_RE.test(email)) { say('That doesn’t look like an email address.'); return; }
  rememberChoice(email);
  await busy($('#forgot-btn'), 'Sending…', async () => {
    // No redirect address: the email template only shows the code.
    const { error } = await S.sb.auth.resetPasswordForEmail(email);
    if (error) { say(authError(error)); return; }
    showCodeStep('recovery', email);
  });
}
async function checkResetCode(ev) {
  ev.preventDefault();
  const token = codeFrom('forgot-code');
  if (!/^[0-9]{6,10}$/.test(token)) { say('The code is the 8 digits in the email.'); return; }
  rememberChoice(authEmail);
  await busy($('#forgot-code-btn'), 'Checking…', async () => {
    holdAuth = true; // the code signs you in; stay here until the new password is saved
    const { error } = await S.sb.auth.verifyOtp({ email: authEmail, token, type: 'recovery' });
    if (error) { holdAuth = false; say(authError(error)); return; }
    $('#forgot-code').value = '';
    $('#newpw-email').textContent = authEmail;
    setAuthView('newpw');
  });
}
async function saveNewPassword(ev) {
  ev.preventDefault();
  const password = $('#newpw-password').value;
  if (!passwordsOk(password, $('#newpw-confirm').value)) return;
  await busy($('#newpw-btn'), 'Saving…', async () => {
    const { error } = await S.sb.auth.updateUser({ password });
    if (error) { say(authError(error)); return; }
    $('#newpw-password').value = ''; $('#newpw-confirm').value = '';
    holdAuth = false; setAuthView('signin');
    toast('Password saved. You’re signed in.');
    onRoute();
  });
}
export function changePassword() {
  openModal('<form class="stack" style="--gap:12px" id="m-pw" novalidate><h2 id="modal-h">Change password</h2>' +
    '<label class="field"><span>New password (at least 8 characters)</span><input class="input" id="m-pw1" type="password" autocomplete="new-password" minlength="8" required></label>' +
    '<label class="field"><span>Type it again</span><input class="input" id="m-pw2" type="password" autocomplete="new-password" minlength="8" required></label>' +
    '<label class="check"><input type="checkbox" class="show-pw" data-for="m-pw1 m-pw2"> <span>Show password</span></label>' +
    '<p id="m-pw-msg" class="err-box" role="alert" hidden></p>' +
    '<div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-dismiss>Cancel</button>' +
    '<button class="btn primary" type="submit" id="m-pw-btn">Save password</button></div></form>',
  (m, close) => {
    const err = (t) => { const p = $('#m-pw-msg', m); p.hidden = !t; p.textContent = t || ''; };
    $('#m-pw', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = $('#m-pw1', m).value;
      if (pw.length < 8) { err('Passwords need at least 8 characters.'); return; }
      if (pw !== $('#m-pw2', m).value) { err('The two passwords don’t match.'); return; }
      await busy($('#m-pw-btn', m), 'Saving…', async () => {
        const { error } = await S.sb.auth.updateUser({ password: pw });
        if (error) { err(authError(error)); return; }
        close(); toast('Password changed');
      });
    });
  });
}
/* Sign out; afterReset clears the rest of the workspace's state. */
export async function signOut(afterReset) {
  try { await S.sb.auth.signOut(); } catch (e) { /* signed out locally anyway */ }
  S.me = null; S.myRow = null; S.people.clear(); S.signed.clear();
  if (afterReset) afterReset();
  holdAuth = false; setAuthView('signin');
  history.replaceState(null, '', location.pathname + location.search);
  onRoute();
}

/* Wire the sign-in forms. route is called whenever the sign-in state may have changed. */
export function initAuth(route) {
  onRoute = route;
  $('#f-signin').addEventListener('submit', signIn);
  $('#f-signup').addEventListener('submit', signUp);
  $('#f-signup-code').addEventListener('submit', confirmSignup);
  $('#f-forgot').addEventListener('submit', forgot);
  $('#f-forgot-code').addEventListener('submit', checkResetCode);
  $('#f-newpw').addEventListener('submit', saveNewPassword);
  $('#v-signin').addEventListener('click', (e) => {
    const go = e.target.closest('[data-auth]'); if (go) { setAuthView(go.dataset.auth); return; }
    const re = e.target.closest('[data-resend]'); if (re) resendCode(re.dataset.resend, null, re);
  });
  $('[role=tablist]', $('#v-signin')).addEventListener('keydown', (e) => { // arrow keys move between tabs
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = $$('[role=tab]', e.currentTarget); const i = tabs.indexOf(document.activeElement);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setAuthView(next.dataset.auth); next.focus();
  });
  document.addEventListener('change', (e) => { // "Show password" ticks
    const t = e.target.closest('.show-pw'); if (!t) return;
    t.dataset.for.split(' ').forEach((id) => { const f = document.getElementById(id); if (f) f.type = t.checked ? 'text' : 'password'; });
  });
  setInterval(refreshCooldowns, 1000);
  $('#signin-keep').checked = keepSignedIn();
  if (prefGet(EMAIL_KEY)) ['signin-email', 'signup-email', 'forgot-email'].forEach((id) => { $('#' + id).value = prefGet(EMAIL_KEY); });
}
