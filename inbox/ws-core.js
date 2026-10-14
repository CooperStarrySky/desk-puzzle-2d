/* Puzzle workspace: shared helpers, state, the Supabase client, dialogs,
   people (names + avatar colors) and signed image links. Every other ws-*.js
   module imports from here; this file imports nothing. */
export const CFG = Object.assign({ supabaseUrl: '', supabasePublishableKey: '' }, window.DESK_PUZZLE_CONFIG || {});
// Publishable key (sb_publishable_...); a legacy anon JWT under supabaseAnonKey also works.
const KEY = String(CFG.supabasePublishableKey || CFG.supabaseAnonKey || '').trim();
export const BUCKET = 'submissions';

/* Shared state. me = signed-in email (lower case). people = email -> { display_name, color, schools }.
   roles = my school -> lead/admin/faculty; owner = site owner; school = the school I speak for. */
export const S = { sb: null, me: null, myRow: null, people: new Map(), signed: new Map(),
  roles: {}, owner: false, school: null, schools: new Map(), settings: {} };

export const $ = (s, root) => (root || document).querySelector(s);
export const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const lc = (s) => String(s || '').trim().toLowerCase();

let toastTimer = 0;
export function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}
/* A toast with buttons, e.g. [['Undo', fn], ['Add reason', fn]]. Stays up longer. */
export function toastAct(msg, acts, ms) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = '<span>' + esc(msg) + '</span>';
  (acts || []).forEach(([label, fn]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-btn'; b.textContent = label;
    b.addEventListener('click', () => { t.hidden = true; fn(); }); t.appendChild(b);
  });
  t.hidden = false; toastTimer = setTimeout(() => { t.hidden = true; }, ms || 8000);
}

/* ===== Schools and roles (the database enforces all of this too) ===== */
/* schName: the short code for tight spots ("CMSRU"); schFull: the school's full name. */
export const schName = (slug) => String(slug || '').toUpperCase();
export const schFull = (slug) => { const s = S.schools.get(slug); return s ? s.name : schName(slug); };
/* The "Submitted to CMSRU" pill in the school's own color, with black or white
   text, whichever reads better on it (WCAG contrast). */
export const DEFAULT_PILL = '#4a5568';
export const hexOk = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
export const schColor = (slug) => { const s = S.schools.get(slug); return s && hexOk(s.color) ? s.color.toLowerCase() : DEFAULT_PILL; };
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const pillInk = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#16141f') ? '#ffffff' : '#16141f');
export function schPill(slug, small, color) {
  if (!slug) return '';
  const bg = hexOk(color) ? color.toLowerCase() : schColor(slug);
  return '<span class="sch-pill' + (small ? ' sm' : '') + '" style="--pill:' + bg + ';--pill-ink:' + pillInk(bg) + '" title="Sent in to ' + esc(schFull(slug)) + '">' +
    (small ? '' : 'Submitted to ') + esc(schName(slug)) + '</span>';
}
export const roleIn = (school) => (S.owner ? 'owner' : S.roles[school] || null);
/* Trash, restore and tags in the shared bank: the owner or any school's lead/admin. */
export const isCurator = () => S.owner || Object.values(S.roles).some((r) => r === 'lead' || r === 'admin');
/* Plan drafts: the owner or a lead/admin somewhere. Faculty never. */
export const canPlan = isCurator;
/* Fix an original: the receiving school's leads and admins, and the owner. */
export const canFix = (r) => ['owner', 'lead', 'admin'].includes(roleIn(r.school));
export const isFacultyOnly = () => !S.owner && Object.keys(S.roles).length > 0 && !isCurator();

/* ===== ⋯ menus. items: [action, label, { arg, off: 'why it is turned off', danger }] ===== */
const MACT = {};
export function onMenu(name, fn) { MACT[name] = fn; }
export function menuHtml(label, items) {
  return '<div class="mnu"><button type="button" class="btn small mnu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="More actions' + (label ? ' for ' + esc(label) : '') + '">⋯</button>' +
    '<div class="mnu-pop" role="menu" hidden>' + items.map(([act, text, o = {}]) =>
      '<button type="button" role="menuitem" class="mnu-i' + (o.danger ? ' danger' : '') + '" data-mact="' + esc(act) + '" data-arg="' + esc(o.arg == null ? '' : o.arg) + '"' +
      (o.off ? ' aria-disabled="true" title="' + esc(o.off) + '"' : '') + '>' + esc(text) + (o.off ? '<small>' + esc(o.off) + '</small>' : '') + '</button>').join('') + '</div></div>';
}
export function closeMenus(except) {
  $$('.mnu-pop:not([hidden])').forEach((p) => { if (p === except) return; p.hidden = true; const b = p.previousElementSibling; if (b) b.setAttribute('aria-expanded', 'false'); });
}
function openMenu(btn) {
  const pop = btn.nextElementSibling; closeMenus(pop); pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  pop.style.top = (r.bottom + h + 8 > innerHeight && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4) + 'px';
  const f = $('.mnu-i:not([aria-disabled])', pop) || $('.mnu-i', pop); if (f) f.focus();
}
/* ===== One-time tips: shown until "Got it" (remembered on this device). ===== */
const TIPS_KEY = 'dp2d:ws-tips';
export function tipHtml(id, text) {
  if (prefJson(TIPS_KEY, {})[id]) return '';
  return '<p class="tip" data-tip="' + esc(id) + '"><span><span aria-hidden="true">💡 </span>' + esc(text) + '</span><button type="button" class="btn small ghost" data-tipx="' + esc(id) + '" aria-label="Dismiss this tip">Got it</button></p>';
}
export function initMenus() {
  document.addEventListener('click', (e) => {
    const tx = e.target.closest && e.target.closest('[data-tipx]');
    if (tx) { const t = prefJson(TIPS_KEY, {}); t[tx.dataset.tipx] = 1; prefSet(TIPS_KEY, JSON.stringify(t)); const p = tx.closest('.tip'); if (p) p.remove(); return; }
    const b = e.target.closest('.mnu-btn'), it = e.target.closest('.mnu-i');
    if (b) { if (b.getAttribute('aria-expanded') === 'true') closeMenus(); else openMenu(b); return; }
    if (it) {
      const btn = it.closest('.mnu-pop').previousElementSibling;
      if (it.getAttribute('aria-disabled')) { toast(it.title, 4500); return; }
      closeMenus(); btn.focus({ preventScroll: true });
      if (MACT[it.dataset.mact]) MACT[it.dataset.mact](it.dataset.arg, btn);
      return;
    }
    if (!e.target.closest('.mnu-pop')) closeMenus();
  });
  window.addEventListener('keydown', (e) => {
    const pop = $('.mnu-pop:not([hidden])'); if (!pop) return;
    const items = $$('.mnu-i', pop), i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeMenus(); pop.previousElementSibling.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === 'Tab') closeMenus();
  }, true);
  window.addEventListener('scroll', () => closeMenus(), true);
  window.addEventListener('resize', () => closeMenus());
}
export function when(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtD(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
export function fmtDay(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
export function ago(iso) {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (isNaN(m)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  if (m < 43200) return Math.round(m / 1440) + 'd ago';
  return fmtD(iso);
}
/* Local calendar day, YYYY-MM-DD, for grouping and the date filter. */
export function dayKey(iso) {
  const d = new Date(iso); const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
export function plainError(e) {
  const m = String((e && (e.message || e.error_description)) || e || '');
  if (/rate limit|too many/i.test(m)) return 'Too many emails just now. Wait a minute and try again.';
  if (/fetch|network/i.test(m)) return 'Could not reach the inbox. Check your internet connection and try again.';
  if (/row-level security|permission denied|no permission/i.test(m)) return 'You don’t have permission to do that. Are you still signed in as a puzzle-group member?';
  if (/syntax error in tsquery|tsquery/i.test(m)) return 'The search didn’t work with those symbols. Try plain words.';
  return m || 'Something went wrong. Please try again.';
}

/* "Keep me signed in": the session lives in localStorage (survives closing the
   browser) or, when unticked, in sessionStorage (gone when the tab closes). */
export const KEEP_KEY = 'dp2d:inbox-keep', EMAIL_KEY = 'dp2d:inbox-email';
export function prefGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function prefJson(k, d) { try { const v = prefGet(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
export function prefSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage off */ } }
export function keepSignedIn() { return prefGet(KEEP_KEY) !== '0'; }
const inboxStorage = {
  getItem(k) { try { return (keepSignedIn() ? localStorage : sessionStorage).getItem(k); } catch (e) { return null; } },
  setItem(k, v) { try { (keepSignedIn() ? localStorage : sessionStorage).setItem(k, v); } catch (e) { /* storage off */ } },
  removeItem(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } try { sessionStorage.removeItem(k); } catch (e) { /* */ } },
};

/* Test hook: ONLY on localhost with ?mock in the address, a test can supply a
   fake client as window.__inboxMockClient. On the real site this never runs. */
export function makeClient() {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (local && new URLSearchParams(location.search).has('mock') && window.__inboxMockClient) return window.__inboxMockClient;
  if (!String(CFG.supabaseUrl).trim() || !KEY) return 'setup';
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return 'noscript';
  return window.supabase.createClient(String(CFG.supabaseUrl).trim().replace(/\/+$/, ''), KEY, {
    // No sign-in links are ever emailed (codes only), so nothing to read from the address bar.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: inboxStorage },
  });
}

/* ===== Small in-page dialog. Escape or a click outside closes it; Tab stays inside. ===== */
export function modalOpen() { return !!$('#modal-root .scrim'); }
export function openModal(html, onOpen) {
  const prev = document.activeElement;
  const root = $('#modal-root');
  root.innerHTML = '<div class="scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-h" tabindex="-1">' + html + '</div></div>';
  const m = $('.modal', root);
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = $$('button, a[href], input, select, textarea', m).filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  $('.scrim', root).addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
  $$('[data-dismiss]', m).forEach((b) => b.addEventListener('click', close));
  if (onOpen) onOpen(m, close);
  const first = m.querySelector('input:not([type=hidden]), textarea') || m.querySelector('.btn.primary') || m;
  first.focus();
  return close;
}
/* Buttons stay disabled while a request is out, so nothing is sent twice. */
export async function busy(btn, label, fn) {
  if (!btn) return fn();
  if (btn.disabled) return undefined;
  const old = btn.innerHTML; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

/* ===== People: display name + color from the admins table ===== */
export const PALETTE = ['#4b3fb0', '#b2456e', '#2f7d55', '#2e5aa8', '#a8306f', '#0f766e', '#8a5a00', '#5b6170'];
export function emailName(email) { return String(email || '').split('@')[0] || 'someone'; }
export function person(email) {
  const key = lc(email);
  const row = S.people.get(key);
  const name = (row && row.display_name) || emailName(key);
  const words = name.replace(/[^\p{L}\p{N} .'-]/gu, ' ').split(/[\s.]+/).filter(Boolean);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { email: key, name, ini, color: (row && row.color) || PALETTE[h % PALETTE.length] };
}
export function av(email, lg) {
  if (!email) return '<span class="av' + (lg ? ' lg' : '') + '" aria-hidden="true">?</span>';
  const p = person(email);
  return '<span class="av' + (lg ? ' lg' : '') + '" style="--pc:' + esc(p.color) + '" title="' + esc(p.name) + '">' + esc(p.ini) + '</span>';
}
export function avs(list) { return '<span class="avs">' + list.map((e) => av(e)).join('') + '</span>'; }

/* ===== Puzzle content helpers ===== */
export const ZONES = { rack: ['Slide', '◎', 'slide'], tubes: ['X-ray', '▩', 'xray'], photo: ['Photo', '▣', 'photo'],
  corkboard: ['Sticky note', '✎', 'text'], folder: ['Paper', '☰', 'text'], rx: ['Rx', '℞', 'text'] };
export const ZONE_NAMES = { corkboard: 'Sticky note', folder: 'Paper sheet', rack: 'Microscope slide', tubes: 'X-ray film', photo: 'Photograph', rx: 'Prescription' };
export const TIER_WORDS = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Hardest' };
// shortlisted/declined: only old Planner/Archive rows from before multischool (kept so they still read).
export const STATUS_WORDS = { new: 'New', used: 'Used', trashed: 'In Trash', shortlisted: 'Shortlisted', declined: 'Declined' };
export const isPuzzle = (r) => r.kind === 'puzzle';
export const itemsOf = (g) => (g && Array.isArray(g.items) ? g.items : []);
export const nidsOf = (g) => (g && g.anki && Array.isArray(g.anki.nids) ? g.anki.nids : []);
export const groupsOf = (r) => (isPuzzle(r) && r.payload && Array.isArray(r.payload.groups) ? r.payload.groups : []);
export const allItems = (r) => (isPuzzle(r) ? groupsOf(r).reduce((a, g) => a.concat(itemsOf(g)), []) : itemsOf(r.payload));
export function creditText(r) {
  if (r.credit_mode !== 'named') return 'Anonymous';
  return (r.credit_name || '') + (r.credit_line ? ' · ' + r.credit_line : '');
}

/* ===== Images: short-lived signed links from the private bucket ===== */
/* Pictures of imported published puzzles keep their public site path (puzzles/<id>/<file>.webp). */
export function isSitePath(v) { return typeof v === 'string' && /^\/?puzzles\//.test(v); }
export function isStoragePath(v) { return typeof v === 'string' && !!v && !/^(data:|https?:|blob:)/.test(v) && !isSitePath(v); }
/* Any picture reference at all (storage, site, data:, web link). */
export function hasImage(v) { return typeof v === 'string' && !!v.trim(); }
/* Site paths resolve against the site root (this file lives in /inbox/). */
export const siteUrl = (v) => new URL('../' + String(v).replace(/^\/+/, ''), import.meta.url).href;
export async function signedUrl(path) {
  if (!hasImage(path)) return '';
  if (isSitePath(path)) return siteUrl(path);
  if (!isStoragePath(path)) return path;
  const hit = S.signed.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data) return '';
  S.signed.set(path, { url: data.signedUrl, until: Date.now() + 540000 });
  return data.signedUrl;
}
export async function fillImages(root) {
  // Plain web links (images of imported published puzzles) need no signing.
  $$('[data-src]', root).forEach((el) => { if (el.tagName === 'IMG') { if (!el.src) el.src = el.dataset.src; return; } if (!el.style.backgroundImage) el.style.backgroundImage = 'url("' + el.dataset.src.replace(/["\\\n]/g, (c) => '\\' + c) + '")'; });
  await Promise.all($$('[data-path]', root).map(async (el) => {
    const url = await signedUrl(el.dataset.path);
    if (!el.isConnected) return;
    if (!url) { el.replaceWith(Object.assign(document.createElement('div'), { className: 'none', textContent: 'Image missing' })); return; }
    if (el.tagName === 'IMG') el.src = url;
    else el.style.backgroundImage = 'url("' + url.replace(/["\\\n]/g, (c) => '\\' + c) + '")';
  }));
}
