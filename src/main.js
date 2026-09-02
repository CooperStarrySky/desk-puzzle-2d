/* ════════════════════════════════════════════════════════════════════
 * main.js — ES module entry point. No build step; loaded by index.html
 * as <script type="module" src="src/main.js?v=20">.
 *
 * Responsibilities: one-time init(), event wiring, debug handle.
 * All business logic lives in the imported modules.
 * ════════════════════════════════════════════════════════════════════ */

import {
  state, els,
  cacheEls, loadSettings, applyTheme, darkQuery,
  loadLayout, applyLayout, syncSettingsUi, saveSettings, setTheme,
} from './state.js';

import { applySoundLayer, loadSoundOverrides } from './audio.js';

import { loadTextures } from './textures.js';

import {
  syncHeader, syncMachines,
  onShuffle, showClueGuide, closeClueGuide,
  toggleHintsPanel, closeHintsPanel, toggleSettingsPanel, closeSettingsPanel,
  dismissViewportTip, checkViewportHealth,
  onTraysClick, onShare, onCopyAnki,
  hideOverlay, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown,
  sizeViewer, fitPieceLabels, syncPieces, renderScopeView,
  buildAnkiSearch, showResults, showResultsForPuzzle,
  showScreen, showPreviewResultsFromDraft,
} from './ui-play.js';

import {
  playToday, openPuzzleSelect, closePuzzleSelect, onPuzzleSelectEntry,
  backToMenu, onPlayAgain, onResetPuzzle, refreshMenu, tryDeepLink, openPuzzle,
} from './ui-menu.js';

import {
  onEditorInput, onEditorClick, onEditorChange,
  buildLayoutPanel, buildEditor, bootPreviewDraft, layoutPreviewStage,
  flushPreviewQueue, setPreviewReady,
} from './editor.js';

/* ── Debug handle (written before init() completes) ──────────────── */
window.__dp2d = { state, els, buildAnkiSearch, showResultsForPuzzle, openPuzzle };

/* ── Entry point ─────────────────────────────────────────────────── */

async function init() {
  cacheEls();
  loadSettings();
  applyTheme();
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener('change', function () {
      if (state.settings.theme === 'system') applyTheme();
    });
  }
  await loadLayout(); // defaults < layout.json (if published) < localStorage
  applyLayout();
  applySoundLayer(state.layout.sound);
  loadTextures();
  loadSoundOverrides();
  syncSettingsUi();

  // Menu + settings overlay.
  els.btnPlayToday.addEventListener('click', playToday);

  // Puzzle-select dropdown
  els.btnPuzzleSelect.addEventListener('click', function () {
    if (els.puzzleSelectPanel.hidden) { openPuzzleSelect(); } else { closePuzzleSelect(); }
  });
  els.puzzleSelectList.addEventListener('click', onPuzzleSelectEntry);
  document.addEventListener('keydown', function (ev) {
    if (!els.puzzleSelectPanel || els.puzzleSelectPanel.hidden) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePuzzleSelect();
      els.btnPuzzleSelect.focus();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      var entries = Array.prototype.slice.call(
        els.puzzleSelectList.querySelectorAll('.puzzle-select-entry'));
      if (!entries.length) return;
      var idx = entries.indexOf(document.activeElement);
      idx = ev.key === 'ArrowDown'
        ? (idx < entries.length - 1 ? idx + 1 : 0)
        : (idx > 0 ? idx - 1 : entries.length - 1);
      entries[idx].focus();
    }
  });
  document.addEventListener('click', function (ev) {
    if (!els.puzzleSelectPanel || els.puzzleSelectPanel.hidden) return;
    var wrap = els.btnPuzzleSelect ? els.btnPuzzleSelect.closest('.puzzle-select-wrap') : null;
    if (wrap && !wrap.contains(ev.target)) { closePuzzleSelect(); }
  });

  els.btnSettings.addEventListener('click', function () { toggleSettingsPanel(); });
  if (els.btnCloseSettings) els.btnCloseSettings.addEventListener('click', function () { closeSettingsPanel(); els.btnSettings.focus(); });
  // Settings panel: click-outside close — namespaced.
  document.addEventListener('click', function (ev) {
    if (!els.settingsPanel || els.settingsPanel.hidden) return;
    var wrap = els.btnSettings ? els.btnSettings.closest('.settings-wrap') : null;
    if (wrap && !wrap.contains(ev.target)) closeSettingsPanel();
  });
  document.querySelectorAll('input[name="theme"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) setTheme(r.value); });
  });
  els.toggleCasual.addEventListener('change', function () {
    state.settings.casual = els.toggleCasual.checked;
    saveSettings();
    if (state.game) {
      state.game.casual = state.settings.casual;
      syncHeader();
      syncMachines();
    }
  });
  els.toggleSound.addEventListener('change', function () {
    state.settings.sound = els.toggleSound.checked;
    saveSettings();
    syncSettingsUi();
  });

  // Play header.
  els.btnShuffle.addEventListener('click', onShuffle);
  els.btnReset.addEventListener('click', onResetPuzzle);
  els.btnHelp.addEventListener('click', showClueGuide);
  els.btnCloseHelp.addEventListener('click', closeClueGuide);
  if (els.btnHints) {
    els.btnHints.addEventListener('click', function () { toggleHintsPanel(); });
  }
  els.btnMenu.addEventListener('click', backToMenu);

  // Viewport health tip: dismiss button.
  var viewportTipDismissBtn = document.querySelector('.viewport-tip-dismiss');
  if (viewportTipDismissBtn) {
    viewportTipDismissBtn.addEventListener('click', dismissViewportTip);
  }

  // Viewport health tip: debounced resize check while play screen is visible.
  window.addEventListener('resize', function () {
    if (!els.screenPlay || els.screenPlay.hidden) return;
    clearTimeout(state.viewportTipResizeTimer);
    state.viewportTipResizeTimer = setTimeout(checkViewportHealth, 400);
  });

  // Hints panel: keyboard nav (ArrowUp/Down between enabled rows) — namespaced
  // so it doesn't conflict with the puzzle-select dropdown's own handlers.
  document.addEventListener('keydown', function (ev) {
    if (!els.hintsPanel || els.hintsPanel.hidden) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      var rows = Array.prototype.slice.call(els.hintsPanel.querySelectorAll('.hint-row-btn:not([disabled])'));
      if (!rows.length) return;
      var idx = rows.indexOf(document.activeElement);
      idx = ev.key === 'ArrowDown'
        ? (idx < rows.length - 1 ? idx + 1 : 0)
        : (idx > 0 ? idx - 1 : rows.length - 1);
      rows[idx].focus();
    }
  });
  // Hints panel: click-outside close — namespaced.
  document.addEventListener('click', function (ev) {
    if (!els.hintsPanel || els.hintsPanel.hidden) return;
    var wrap = els.btnHints ? els.btnHints.closest('.hints-wrap') : null;
    if (wrap && !wrap.contains(ev.target)) closeHintsPanel();
  });

  // Trays (lock buttons via delegation).
  els.trays.addEventListener('click', onTraysClick);

  // Results.
  els.btnShare.addEventListener('click', onShare);
  els.btnCopyAnki.addEventListener('click', onCopyAnki);
  els.btnPlayAgain.addEventListener('click', onPlayAgain);
  els.btnBackMenu.addEventListener('click', function () {
    hideOverlay(els.overlayResults);
    backToMenu();
  });

  // Error screen.
  els.btnErrorMenu.addEventListener('click', backToMenu);

  // Editor (delegated; the form is rebuilt but these binds never are).
  els.screenEditor.addEventListener('input', onEditorInput);
  els.screenEditor.addEventListener('change', onEditorChange);
  els.screenEditor.addEventListener('click', onEditorClick);
  // Rich text toolbar: preventDefault on mousedown so the browser never
  // shifts focus to the button before execCommand runs against the
  // field's current selection (a plain click would collapse it first).
  els.screenEditor.addEventListener('mousedown', function (ev) {
    var richBtn = ev.target.closest ? ev.target.closest('[data-rich-cmd]') : null;
    if (richBtn) ev.preventDefault();
  });
  // Legacy execCommand tag output (<b>/<i>/<u>, not style="") only happens
  // with styleWithCSS off; <br> line breaks (not new <div>/<p> blocks) only
  // with this paragraph separator — both match the sanitizer's allowlist.
  els.screenEditor.addEventListener('focusin', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('rich-editable')) return;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('defaultParagraphSeparator', false, 'br');
    } catch (e) { /* ignore — best-effort */ }
  });
  // Paste as plain text only: the only markup a rich-editable should ever
  // contain is what our own B/I/U toolbar puts there.
  els.screenEditor.addEventListener('paste', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('rich-editable')) return;
    ev.preventDefault();
    var text = (ev.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Dragging + keyboard + layout — document/window level, bound once, in
  // the CAPTURE phase so piece drags can't be starved by anything between
  // the piece and the document (see the debug round: bubble-phase-only
  // binding was fragile against non-bubbling synthetic events).
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onPointerUp, { capture: true });
  document.addEventListener('pointercancel', onPointerCancel, { capture: true });
  document.addEventListener('keydown', onKeyDown);
  // iOS long-press triggers a callout (copy/save) on pieces. Suppress
  // contextmenu only inside a .piece so right-click elsewhere still works.
  els.playArea.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('.piece')) e.preventDefault();
  });
  window.addEventListener('resize', function () {
    if (state.game && !els.screenPlay.hidden) {
      sizeViewer();
      fitPieceLabels();
      syncPieces();
      renderScopeView();
    }
    if (els.screenEditor && !els.screenEditor.hidden) layoutPreviewStage();
  });

  // The editor side of the live-preview handshake: once the ?preview
  // iframe signals it's listening, flush whatever got queued before then.
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'dp2d-preview-ready') {
      setPreviewReady(true);
      flushPreviewQueue();
    }
  });

  // Beacon for live debugging: confirms WHICH wiring the browser executed.
  document.body.setAttribute('data-dp2d-wiring', 'v9-round9');

  var params = new URLSearchParams(window.location.search);
  if (params.has('layout')) buildLayoutPanel();

  if (params.has('preview')) {
    state.previewMode = true;
    document.body.classList.add('preview-mode');
    window.addEventListener('message', function (ev) {
      if (!ev.data) return;
      if (ev.data.type === 'dp2d-preview') bootPreviewDraft();
      else if (ev.data.type === 'dp2d-preview-results') showPreviewResultsFromDraft();
    });
    bootPreviewDraft();
    // Handshake: tell the parent editor we're listening, so its very
    // first pushPreview() isn't silently dropped before we existed.
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'dp2d-preview-ready' }, '*');
    }
    return;
  }

  if (params.has('editor')) {
    state.editorMode = true;
    buildEditor();
    showScreen('screenEditor');
    // renderEditor()'s own layoutPreviewStage() call ran while the editor
    // screen was still [hidden] (display: none), so the drawer measured
    // 0-width and the scale it computed was wrong. Now that the screen is
    // actually visible, redo the measurement once more.
    layoutPreviewStage();
    return;
  }

  refreshMenu();
  if (!tryDeepLink()) showScreen('screenMenu');
}

// Defer normally means we run before DOMContentLoaded, but guard against
// any environment that executes this script after the document is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
