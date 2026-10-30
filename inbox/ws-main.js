/* Puzzle workspace: start-up, who gets in, the tabs and the address bar.
   Routes: #/categories (the Category database, tab "Categories"), #/categories/trash,
   #/categories/<id> (a category opened in place), #/planner, #/planner/<draft id>,
   #/calendar, #/archive, #/archive/categories, #/activity, #/admin (site owner
   and school leads only). Old links still work:
   #/suggestions -> #/categories and #s=<id> -> #/categories/<id>.
   WS_TABS turns a tab off without touching the rest. */
import { S, $, lc, toast, plainError, makeClient, modalOpen, initMenus, schName } from './ws-core.js';
import { initAuth, isHolding, changePassword, signOut } from './ws-auth.js';
import { loadPeople, needsProfile, renderMe, openProfile, initMenu } from './ws-profile.js';
import { initSuggest, showSuggestions, resetSuggest, newCount, liveCats, V as CATS } from './ws-suggest.js';
import { initActivity, showActivity, resetActivity, loadActivity, activityCount, liveActivity } from './ws-activity.js';
import { showPlanner, resetPlanner, livePlanner, ED, current } from './ws-plan-editor.js';
import { AD } from './ws-plan-adapt.js';
import { startLive, stopLive, presenceChanged, keepFocus, typingIn } from './ws-live.js';
import './ws-plan-slots.js';
import './ws-plan-checks.js';
import './ws-plan-preview.js';
import './ws-plan-flow.js';
import './ws-plan-appr.js';
import { showCalendar } from './ws-calendar.js';
import { showArchive, resetArchive } from './ws-arch-view.js';
import { showAdmin, resetAdmin, canConsole } from './ws-admin.js';
import { initSettings, renderWhatsNew } from './ws-settings.js';
import { enter } from './ws-motion.js';

export const WS_TABS = { categories: true, planner: true, calendar: true, archive: true, activity: true, admin: true };
const TAB_WORDS = { categories: 'Categories', planner: 'Planner', calendar: 'Calendar', archive: 'Archive', activity: 'Activity', admin: 'Admin' };
// The Admin tab only shows for the site owner and school leads.
const tabOn = (k) => WS_TABS[k] && (k !== 'admin' || canConsole());
const VIEWS = ['loading', 'v-setup', 'v-noscript', 'v-signin', 'v-notadmin', 'v-ws'];
let routing = false, again = false, readyFor = null, prompted = false, tab = '', view = '';

function show(id) {
  VIEWS.forEach((v) => { $('#' + v).hidden = v !== id; });
  const inWs = id === 'v-ws';
  $('#ws-tabs').hidden = !inWs; $('#me-wrap').hidden = !inWs; $('#gear-btn').hidden = !inWs;
}
function counts() {
  return { categories: newCount(), activity: activityCount() };
}
function renderTabs() {
  const n = counts();
  $('#ws-tabs').innerHTML = Object.keys(WS_TABS).filter(tabOn).map((k) =>
    '<a href="#/' + k + '"' + (k === tab ? ' aria-current="page"' : '') + '>' + TAB_WORDS[k] +
    (n[k] ? ' <span class="n">' + n[k] + '<span class="sr">' + (k === 'categories' ? ' new' : ' new since your last visit') + '</span></span>' : '') + '</a>').join('');
  // On a phone the strip scrolls sideways: keep the current tab in view.
  const nav = $('#ws-tabs'), a = $('#ws-tabs [aria-current]');
  if (a && nav.clientWidth) {
    if (a.offsetLeft + a.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = a.offsetLeft + a.offsetWidth - nav.clientWidth;
    else if (a.offsetLeft < nav.scrollLeft) nav.scrollLeft = a.offsetLeft;
  }
}
/* Which tab (and card) the address asks for. */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const id = new URLSearchParams(h).get('s');
  if (id) return { tab: 'categories', id };
  const [t0, sub] = h.split(/[/?]/), t = t0 === 'suggestions' ? 'categories' : t0;
  if (t === 'categories') return sub === 'trash' ? { tab: t, id: null, sub } : { tab: t, id: sub ? decodeURIComponent(sub) : null };
  if (t === 'planner' && WS_TABS.planner) return { tab: 'planner', id: null, draft: sub ? decodeURIComponent(sub) : null };
  if (t === 'archive' && WS_TABS.archive) return { tab: 'archive', id: null, sub: sub === 'categories' ? sub : '' };
  return { tab: tabOn(t) ? t : 'categories', id: null };
}
async function go() {
  const p = parseHash();
  const changedTab = p.tab !== tab || (p.draft || p.sub || '') !== view;
  tab = p.tab; view = p.draft || p.sub || ''; renderTabs();
  if (!(tab === 'planner' && p.draft)) { const sc = $('#sheet-scrim'); if (sc) sc.remove(); document.body.classList.remove('sheet-lock'); }
  if (changedTab) document.title = TAB_WORDS[tab] + ' · Puzzle workspace · Desk Puzzle';
  if (tab === 'activity') await showActivity();
  else if (tab === 'planner') await showPlanner(p.draft);
  else if (tab === 'calendar') await showCalendar();
  else if (tab === 'archive') await showArchive(p.sub);
  else if (tab === 'admin') await showAdmin();
  else { await showSuggestions(p.sub, p.id); if (p.sub !== 'trash') renderWhatsNew(); }
  if (changedTab && !p.id) {
    enter($('#ws-main')); // a soft fade between tabs (instant with reduce motion)
    window.scrollTo(0, 0);
    if (document.activeElement === document.body) $('#ws-root').focus({ preventScroll: true });
  }
  presenceChanged();
}

/* ===== Live syncing (ws-live.js) =====
   What I have open, for presence: a draft (and the tier I'm editing) or a category. */
function where() {
  if (tab === 'planner' && ED.id) {
    const d = current(), t = AD.w && AD.edit && AD.edit.startsWith(ED.id + ':') ? Number(AD.edit.split(':')[1]) : null;
    return d ? { view: 'draft', id: ED.id, school: d.school, tier: t } : null;
  }
  if (tab === 'categories' && CATS.open) return { view: 'cat', id: CATS.open, school: S.school };
  return null;
}
/* Notes from other people: refresh only what they touch, in place. '*' = check everything. */
async function onLive(notes) {
  if (!readyFor || $('#v-ws').hidden) return;
  const all = notes.some((n) => n.t === '*');
  const has = (...ts) => all || notes.some((n) => ts.includes(n.t));
  const cmt = (type) => notes.some((n) => n.t === 'comments' && (!n.items || n.items.some((i) => i.type === type)));
  const jobs = [];
  if (has('review_events', 'draft_events', 'member_events', 'comments', 'submissions', 'votes')) jobs.push(liveActivity());
  if (has('submissions', 'votes', 'review_events') || cmt('submission')) jobs.push(liveCats(notes));
  if (tab === 'planner' && (has('drafts', 'draft_slots', 'draft_events', 'publish_jobs', 'review_events', 'submissions', 'votes') || cmt('draft'))) jobs.push(livePlanner(notes));
  if (tab === 'calendar' && has('drafts') && !typingIn($('#ws-main'))) jobs.push(keepFocus(() => showCalendar()));
  await Promise.allSettled(jobs);
  if (readyFor) keepFocus(renderTabs);
}

/* Who is this, and what do they get to see. */
async function route() {
  if (routing) { again = true; return; }
  if (isHolding()) return;
  routing = true;
  try {
    const { data } = await S.sb.auth.getSession();
    const session = data && data.session;
    S.me = session && session.user ? lc(session.user.email) : null;
    if (!S.me) { if (readyFor) resetAll(); show('v-signin'); return; }
    if (readyFor !== S.me) {
      if (readyFor) resetAll(); // a different person: drop the last one's data first
      // Members (and the site owner) can read their own membership; anyone else gets nothing back.
      if (!(await loadPeople())) { $('#notadmin-email').textContent = S.me; show('v-notadmin'); return; }
      readyFor = S.me;
      loadActivity().then(renderTabs);
      startLive(onLive, where); // quietly does nothing when Realtime isn't available
    }
    renderMe(); show('v-ws');
    $('#brand-sub').textContent = 'Desk Puzzle · ' + (S.owner ? 'All schools' : schName(S.school));
    await go();
    if (needsProfile() && !prompted && !modalOpen()) { prompted = true; openProfile(true, () => go()); }
  } catch (e) {
    toast(plainError(e), 5000);
    show('v-signin');
  } finally {
    routing = false;
    if (again) { again = false; setTimeout(route, 0); }
  }
}
function resetAll() { stopLive(); resetSuggest(); resetActivity(); resetPlanner(); resetArchive(); resetAdmin(); readyFor = null; prompted = false; tab = ''; view = ''; $('#ws-main').innerHTML = ''; }

const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme(t) {
  const mode = t === 'light' || t === 'dark' ? t : 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && !!(darkMq && darkMq.matches));
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $('#theme-btn').textContent = 'Theme: ' + mode;
}
function boot() {
  let theme = 'auto';
  try { theme = localStorage.getItem('dp2d:studio-theme') || 'auto'; } catch (e) { /* default */ }
  applyTheme(theme);
  $('#theme-btn').addEventListener('click', () => {
    theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
    applyTheme(theme);
    try { localStorage.setItem('dp2d:studio-theme', theme); } catch (e) { /* not saved */ }
  });
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', () => applyTheme(theme));
  S.sb = makeClient();
  if (S.sb === 'setup') { show('v-setup'); return; }
  if (S.sb === 'noscript') { show('v-noscript'); return; }
  initAuth(route);
  initMenu();
  initMenus();
  initSettings();
  initSuggest(() => { if (readyFor) renderTabs(); });
  initActivity(() => { if (readyFor) renderTabs(); });
  $('#mi-profile').addEventListener('click', () => openProfile(false, () => go()));
  $('#mi-pw').addEventListener('click', changePassword);
  $('#mi-signout').addEventListener('click', () => signOut(resetAll));
  $('#notadmin-signout').addEventListener('click', () => signOut(resetAll));
  window.addEventListener('hashchange', () => { if (readyFor && !$('#v-ws').hidden) go(); });
  S.sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(route, 0); });
  route();
}
boot();
