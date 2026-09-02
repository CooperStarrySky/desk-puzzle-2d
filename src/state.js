/* ════════════════════════════════════════════════════════════════════
 * state.js — shared mutable singletons, DOM element cache, settings,
 * layout, persistence, and small pure utilities.
 *
 * Imports: engine.js (BOX_COUNT, SLOT_COUNT for cacheEls).
 * ════════════════════════════════════════════════════════════════════ */

import { BOX_COUNT, SLOT_COUNT } from './engine.js';

/* ── Save / storage keys ─────────────────────────────────────────── */

export var SAVE_PREFIX = 'dp2d:';
export var SETTINGS_KEY = SAVE_PREFIX + 'settings';
export var LAYOUT_KEY = SAVE_PREFIX + 'layout';
export var EDITOR_DRAFT_KEY = SAVE_PREFIX + 'editor-draft';
/* v3 namespace: earlier layouts' saves must never half-restore here. */
export var SAVE_NS = SAVE_PREFIX + 'save3:';
export var LEGACY_SAVE_NS = [SAVE_PREFIX + 'save:', SAVE_PREFIX + 'save2:'];

/* Asset version — reads from the main.js module's script tag in the
   document, falling back to Date.now() if absent. document.currentScript
   is null inside modules, so we query the tag instead. */
export var ASSET_VERSION = (function () {
  var tag = document.querySelector('script[type="module"][src*="main.js"]');
  var src = tag && tag.src;
  var m = src && /[?&]v=([^&]+)/.exec(src);
  return m ? m[1] : String(Date.now());
})();

export function versioned(url) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + ASSET_VERSION; }

/* ── Layout defaults ─────────────────────────────────────────────── */

export var LAYOUT_DEFAULTS = {
  scope: { fx: 0.015, fy: 0.03 },
  lightbox: { w: 220, h: 240 },
  scatter: { lo: 0.36, hi: 0.92 },
  pieceScale: { sticky: 1.25, paper: 1.6, slide: 1.2, film: 1.45, photo: 1.75, rx: 1.35 },
  scopePanel: { w: 452, h: 322 },
};

/* ── Element cache singletons ────────────────────────────────────── */

export var els = {};
export var trayEls = [];
export var trayHeaderEls = [];
export var slotEls = [];
export var lockBtnEls = [];

/* ── Master state object ─────────────────────────────────────────── */

export var state = {
  settings: { casual: false, sound: true, theme: 'system' },
  game: null,
  pieceEls: {},
  desk: null,
  drag: null,
  toastTimer: null,
  scopeSources: {},
  layout: null,
  layoutMode: false,
  layoutDrag: null,
  textures: null,
  textureAspect: null,
  editorDraft: null,
  filmLightTimer: null,
  activeMachines: null,
  slideLetters: null,
  previewMode: false,
  editorMode: false,
  previewV: null,
  /* Viewport health tip runtime state — must be shared so ui-play, ui-menu
     and main can all read/write without cross-module let binding issues. */
  viewportTipShownThisLoad: false,
  viewportTipAutoHideTimer: null,
  viewportTipResizeTimer: null,
};

/* ── Small utilities ─────────────────────────────────────────────── */

export function toCamel(id) {
  return id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
}

export function hashString(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic PRNG — seeds the initial scatter per puzzle id. */
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function itemById(id) {
  return state.game.puzzle.items.find(function (i) { return i.id === id; });
}

/** Is this machine part of the current puzzle? */
export function hasMachine(m) {
  return !state.activeMachines || state.activeMachines.indexOf(m) !== -1;
}

/** A rect no point is ever inside — stands in for absent machines. */
export var NEVER_RECT = { left: -9, top: -9, right: -9, bottom: -9, width: 0, height: 0, cx: -9, cy: -9 };

export function fallbackColor(id) {
  var hue = hashString(id) % 60;
  return 'hsl(' + (20 + hue) + ' 65% 78%)';
}

export function downloadJson(filename, data) {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

/* ── Element cache ───────────────────────────────────────────────── */

export function cacheEls() {
  [
    'screen-menu', 'screen-play', 'screen-error', 'screen-editor', 'live-region', 'toast',
    'menu-title',
    'btn-play-today', 'btn-puzzle-select', 'puzzle-select-panel', 'puzzle-select-list', 'puzzle-select-summary', 'toggle-casual', 'toggle-sound',
    'puzzle-title', 'puzzle-date', 'mistake-tracker', 'btn-shuffle', 'btn-help', 'btn-hints', 'hints-panel', 'btn-menu',
    'play-area', 'wall-area', 'xray-rack', 'xray-rail', 'desk-surface', 'piece-layer', 'trays',
    'machine-scope', 'scope-stage', 'machine-lightbox', 'lightbox-screen',
    'scope-panel', 'scope-display-wrap', 'scope-canvas', 'tray-hud',
    'btn-reset',
    'btn-settings', 'settings-panel',
    'btn-close-settings',
    'overlay-help', 'btn-close-help',
    'overlay-results', 'results-title', 'results-sub', 'results-hints', 'results-groups',
    'btn-share', 'btn-copy-anki', 'btn-play-again', 'btn-back-menu', 'share-fallback',
    'error-message', 'btn-error-menu', 'layout-panel', 'reveal-note',
  ].forEach(function (id) {
    els[toCamel(id)] = document.getElementById(id);
  });

  for (var b = 0; b < BOX_COUNT; b++) {
    trayEls[b] = document.getElementById('tray-' + b);
    trayHeaderEls[b] = document.getElementById('tray-header-' + b);
    lockBtnEls[b] = trayEls[b].querySelector('[data-lock]');
    slotEls[b] = [];
    for (var s = 0; s < SLOT_COUNT; s++) {
      slotEls[b][s] = trayEls[b].querySelector('[data-box="' + b + '"][data-slot="' + s + '"]');
    }
  }
}

/* ── Settings ────────────────────────────────────────────────────── */

export function loadSettings() {
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      state.settings.casual = !!parsed.casual;
      state.settings.sound = parsed.sound !== false;
      if (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system') state.settings.theme = parsed.theme;
    }
  } catch (e) { /* corrupt settings — use defaults */ }
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) { /* storage unavailable */ }
}

/* ── Theme ───────────────────────────────────────────────────────── */

export var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme() {
  var mode = state.settings.theme;
  var dark = mode === 'dark' || (mode === 'system' && darkQuery && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export function setTheme(mode) {
  state.settings.theme = mode;
  saveSettings();
  applyTheme();
}

export function syncSettingsUi() {
  if (els.toggleCasual) els.toggleCasual.checked = state.settings.casual;
  if (els.toggleSound) els.toggleSound.checked = state.settings.sound;
  document.querySelectorAll('input[name="theme"]').forEach(function (r) {
    r.checked = r.value === state.settings.theme;
  });
}

/* ── Layout ──────────────────────────────────────────────────────── */

export var LAYOUT_MERGE_KEYS = ['scope', 'lightbox', 'scatter', 'pieceScale', 'scopePanel'];

export function mergeLayoutLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return;
  LAYOUT_MERGE_KEYS.forEach(function (k) {
    if (layer[k] && typeof layer[k] === 'object') Object.assign(base[k], layer[k]);
  });
  if (layer.sound) base.sound = layer.sound;
}

export function loadLayout() {
  var base = JSON.parse(JSON.stringify(LAYOUT_DEFAULTS));
  return fetch(versioned('layout.json'))
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (fileLayout) {
      mergeLayoutLayer(base, fileLayout);
      try {
        var raw = localStorage.getItem(LAYOUT_KEY);
        if (raw) mergeLayoutLayer(base, JSON.parse(raw));
      } catch (e) { /* malformed override — file/defaults stand */ }
      state.layout = base;
    });
}

/** Persist layout.json to localStorage. Callers in editor.js must update
 *  state.layout.sound = collectSoundLayer() themselves before calling this
 *  when they want sound overrides saved (avoids importing audio.js here). */
export function persistLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout)); } catch (e) { /* ignore */ }
}

export function applyLayout() {
  var L = state.layout;
  var root = document.documentElement;
  els.machineScope.style.left = (L.scope.fx * 100) + '%';
  els.machineScope.style.top = (L.scope.fy * 100) + '%';
  els.machineScope.style.right = 'auto';
  els.lightboxScreen.style.width = L.lightbox.w + 'px';
  els.lightboxScreen.style.height = L.lightbox.h + 'px';
  Object.keys(L.pieceScale).forEach(function (t) {
    root.style.setProperty('--scale-' + t, String(L.pieceScale[t]));
  });
}

/* ── Game persistence ────────────────────────────────────────────── */

export function saveKey(puzzleId) { return SAVE_NS + puzzleId; }

export function persistGame() {
  if (!state.game || !state.desk || state.previewMode) return;
  var snap = state.game.snapshot();
  snap.desk = state.desk;
  snap.casual = !!state.settings.casual;
  try {
    localStorage.setItem(saveKey(state.game.puzzle.id), JSON.stringify(snap));
  } catch (e) { /* storage full/unavailable */ }
}

export function loadSavedGame(puzzleId) {
  try {
    var raw = localStorage.getItem(saveKey(puzzleId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ── Desk state helpers ──────────────────────────────────────────── */

export function scatterSpot(rng) {
  var sc = state.layout.scatter;
  return {
    fx: 0.08 + 0.84 * rng(),
    fy: sc.lo + (sc.hi - sc.lo) * rng(),
  };
}

export function freshDeskState(puzzle) {
  var rng = mulberry32(hashString(puzzle.id));
  var desk = { pos: {}, rot: {}, z: {}, zTop: 0, scope: null, labels: {}, hintsUsed: 0,
               hints: { labels: false, seeds: false, category: false, revealedGroupId: null, pinned: {} } };
  var filmIndex = 0;
  puzzle.items.forEach(function (item) {
    if (item.zone === 'tubes') {
      desk.pos[item.id] = { fx: 0.12 + (filmIndex++ * 0.16), fy: 0.5 };
    } else {
      desk.pos[item.id] = scatterSpot(rng);
    }
    desk.rot[item.id] = item.zone === 'tubes' ? 0 : -15 + 30 * rng();
    desk.z[item.id] = ++desk.zTop;
  });
  return desk;
}
