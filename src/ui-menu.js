/* ════════════════════════════════════════════════════════════════════
 * ui-menu.js — menu, puzzle loading, openPuzzle, nav actions.
 *
 * Imports: engine.js, state.js, audio.js, ui-play.js.
 * Exports: fetchJson, loadRegistry, loadPuzzleByEntry, openPuzzle,
 *   renderMenu, applyRegistryTitles, sanitizeEngineSave, restoreDeskState,
 *   playToday, tryDeepLink, backToMenu, refreshMenu, onPlayAgain,
 *   onResetPuzzle, onPuzzleCardClick, formatPuzzleDate, fillMiniDesk,
 *   savedProgress, syncMenuThemeToggle, toggleMenuTheme.
 * ════════════════════════════════════════════════════════════════════ */

import {
  MAX_MISTAKES, BOX_COUNT, GROUP_SIZE, SLOT_COUNT,
  DeskPuzzleGame, emptyGrid, normalizeKinds, validateCase,
  puzzleMachines, groupOfItem,
} from './engine.js';

import {
  state, els, trayEls, slotEls, lockBtnEls,
  clamp, hasMachine, persistGame, loadSavedGame, freshDeskState,
  saveKey, SAVE_NS, LEGACY_SAVE_NS, versioned, setTheme, syncSettingsUi,
} from './state.js';

import { playSound } from './audio.js';

import {
  closeHintsPanel, buildPieces, showScreen, sizeViewer, syncAll,
  renderScopeView, showResults, showClueGuide, announce, hideOverlay,
  dismissViewportTip, showErrorScreen, checkViewportHealth, closeSettingsPanel,
} from './ui-play.js';

/* ── Shared in-flight guard ──────────────────────────────────────── */
var puzzleLoadInFlight = false;

/* ── Registry + puzzle loading ──────────────────────────────────── */

export function fetchJson(url) {
  return fetch(versioned(url)).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

export function loadRegistry() {
  return fetchJson('puzzles/index.json').catch(function () {
    if (window.DP2D_LOCAL_PUZZLE) {
      var p = window.DP2D_LOCAL_PUZZLE;
      return { current: p.id, puzzles: [{ id: p.id, title: p.title, date: p.date, file: p.id + '.json' }] };
    }
    throw new Error('Could not load the puzzle registry. Check your connection and reload.');
  });
}

export function loadPuzzleByEntry(entry) {
  return fetchJson('puzzles/' + entry.file).catch(function () {
    if (window.DP2D_LOCAL_PUZZLE && window.DP2D_LOCAL_PUZZLE.id === entry.id) {
      return window.DP2D_LOCAL_PUZZLE;
    }
    throw new Error('Puzzle "' + entry.id + '" could not be fetched. Check your connection and reload.');
  });
}

/* ── Menu rendering ──────────────────────────────────────────────── */

export function applyRegistryTitles(entry) {
  if (!entry) return;
  var desc = entry.title + ' - a pathology desk puzzle: sort 16 clues into 4 groups.';
  document.title = entry.title + ' : Desk Puzzle';
  if (els.menuTitle) els.menuTitle.textContent = entry.title;
  var metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute('content', desc);
}

/* Menu helpers: dates, generated mini desks, saved progress. */

var MINI_KINDS = ['note', 'sheet', 'slide', 'film', 'rx', 'photo'];

/** "2026-10-08" -> "Oct 8, 2026" (UTC, so the day never shifts). */
export function formatPuzzleDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function seedFromId(id) {
  var h = 2166136261;
  for (var i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 233279) + 1;
}

/** Fill `el` with a deterministic little desk of props, seeded by puzzle id.
    index.json carries no piece data, so this is decorative, not a preview. */
export function fillMiniDesk(el, id) {
  if (!el) return;
  el.textContent = '';
  var s = seedFromId(id);
  var r = function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (var i = 0; i < 9; i++) {
    var span = document.createElement('span');
    span.className = 'k-' + MINI_KINDS[Math.floor(r() * MINI_KINDS.length)];
    var w = 13 + r() * 9, h = 16 + r() * 14;
    span.style.left = (4 + (i % 3) * 31 + r() * 8).toFixed(1) + '%';
    span.style.top = (6 + Math.floor(i / 3) * 30 + r() * 6).toFixed(1) + '%';
    span.style.width = w.toFixed(1) + '%';
    span.style.height = h.toFixed(1) + '%';
    span.style.transform = 'rotate(' + ((r() - 0.5) * 16).toFixed(1) + 'deg)';
    el.appendChild(span);
  }
}

/** Read the existing per-puzzle save (no new storage): 'won' | 'lost' |
    'progress' | null. A save that was only opened, with nothing placed,
    locked, or guessed, counts as no progress. */
export function savedProgress(id) {
  try {
    var raw = localStorage.getItem(SAVE_NS + id);
    if (!raw) return null;
    var save = JSON.parse(raw);
    if (save.phase === 'won' || save.phase === 'lost') return save.phase;
    var staged = Array.isArray(save.staging) && save.staging.some(function (box) {
      return Array.isArray(box) && box.some(function (v) { return v !== null && v !== undefined; });
    });
    var moved = (save.mistakes > 0) || (Array.isArray(save.solved) && save.solved.length > 0) || staged;
    return moved ? 'progress' : null;
  } catch (e) { return null; }
}

var PROGRESS_BADGE = {
  won: { text: 'Solved', cls: 'badge-ok' },
  lost: { text: 'Played', cls: '' },
  progress: { text: 'In progress', cls: 'badge-acc' },
};

function badge(text, cls) {
  var b = document.createElement('span');
  b.className = 'badge' + (cls ? ' ' + cls : '');
  b.textContent = text;
  return b;
}

/** Header theme button: flips between light and dark through the same
    setTheme() the settings panel uses, so there is one theme setting. */
export function syncMenuThemeToggle() {
  if (!els.btnMenuTheme) return;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  els.btnMenuTheme.setAttribute('aria-label', label);
  els.btnMenuTheme.title = label;
}

export function toggleMenuTheme() {
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  setTheme(dark ? 'light' : 'dark');
  syncSettingsUi();
  syncMenuThemeToggle();
}

export function renderMenu(registry) {
  var puzzles = (registry.puzzles || []).slice().sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });

  var currentEntry = (registry.puzzles || []).find(function (p) { return p.id === registry.current; });
  applyRegistryTitles(currentEntry);
  syncMenuThemeToggle();

  if (els.puzzleCount) els.puzzleCount.textContent = String(puzzles.length);
  fillMiniDesk(els.featuredMini, registry.current || 'desk-puzzle');
  if (els.featuredDate) els.featuredDate.textContent = currentEntry ? formatPuzzleDate(currentEntry.date) : '';

  els.puzzleGrid.innerHTML = '';

  if (!puzzles.length) {
    var empty = document.createElement('li');
    empty.className = 'archive-empty';
    empty.textContent = 'No puzzles yet.';
    els.puzzleGrid.appendChild(empty);
    return;
  }

  puzzles.forEach(function (entry) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pcard puzzle-card' + (entry.id === registry.current ? ' current' : '');
    btn.dataset.puzzleId = entry.id;
    btn.dataset.puzzleFile = entry.file;

    var mini = document.createElement('span');
    mini.className = 'mini';
    mini.setAttribute('aria-hidden', 'true');
    fillMiniDesk(mini, entry.id);
    btn.appendChild(mini);

    var text = document.createElement('span');
    text.className = 'pcard-text';
    var title = document.createElement('span');
    title.className = 'pcard-title';
    title.textContent = entry.title;
    text.appendChild(title);

    var meta = document.createElement('span');
    meta.className = 'pcard-meta';
    var date = document.createElement('span');
    date.textContent = formatPuzzleDate(entry.date);
    meta.appendChild(date);
    if (entry.id === registry.current) meta.appendChild(badge('This week', 'badge-eosin'));
    var prog = PROGRESS_BADGE[savedProgress(entry.id)];
    if (prog) meta.appendChild(badge(prog.text, prog.cls));
    text.appendChild(meta);

    btn.appendChild(text);
    li.appendChild(btn);
    els.puzzleGrid.appendChild(li);
  });
}

/* ── Save sanitizer ──────────────────────────────────────────────── */

export function sanitizeEngineSave(saved, puzzle) {
  if (!saved || saved.caseId !== puzzle.id) return null;
  var ids = new Set(puzzle.items.map(function (i) { return i.id; }));

  var staging = emptyGrid();
  var seen = new Set();
  if (Array.isArray(saved.staging)) {
    for (var b = 0; b < BOX_COUNT; b++) {
      for (var s = 0; s < SLOT_COUNT; s++) {
        var v = saved.staging[b] && saved.staging[b][s];
        if (typeof v === 'string' && ids.has(v) && !seen.has(v)) {
          staging[b][s] = v;
          seen.add(v);
        }
      }
    }
  }

  var mistakes = (typeof saved.mistakes === 'number' && saved.mistakes >= 0)
    ? Math.floor(saved.mistakes) : 0;

  var solved = [];
  (Array.isArray(saved.solved) ? saved.solved : []).forEach(function (e) {
    if (!e || typeof e.boxIndex !== 'number' || e.boxIndex < 0 || e.boxIndex >= BOX_COUNT) return;
    var g = puzzle.groups.find(function (g) { return g.id === e.groupId; });
    if (!g) return;
    var boxIds = staging[e.boxIndex].filter(function (c) { return c !== null; });
    var exact = boxIds.length === GROUP_SIZE && g.itemIds.every(function (id) { return boxIds.indexOf(id) !== -1; });
    var dupe = solved.some(function (s2) { return s2.groupId === g.id || s2.boxIndex === e.boxIndex; });
    if (exact && !dupe) solved.push({ groupId: g.id, order: solved.length, boxIndex: e.boxIndex });
  });

  var attempts = [];
  (Array.isArray(saved.attempts) ? saved.attempts : []).forEach(function (a) {
    if (a && Array.isArray(a.itemIds) && a.itemIds.length === GROUP_SIZE &&
        a.itemIds.every(function (id) { return ids.has(id); })) {
      attempts.push({ itemIds: a.itemIds.slice(), correct: !!a.correct, boxIndex: (a.boxIndex | 0) });
    }
  });
  // Every solved lock must appear in the share history.
  var correct = attempts.filter(function (a) { return a.correct; }).length;
  if (correct < solved.length) {
    solved.slice(correct).forEach(function (e) {
      var g = puzzle.groups.find(function (g) { return g.id === e.groupId; });
      attempts.push({ itemIds: g.itemIds.slice(), correct: true, boxIndex: e.boxIndex });
    });
  }

  // The mode in force NOW decides whether the game is over. But if the
  // mistakes were made in casual mode (no limit) and the game was still in
  // progress, switching casual off must not end it on reload: keep it alive
  // with one guess left. Saves written before this fix have no casual flag
  // and fall back to the current setting.
  var savedCasual = typeof saved.casual === 'boolean' ? saved.casual : !!state.settings.casual;
  var nowCasual = !!state.settings.casual;
  var phase;
  if (solved.length === puzzle.groups.length) {
    phase = 'won';
  } else if (!nowCasual && mistakes >= MAX_MISTAKES) {
    if (savedCasual && saved.phase === 'playing') {
      phase = 'playing';
      mistakes = MAX_MISTAKES - 1;
    } else {
      phase = 'lost';
    }
  } else {
    phase = 'playing';
  }

  return { caseId: puzzle.id, phase: phase, staging: staging, mistakes: mistakes, solved: solved, attempts: attempts, desk: saved.desk };
}

/* ── Desk state restore ──────────────────────────────────────────── */

export function restoreDeskState(saved, puzzle, game) {
  var fresh = freshDeskState(puzzle);
  var d = saved && saved.desk;
  if (!d || typeof d !== 'object') return fresh;
  var desk = { pos: {}, rot: {}, z: {}, zTop: 0, scope: null, labels: {}, hintsUsed: 0,
               hints: { labels: false, seeds: false, category: false, revealedGroupId: null, pinned: {} } };
  puzzle.items.forEach(function (item) {
    var p = d.pos && d.pos[item.id];
    desk.pos[item.id] = (p && isFinite(p.fx) && isFinite(p.fy))
      ? { fx: clamp(p.fx, 0, 1), fy: clamp(p.fy, 0, 1) }
      : fresh.pos[item.id];
    if (item.zone === 'tubes') desk.pos[item.id].fy = 0.5;
    var r = d.rot && d.rot[item.id];
    desk.rot[item.id] = item.zone === 'tubes' ? 0 : (isFinite(r) ? r : fresh.rot[item.id]);
    var z = d.z && d.z[item.id];
    desk.z[item.id] = isFinite(z) && z > 0 ? Math.floor(z) : fresh.z[item.id];
    desk.zTop = Math.max(desk.zTop, desk.z[item.id]);
  });
  // The scope may only hold an undocked rack item.
  if (typeof d.scope === 'string') {
    var it = puzzle.items.find(function (i) { return i.id === d.scope; });
    if (it && it.zone === 'rack' && !game.isStaged(d.scope)) desk.scope = d.scope;
  }
  var labelCount = Object.keys(desk.labels).length;
  desk.hintsUsed = Math.max(
    labelCount,
    (typeof d.hintsUsed === 'number' && d.hintsUsed >= 0) ? Math.floor(d.hintsUsed) : 0
  );
  // Heal hints block (new in v15 — old saves have no hints block).
  var hints = { labels: false, seeds: false, category: false, revealedGroupId: null, pinned: {} };
  var dh = d.hints;
  if (dh && typeof dh === 'object') {
    if (dh.labels === true) hints.labels = true;
    if (dh.seeds === true) hints.seeds = true;
    if (dh.category === true) hints.category = true;
    if (typeof dh.revealedGroupId === 'string') {
      var rg = puzzle.groups.find(function (g) { return g.id === dh.revealedGroupId; });
      if (rg) hints.revealedGroupId = dh.revealedGroupId;
    }
    if (dh.pinned && typeof dh.pinned === 'object') {
      Object.keys(dh.pinned).forEach(function (itemId) {
        var pit = puzzle.items.find(function (i) { return i.id === itemId; });
        if (pit && game.isStaged(itemId)) hints.pinned[itemId] = dh.pinned[itemId];
      });
    }
  }
  desk.hints = hints;
  return desk;
}

/* ── Engine event callbacks (registered inside openPuzzle) ──────── */

export function onEngineChange() {
  persistGame();
  syncAll();
}

export function onPhaseChange(p) {
  if (p === 'won') {
    playSound('win');
    announce('You solved the puzzle with ' + state.game.mistakes + ' mistake' + (state.game.mistakes === 1 ? '' : 's') + '.');
    setTimeout(showResults, 450);
  } else if (p === 'lost') {
    playSound('lose');
    announce('Out of mistakes. Here are the answers.');
    setTimeout(showResults, 450);
  }
}

/* ── Opening a puzzle ────────────────────────────────────────────── */

export function openPuzzle(puzzleData) {
  normalizeKinds(puzzleData);
  try {
    validateCase(puzzleData);
  } catch (err) {
    showErrorScreen(err.message);
    return;
  }

  // Old-namespace saves for this puzzle must never linger.
  if (!state.previewMode) {
    LEGACY_SAVE_NS.forEach(function (ns) {
      try { localStorage.removeItem(ns + puzzleData.id); } catch (e) { /* ignore */ }
    });
  }

  // Orphan any previous game instance completely — no stale listeners.
  closeHintsPanel();
  if (state.game) state.game.events.removeAll();
  state.drag = null;

  var game = new DeskPuzzleGame(puzzleData, { casual: state.settings.casual });
  state.game = game;

  var healed = state.previewMode ? null : sanitizeEngineSave(loadSavedGame(puzzleData.id), puzzleData);
  if (healed) {
    game.restore(healed);
    state.desk = restoreDeskState(healed, puzzleData, game);
  } else {
    state.desk = freshDeskState(puzzleData);
  }

  if (game.phase === 'intro') game.setPhase('playing');

  // Anonymous slide letters (A, B, C… in item order — identifiers, not clue text).
  state.slideLetters = {};
  (function () {
    var n = 0;
    puzzleData.items.forEach(function (i) {
      if (i.zone === 'rack') state.slideLetters[i.id] = String.fromCharCode(65 + n++);
    });
  })();

  // Modular machines: render only what this puzzle declares.
  state.activeMachines = puzzleMachines(puzzleData);
  els.machineScope.hidden = !hasMachine('scope');
  els.scopePanel.hidden = !hasMachine('scope');
  els.machineLightbox.hidden = !hasMachine('lightbox');
  if (!hasMachine('scope')) state.desk.scope = null;
  game.events.on('change', onEngineChange);
  game.events.on('phase', onPhaseChange);

  state.scopeSources = {};

  buildPieces();
  showScreen('screenPlay');

  // First layout pass without transitions so pieces don't fly in from 0,0.
  els.pieceLayer.classList.add('no-anim');
  syncAll();
  requestAnimationFrame(function () {
    // Re-measure once the header/tray HUD have settled: the first pass can
    // run mid-layout (play-main momentarily taller), which would oversize
    // the square and push the scope controls out the panel's bottom.
    sizeViewer();
    requestAnimationFrame(function () {
      sizeViewer();
      els.pieceLayer.classList.remove('no-anim');
    });
  });

  persistGame();
  if (game.phase === 'won' || game.phase === 'lost') showResults();
  else showClueGuide();
  // Check viewport health after layout has settled (~300ms gives two rAFs
  // plus reflow time on slow hardware). Fires at most once per page load
  // (or once more after a Reset, which re-arms viewportTipShownThisLoad).
  setTimeout(checkViewportHealth, 300);
}

/* ── All-puzzles grid ────────────────────────────────────────────── */

/** Delegated click on #puzzle-grid: open that puzzle exactly as the old
    Past-puzzles dropdown did (same loader, same in-flight guard). */
export function onPuzzleCardClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('.puzzle-card') : null;
  if (!btn) return;
  if (puzzleLoadInFlight) return; // ignore second tap while load is in flight
  puzzleLoadInFlight = true;
  var entry = { id: btn.dataset.puzzleId, file: btn.dataset.puzzleFile };
  loadPuzzleByEntry(entry).then(openPuzzle).catch(function (err) {
    showErrorScreen(err.message);
  }).finally(function () {
    puzzleLoadInFlight = false;
  });
}

/* ── Navigation ──────────────────────────────────────────────────── */

export function backToMenu() {
  closeHintsPanel();
  closeSettingsPanel();
  showScreen('screenMenu');
  refreshMenu();
}

export function refreshMenu() {
  loadRegistry().then(renderMenu);
}

export function onPlayAgain() {
  hideOverlay(els.overlayResults);
  var puzzle = state.game.puzzle;
  try { localStorage.removeItem(saveKey(puzzle.id)); } catch (e) { /* ignore */ }
  openPuzzle(JSON.parse(JSON.stringify(puzzle)));
}

/** Toolbar "Reset" — same reset-from-scratch as onPlayAgain (fresh copy
    of the puzzle, its save wiped so a reload can't resurrect the old
    desk), but reachable mid-game. A quick native confirm guards it —
    lightweight on purpose — whenever there's actual progress to lose. */
export function onResetPuzzle() {
  var game = state.game;
  if (!game) return;
  if (game.phase === 'playing'
    && !window.confirm('Reset this puzzle? Staged pieces and mistakes will be cleared.')) {
    return;
  }
  var puzzle = game.puzzle;
  try { localStorage.removeItem(saveKey(puzzle.id)); } catch (e) { /* ignore */ }
  // Re-arm the viewport health tip so it may show once more after the reset.
  state.viewportTipShownThisLoad = false;
  dismissViewportTip();
  openPuzzle(JSON.parse(JSON.stringify(puzzle)));
}

/* ── Deep link ──────────────────────────────────────────────────── */

export function tryDeepLink() {
  var params = new URLSearchParams(window.location.search);
  var puzzleId = params.get('puzzle');
  if (!puzzleId) return false;

  loadRegistry().then(function (registry) {
    var entry = (registry.puzzles || []).find(function (p) { return p.id === puzzleId; });
    if (!entry) {
      showErrorScreen('No puzzle found for id "' + puzzleId + '". Check the URL and try reloading.');
      return;
    }
    return loadPuzzleByEntry(entry).then(openPuzzle);
  }).catch(function (err) { showErrorScreen(err.message); });
  return true;
}

/* ── playToday ──────────────────────────────────────────────────── */

export function playToday() {
  if (puzzleLoadInFlight) return;
  puzzleLoadInFlight = true;
  els.btnPlayToday.disabled = true; // belt-and-suspenders for keyboard users
  if (els.btnPlayFeatured) els.btnPlayFeatured.disabled = true;
  loadRegistry().then(function (registry) {
    var entry = (registry.puzzles || []).find(function (p) { return p.id === registry.current; })
      || { id: registry.current, file: registry.current + '.json' };
    return loadPuzzleByEntry(entry);
  }).then(openPuzzle).catch(function (err) {
    showErrorScreen(err.message);
  }).finally(function () {
    puzzleLoadInFlight = false;
    els.btnPlayToday.disabled = false;
    if (els.btnPlayFeatured) els.btnPlayFeatured.disabled = false;
  });
}
