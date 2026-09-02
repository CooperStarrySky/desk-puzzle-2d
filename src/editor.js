/* ════════════════════════════════════════════════════════════════════
 * editor.js — layout-mode panel, case editor, crop modal,
 *             preview plumbing, editor event handlers.
 *
 * Imports: engine.js, state.js, audio.js, ui-play.js, ui-menu.js.
 *
 * Private module vars (not exported):
 *   cropCtx, cropImg, previewTimer, previewReady, previewQueue.
 * ════════════════════════════════════════════════════════════════════ */

import {
  normalizeKinds, puzzleMachines, PIECE_KIND_NAMES,
  caseProblems, ALL_MACHINES,
} from './engine.js';

import {
  state, els,
  clamp, applyLayout, persistLayout, downloadJson, loadLayout,
  SAVE_PREFIX, LAYOUT_KEY, EDITOR_DRAFT_KEY,
} from './state.js';

import {
  SOUND_TUNING, EDITABLE_CUES, CUE_DISPLAY_NAMES,
  audio, playSound, collectSoundLayer, resetSoundLayer,
} from './audio.js';

import { syncAll, syncPieces, renderScopeView, toast, sanitizeRichHtml } from './ui-play.js';

import { openPuzzle, backToMenu, loadRegistry, loadPuzzleByEntry } from './ui-menu.js';

export function layoutPointerDown(ev) {
  var machine = ev.target.closest ? ev.target.closest('.machine') : null;
  if (!machine || machine !== els.machineScope) return false;
  ev.preventDefault();
  var deskRect = els.deskSurface.getBoundingClientRect();
  state.layoutDrag = { el: machine, deskRect: deskRect };
  return true;
}

export function layoutPointerMove(ev) {
  var ld = state.layoutDrag;
  if (!ld) return;
  ev.preventDefault();
  var fx = clamp((ev.clientX - ld.deskRect.left) / ld.deskRect.width, 0, 0.97);
  var fy = clamp((ev.clientY - ld.deskRect.top) / ld.deskRect.height, 0, 0.95);
  var key = 'scope';
  state.layout[key].fx = fx;
  state.layout[key].fy = fy;
  applyLayout();
  persistLayout();
  if (state.game) { syncPieces(); }
}

export var LAYOUT_UI_KEY = SAVE_PREFIX + 'layout-ui';

// Register layout-drag handlers on state so ui-play.js can call them
// without creating a circular import (ui-play → editor → ui-play).
state._layoutPointerDown = layoutPointerDown;
state._layoutPointerMove = layoutPointerMove;

export function devSectionState() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_UI_KEY) || '{}'); } catch (e) { return {}; }
}
export function saveDevSectionState(title, open) {
  var m = devSectionState();
  m[title] = open;
  try { localStorage.setItem(LAYOUT_UI_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
}

/** A collapsible dev-panel section (chevron summary, persisted state). */
export function devSection(parent, title, defaultOpen) {
  var d = document.createElement('details');
  d.className = 'dev-section';
  var saved = devSectionState()[title];
  d.open = saved === undefined ? !!defaultOpen : !!saved;
  var s = document.createElement('summary');
  s.textContent = title;
  d.appendChild(s);
  d.addEventListener('toggle', function () { saveDevSectionState(title, d.open); });
  parent.appendChild(d);
  return d;
}

export function devSlider(parent, labelText, min, max, step, get, set) {
  var label = document.createElement('label');
  label.textContent = labelText;
  var input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  input.addEventListener('input', function () {
    set(parseFloat(input.value));
    applyLayout();
    persistLayout();
    if (state.game) syncAll();
    renderScopeView();
  });
  parent.appendChild(label);
  parent.appendChild(input);
  return input;
}

export function buildLayoutPanel() {
  var L = state.layout;
  var panel = els.layoutPanel;
  panel.innerHTML = '';
  panel.hidden = false;
  document.body.classList.add('layout-mode');
  state.layoutMode = true;

  // slide-away tab (the whole panel gets out of the way, like the 3D editor)
  var oldTab = document.querySelector('.panel-tab');
  if (oldTab) oldTab.remove();
  var tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'panel-tab';
  tab.textContent = 'Layout';
  tab.title = 'Show/hide the layout panel';
  tab.addEventListener('click', function () {
    panel.classList.toggle('panel-hidden');
  });
  document.body.appendChild(tab);

  var h = document.createElement('h2');
  h.textContent = 'Layout mode';
  var note = document.createElement('p');
  note.className = 'lp-note';
  note.textContent = 'The wall lightbox is fixed. Drag the microscope stage on the desk directly; everything saves as you go.';
  panel.appendChild(h);
  panel.appendChild(note);

  // ── Desk & machines ──
  var secDesk = devSection(panel, 'Wall lightbox & scatter', true);
  devSlider(secDesk, 'Light box width (px)', 160, 380, 2, function () { return L.lightbox.w; }, function (v) { L.lightbox.w = v; });
  devSlider(secDesk, 'Light box height (px)', 90, 320, 2, function () { return L.lightbox.h; }, function (v) { L.lightbox.h = v; });
  devSlider(secDesk, 'Scatter band top', 0.15, 0.6, 0.01, function () { return L.scatter.lo; }, function (v) { L.scatter.lo = Math.min(v, L.scatter.hi - 0.05); });
  devSlider(secDesk, 'Scatter band bottom', 0.5, 0.98, 0.01, function () { return L.scatter.hi; }, function (v) { L.scatter.hi = Math.max(v, L.scatter.lo + 0.05); });

  // ── Piece sizes ──
  var secSizes = devSection(panel, 'Piece sizes', false);
  ['sticky', 'paper', 'slide', 'film', 'photo', 'rx'].forEach(function (t) {
    devSlider(secSizes, t, 0.6, 1.6, 0.02, function () { return L.pieceScale[t]; }, function (v) { L.pieceScale[t] = v; });
  });

  // ── Sound editor ──
  var secSound = devSection(panel, 'Sound', false);
  function soundSlider(parent, labelText, min, max, step, get, set) {
    var label = document.createElement('label');
    label.textContent = labelText;
    var input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(get());
    input.addEventListener('input', function () {
      set(parseFloat(input.value));
      persistLayout();
    });
    parent.appendChild(label);
    parent.appendChild(input);
  }
  soundSlider(secSound, 'Master volume', 0, 1, 0.02,
    function () { return SOUND_TUNING.master; },
    function (v) { SOUND_TUNING.master = v; if (audio.master) audio.master.gain.value = v; });

  var cueHead = document.createElement('label');
  cueHead.textContent = 'Cue gains (▶ to audition)';
  secSound.appendChild(cueHead);
  EDITABLE_CUES.forEach(function (cue) {
    var row = document.createElement('div');
    row.className = 'cue-row';
    var name = document.createElement('span');
    name.className = 'cue-name';
    name.textContent = CUE_DISPLAY_NAMES[cue] || cue;
    var input = document.createElement('input');
    input.type = 'range';
    input.min = '0'; input.max = '0.6'; input.step = '0.01';
    input.value = String(SOUND_TUNING[cue].gain);
    input.addEventListener('input', function () {
      SOUND_TUNING[cue].gain = parseFloat(input.value);
      persistLayout();
    });
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn';
    play.textContent = '▶';
    play.setAttribute('aria-label', 'Play ' + cue);
    play.addEventListener('click', function () { playSound(cue); });
    row.appendChild(name); row.appendChild(input); row.appendChild(play);
    secSound.appendChild(row);
  });

  var dragHead = document.createElement('label');
  dragHead.textContent = 'Drag scrape (default path)';
  secSound.appendChild(dragHead);
  var sc = SOUND_TUNING.scrape;
  soundSlider(secSound, 'Gate on (px/s)', 80, 600, 5, function () { return sc.vOn; }, function (v) { sc.vOn = v; });
  soundSlider(secSound, 'Gate off (px/s)', 30, 400, 5, function () { return sc.vOff; }, function (v) { sc.vOff = Math.min(v, sc.vOn - 10); });
  soundSlider(secSound, 'Grain spacing (px)', 40, 220, 2, function () { return sc.grainPx; }, function (v) { sc.grainPx = v; });
  soundSlider(secSound, 'Grain cooldown (ms)', 30, 140, 1, function () { return sc.cooldownMs; }, function (v) { sc.cooldownMs = v; });
  soundSlider(secSound, 'Gain at gate', 0.05, 1, 0.01, function () { return sc.gainLo; }, function (v) { sc.gainLo = v; });
  soundSlider(secSound, 'Gain at speed ref', 0.2, 1.4, 0.01, function () { return sc.gainHi; }, function (v) { sc.gainHi = v; });
  soundSlider(secSound, 'Speed ref (px/s)', 600, 2400, 20, function () { return sc.vRef; }, function (v) { sc.vRef = v; });
  soundSlider(secSound, 'Pitch low', 0.8, 1, 0.005, function () { return sc.pitchLo; }, function (v) { sc.pitchLo = v; });
  soundSlider(secSound, 'Pitch high', 1, 1.25, 0.005, function () { return sc.pitchHi; }, function (v) { sc.pitchHi = v; });
  soundSlider(secSound, 'Volume jitter (dB)', 0, 5, 0.1, function () { return sc.volJitterDb; }, function (v) { sc.volJitterDb = v; });
  soundSlider(secSound, 'Paper grain gain', 0, 0.3, 0.005, function () { return sc.materials.paper.gain; }, function (v) { sc.materials.paper.gain = v; });
  soundSlider(secSound, 'Glass grain gain', 0, 0.3, 0.005, function () { return sc.materials.slide.gain; }, function (v) { sc.materials.slide.gain = v; });
  soundSlider(secSound, 'Film grain gain', 0, 0.3, 0.005, function () { return sc.materials.film.gain; }, function (v) { sc.materials.film.gain = v; });

  var soundReset = document.createElement('button');
  soundReset.type = 'button';
  soundReset.className = 'btn btn-ghost';
  soundReset.textContent = 'Reset sound to defaults';
  soundReset.addEventListener('click', function () {
    resetSoundLayer();
    persistLayout();
    buildLayoutPanel();
  });
  secSound.appendChild(soundReset);

  // ── actions ──
  var actions = document.createElement('div');
  actions.className = 'lp-actions';
  var exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn btn-primary';
  exportBtn.textContent = 'Export layout JSON';
  exportBtn.addEventListener('click', function () {
    state.layout.sound = collectSoundLayer();
    downloadJson('layout.json', state.layout);
    toast('Downloaded layout.json — drop it next to index.html to publish this layout.');
  });
  var resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn btn-ghost';
  resetBtn.textContent = 'Reset to defaults';
  resetBtn.addEventListener('click', function () {
    try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* ignore */ }
    resetSoundLayer();
    loadLayout().then(function () {
      applyLayout();
      if (state.game) syncAll();
      buildLayoutPanel();
    });
  });
  actions.appendChild(exportBtn);
  actions.appendChild(resetBtn);
  var publishNote = document.createElement('p');
  publishNote.className = 'lp-note';
  publishNote.textContent = 'Save the exported file as "layout.json" in the project root, right next to index.html. The game loads it automatically for everyone on next reload (your own browser’s live edits here still win over it until you clear them).';
  panel.appendChild(actions);
  panel.appendChild(publishNote);
}

/* ════════════════════════════════════════════════════════════════════
 * DEV — PUZZLE CREATOR (?editor), v2.
 * Group-centric authoring: four group cards, each holding its 4 items;
 * piece types picked by friendly names; machine toggles with inline
 * cross-check warnings; field-level validation as you type; a single
 * "ready to export" chip; and a live preview iframe (?preview) that
 * re-renders the real game ~300ms after each edit.
 * ════════════════════════════════════════════════════════════════════ */

export var KIND_ORDER = ['corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx'];

export function loadEditorDraft() {
  try {
    var raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    if (raw) return normalizeDraft(JSON.parse(raw));
  } catch (e) { /* fall through */ }
  return normalizeDraft({});
}

export function saveEditorDraft() {
  try { localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(state.editorDraft)); } catch (e) { /* ignore */ }
}

/** Coerce any draft into the editor's shape: 4 groups × exactly 4 item
    ids, 16 items, machines list explicit. Old files load unchanged. */
export function normalizeDraft(d) {
  d = (d && typeof d === 'object') ? d : {};
  normalizeKinds(d);
  d.id = d.id || 'my-puzzle';
  d.title = d.title || 'My Puzzle';
  d.date = d.date || new Date().toISOString().slice(0, 10);
  if (!Array.isArray(d.groups)) d.groups = [];
  if (!Array.isArray(d.items)) d.items = [];
  d.machines = puzzleMachines(d);

  var itemsById = {};
  d.items.forEach(function (i) { if (i && i.id) itemsById[i.id] = i; });

  var usedIds = new Set();
  var groups = [];
  var items = [];
  for (var g = 0; g < 4; g++) {
    var src = d.groups[g] || {};
    var grp = {
      id: src.id || 'group-' + (g + 1),
      name: src.name || '',
      tier: [1, 2, 3, 4].indexOf(src.tier) !== -1 ? src.tier : (g + 1),
      explanation: src.explanation || '',
      itemIds: [],
    };
    if (Array.isArray(src.article)) grp.article = src.article;
    for (var m = 0; m < 4; m++) {
      var iid = Array.isArray(src.itemIds) ? src.itemIds[m] : null;
      var item = (iid && itemsById[iid] && !usedIds.has(iid)) ? itemsById[iid] : null;
      if (!item) {
        item = { id: 'g' + (g + 1) + '-item' + (m + 1), label: '', zone: 'corkboard' };
      }
      if (!PIECE_KIND_NAMES[item.zone]) item.zone = 'corkboard';
      while (usedIds.has(item.id)) item.id += 'x';
      usedIds.add(item.id);
      grp.itemIds.push(item.id);
      items.push(item);
    }
    groups.push(grp);
  }
  d.groups = groups;
  d.items = items;
  return d;
}

/* ── Import: load an existing puzzle case back into the editor ──────
 * Two entry points feed the same funnel: a file picked from disk, or a
 * puzzle chosen from the live registry (puzzles/index.json). Both parse
 * to a plain object, get validated with the same caseProblems() the
 * status chip uses, then (after an unsaved-work guard) replace the
 * draft, get normalized exactly like any freshly-loaded draft would be,
 * re-render the whole editor, and push the new draft to the preview. */

/** True if the draft is still the untouched starter puzzle — safe to
    replace without asking. Anything else (including a puzzle loaded a
    moment ago) prompts a confirm before being overwritten. */
export function draftIsPristine(d) {
  try {
    var fresh = normalizeDraft({});
    return JSON.stringify(fresh) === JSON.stringify(d);
  } catch (e) { return false; }
}

/** Validate + (optionally, after a confirm) load `candidate` into the
    editor draft. Returns true on success; leaves the current draft
    untouched and toasts a reason on any failure. */
export function importCaseIntoEditor(candidate, sourceLabel) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    toast('That file isn’t a puzzle (not a JSON object).');
    return false;
  }
  var problems = caseProblems(candidate);
  if (problems.length) {
    toast('Can’t load that puzzle — ' + problems[0] +
      (problems.length > 1 ? ' (+' + (problems.length - 1) + ' more issue' + (problems.length > 2 ? 's' : '') + ')' : '') + '.');
    return false;
  }
  if (!draftIsPristine(state.editorDraft) &&
    !window.confirm('Replace the current draft with this puzzle? Unsaved edits in the editor will be lost.')) {
    return false;
  }
  state.editorDraft = normalizeDraft(JSON.parse(JSON.stringify(candidate)));
  saveEditorDraft();
  renderEditor();
  toast('Loaded “' + (state.editorDraft.title || state.editorDraft.id) + '”' + (sourceLabel ? ' (' + sourceLabel + ')' : '') + ' into the editor.');
  return true;
}

/** Slug for auto ids: "Right lung" -> "right-lung". */
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

/** Item at group g, slot m of the draft (always exists after normalize). */
export function draftItem(g, m) {
  var id = state.editorDraft.groups[g].itemIds[m];
  return state.editorDraft.items.find(function (i) { return i.id === id; });
}

/** Re-id an item from its label, keeping ids unique + groups in sync. */
export function autoId(g, m) {
  var d = state.editorDraft;
  var item = draftItem(g, m);
  var base = slugify(item.label || 'g' + (g + 1) + '-item' + (m + 1));
  var id = base, n = 2;
  while (d.items.some(function (i) { return i !== item && i.id === id; })) id = base + '-' + n++;
  item.id = id;
  d.groups[g].itemIds[m] = id;
}

/* ── Rendering ───────────────────────────────────────────────────── */

export function buildEditor() {
  state.editorDraft = loadEditorDraft();
  renderEditor();
}

export function renderEditor() {
  var d = state.editorDraft;
  var root = els.screenEditor;
  root.innerHTML = '';

  // ── The live preview renders at a fixed logical size captured once
  // when the editor first boots, then a CSS transform scales it to fit
  // whatever's left beside the drawer — see layoutPreviewStage(). ──
  if (!state.previewV) state.previewV = { w: window.innerWidth, h: window.innerHeight };
  previewReady = false;
  previewQueue = [];

  var stage = document.createElement('div');
  stage.className = 'editor-preview-stage';
  var iframe = document.createElement('iframe');
  iframe.id = 'preview-frame';
  iframe.title = 'Live puzzle preview';
  iframe.src = '?preview&v=19';
  iframe.addEventListener('load', function () {
    // Belt-and-suspenders: if the ready handshake message was somehow
    // missed, the iframe finishing its own load is a second chance to
    // (re-)send the current draft — postToPreview queues harmlessly if
    // the child hasn't signaled ready yet.
    postToPreview({ type: 'dp2d-preview' });
  });
  stage.appendChild(iframe);
  root.appendChild(stage);

  // ── The authoring form is a collapsible slide-away drawer over it,
  // same pattern as the ?layout panel: an edge tab toggles it. ──
  var oldTab = document.querySelector('.panel-tab');
  if (oldTab) oldTab.remove();
  var tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'panel-tab';
  tab.textContent = 'Editor';
  tab.title = 'Show/hide the puzzle editor';
  tab.addEventListener('click', function () {
    drawer.classList.toggle('panel-hidden');
    layoutPreviewStage();
  });
  root.appendChild(tab);

  var drawer = document.createElement('div');
  drawer.className = 'editor-drawer';
  drawer.style.setProperty('--drawer-w', clampDrawerWidth(loadEditorUi().drawerW || 400) + 'px');

  var resizeHandle = document.createElement('div');
  resizeHandle.className = 'drawer-resize-handle';
  resizeHandle.title = 'Drag to resize';
  bindDrawerResize(resizeHandle, drawer);
  drawer.appendChild(resizeHandle);

  var h1 = document.createElement('h1');
  h1.textContent = 'Puzzle Creator';
  var sub = document.createElement('p');
  sub.className = 'editor-sub';
  sub.textContent = 'Build a puzzle group by group. Everything saves as you type, and the preview behind this panel plays it live.';
  drawer.appendChild(h1);
  drawer.appendChild(sub);

  // ── Top bar: status chip, meta, machine toggles, actions ──
  var bar = document.createElement('div');
  bar.className = 'editor-topbar';

  var chip = document.createElement('span');
  chip.className = 'status-chip';
  chip.id = 'editor-status-chip';
  bar.appendChild(chip);

  var meta = document.createElement('div');
  meta.className = 'editor-meta';
  [['id', 'text'], ['title', 'text'], ['date', 'date']].forEach(function (pair) {
    var label = document.createElement('label');
    label.textContent = pair[0] + ' ';
    var input = document.createElement('input');
    input.type = pair[1];
    input.dataset.meta = pair[0];
    input.value = d[pair[0]] || '';
    label.appendChild(input);
    meta.appendChild(label);
  });
  bar.appendChild(meta);

  var toggles = document.createElement('div');
  toggles.className = 'machine-toggles';
  toggles.id = 'machine-toggles';
  bar.appendChild(toggles);

  var actions = document.createElement('div');
  actions.className = 'editor-actions';

  // ── Import: load an existing puzzle back in to edit + re-export ──
  var importFile = document.createElement('input');
  importFile.type = 'file';
  importFile.accept = 'application/json,.json';
  importFile.className = 'sr-only';
  importFile.id = 'editor-import-file';
  importFile.addEventListener('change', function () {
    var f = importFile.files && importFile.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        toast('That file isn’t valid JSON.');
        importFile.value = '';
        return;
      }
      importCaseIntoEditor(parsed, f.name);
      importFile.value = '';
    };
    reader.onerror = function () {
      toast('Couldn’t read that file.');
      importFile.value = '';
    };
    reader.readAsText(f);
  });
  actions.appendChild(importFile);
  actions.appendChild(editorActionBtn('Load puzzle file', 'btn', function () {
    importFile.click();
  }));

  var librarySelect = document.createElement('select');
  librarySelect.className = 'editor-library-select';
  librarySelect.id = 'editor-library-select';
  librarySelect.title = 'Load an existing puzzle from the library into the editor';
  var placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = 'Load from library…';
  librarySelect.appendChild(placeholderOpt);
  loadRegistry().then(function (registry) {
    (registry.puzzles || []).forEach(function (entry) {
      var opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = entry.title || entry.id;
      librarySelect.appendChild(opt);
    });
  });
  librarySelect.addEventListener('change', function () {
    var id = librarySelect.value;
    librarySelect.value = '';
    if (!id) return;
    loadRegistry().then(function (registry) {
      var entry = (registry.puzzles || []).find(function (p) { return p.id === id; });
      if (!entry) { toast('That puzzle isn’t in the library anymore.'); return; }
      loadPuzzleByEntry(entry).then(function (candidate) {
        importCaseIntoEditor(candidate, entry.title);
      }).catch(function (err) {
        toast('Couldn’t load “' + entry.title + '”: ' + err.message);
      });
    });
  });
  actions.appendChild(librarySelect);

  actions.appendChild(editorActionBtn('Test Play', 'btn btn-primary', function () {
    var problems = caseProblems(state.editorDraft);
    if (problems.length) { toast('Fix the flagged problems first.'); return; }
    openPuzzle(JSON.parse(JSON.stringify(state.editorDraft)));
  }));
  actions.appendChild(editorActionBtn('Preview results', 'btn', function () {
    var problems = caseProblems(state.editorDraft);
    if (problems.length) { toast('Fix the flagged problems first.'); return; }
    postToPreview({ type: 'dp2d-preview-results' });
  }));
  actions.appendChild(editorActionBtn('Export puzzle JSON', 'btn', function () {
    downloadJson((state.editorDraft.id || 'puzzle') + '.json', state.editorDraft);
  }));
  actions.appendChild(editorActionBtn('Export index.json', 'btn', function () {
    loadRegistry().then(function (registry) {
      var d2 = state.editorDraft;
      var entry = { id: d2.id, title: d2.title, date: d2.date, file: d2.id + '.json' };
      var list = (registry.puzzles || []).filter(function (p) { return p.id !== d2.id; });
      list.push(entry);
      downloadJson('index.json', { current: d2.id, puzzles: list });
    });
  }));
  actions.appendChild(editorActionBtn('Start over', 'btn btn-ghost', function () {
    try { localStorage.removeItem(EDITOR_DRAFT_KEY); } catch (e) { /* ignore */ }
    buildEditor();
    pushPreview();
  }));
  actions.appendChild(editorActionBtn('Back to menu', 'btn btn-ghost', backToMenu));
  bar.appendChild(actions);
  drawer.appendChild(bar);

  // ── Group cards (each already a collapsible <details>) ──
  var groupsWrap = document.createElement('div');
  groupsWrap.className = 'editor-groups';
  for (var g = 0; g < 4; g++) groupsWrap.appendChild(renderGroupCard(g));
  drawer.appendChild(groupsWrap);

  var note = document.createElement('p');
  note.className = 'preview-note';
  note.textContent = 'The real game, replayed on every edit, fills the screen behind this panel — usually within a couple hundred milliseconds, no Test Play needed. Drag the drawer\'s left edge to resize it, or use the tab to tuck it away for a full-screen preview.';
  drawer.appendChild(note);

  root.appendChild(drawer);

  renderMachineToggles();
  refreshEditorStatus();
  pushPreview();
  layoutPreviewStage();
}

export function renderGroupCard(g) {
  var d = state.editorDraft;
  var grp = d.groups[g];
  var card = document.createElement('details');
  card.open = true;
  card.className = 'group-card';
  card.style.setProperty('--gc', 'var(--tier-' + grp.tier + ')');
  card.dataset.g = String(g);

  var title = document.createElement('summary');
  title.className = 'gc-title';
  title.textContent = 'Group ' + (g + 1);
  card.appendChild(title);

  var row = document.createElement('div');
  row.className = 'gc-row';
  var name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Group name (revealed on solve)';
  name.dataset.g = String(g);
  name.dataset.gfield = 'name';
  name.value = grp.name;
  row.appendChild(name);
  var tier = document.createElement('select');
  tier.dataset.g = String(g);
  tier.dataset.gfield = 'tier';
  [1, 2, 3, 4].forEach(function (t) {
    var o = document.createElement('option');
    o.value = String(t);
    o.textContent = 'Tier ' + t;
    if (t === grp.tier) o.selected = true;
    tier.appendChild(o);
  });
  row.appendChild(tier);
  card.appendChild(row);

  var nameFeedback = document.createElement('p');
  nameFeedback.className = 'field-feedback';
  nameFeedback.dataset.feedbackFor = 'gname-' + g;
  nameFeedback.hidden = true;
  card.appendChild(nameFeedback);

  var expl = document.createElement('input');
  expl.type = 'text';
  expl.placeholder = 'One-line explanation shown on the results screen';
  expl.dataset.g = String(g);
  expl.dataset.gfield = 'explanation';
  expl.value = grp.explanation;
  card.appendChild(expl);

  card.appendChild(renderArticleSection(g));

  for (var m = 0; m < 4; m++) card.appendChild(renderItemEditor(g, m));
  return card;
}

/** Collapsible "Article" authoring block for one group: an ordered list
    of heading/paragraph/image blocks (each with ↑ ↓ ✕ controls) plus
    add-buttons. Optional — a group with no blocks renders on the results
    screen exactly as it always has (placard + one-line explanation). */
export function renderArticleSection(g) {
  var grp = state.editorDraft.groups[g];
  var blocks = Array.isArray(grp.article) ? grp.article : [];
  var section = document.createElement('details');
  section.className = 'article-section';
  section.open = blocks.length > 0;

  var sum = document.createElement('summary');
  sum.textContent = 'Article' + (blocks.length ? ' (' + blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ')' : ' (optional — long-form explanation for the results screen)');
  section.appendChild(sum);

  var list = document.createElement('div');
  list.className = 'article-blocks';
  blocks.forEach(function (block, bi) {
    list.appendChild(renderArticleBlockEditor(g, bi, block, blocks.length));
  });
  section.appendChild(list);

  var addRow = document.createElement('div');
  addRow.className = 'article-add-row';
  [['heading', '+ Heading'], ['text', '+ Paragraph'], ['image', '+ Image']].forEach(function (pair) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost article-add-btn';
    btn.dataset.g = String(g);
    btn.dataset.articleAdd = pair[0];
    btn.textContent = pair[1];
    addRow.appendChild(btn);
  });
  section.appendChild(addRow);

  return section;
}

/** Bold/Italic/Underline/Clear toolbar for one rich text block. Buttons
    use execCommand on the currently-focused rich-editable — mousedown
    (handled in onEditorMousedown) preventDefaults so the field never
    loses focus/selection before the command fires. */
export function richToolbar(g, bi) {
  var bar = document.createElement('div');
  bar.className = 'rich-toolbar';
  [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['removeFormat', 'Clear']].forEach(function (pair) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rich-btn' + (pair[0] === 'removeFormat' ? ' rich-btn-clear' : '');
    btn.textContent = pair[1];
    btn.title = pair[0] === 'removeFormat' ? 'Clear formatting' : pair[1];
    btn.dataset.g = String(g);
    btn.dataset.blockIndex = String(bi);
    btn.dataset.richCmd = pair[0];
    bar.appendChild(btn);
  });
  return bar;
}

/** A contenteditable div storing restricted HTML (see sanitizeRichHtml).
    Initialized through the sanitizer too, so a hand-edited draft or an
    imported puzzle file can never seed the editor with unsafe markup. */
export function richEditable(g, bi, placeholder, extraClass, text) {
  var el = document.createElement('div');
  el.className = 'rich-editable ' + extraClass;
  el.contentEditable = 'true';
  el.dataset.g = String(g);
  el.dataset.blockIndex = String(bi);
  el.dataset.bfield = 'text';
  el.dataset.rich = '1';
  el.setAttribute('data-placeholder', placeholder);
  el.innerHTML = sanitizeRichHtml(text || '');
  return el;
}

export function renderArticleBlockEditor(g, bi, block, total) {
  var row = document.createElement('div');
  row.className = 'article-block';
  row.dataset.g = String(g);
  row.dataset.blockIndex = String(bi);

  var head = document.createElement('div');
  head.className = 'article-block-head';
  var typeLabel = document.createElement('span');
  typeLabel.className = 'article-block-type';
  typeLabel.textContent = block.type === 'heading' ? 'Heading' : block.type === 'image' ? 'Image' : 'Paragraph';
  head.appendChild(typeLabel);

  var controls = document.createElement('div');
  controls.className = 'article-block-controls';
  var up = document.createElement('button');
  up.type = 'button';
  up.className = 'article-move';
  up.textContent = '↑';
  up.title = 'Move up';
  up.dataset.g = String(g);
  up.dataset.blockIndex = String(bi);
  up.dataset.articleMove = 'up';
  up.disabled = bi === 0;
  var down = document.createElement('button');
  down.type = 'button';
  down.className = 'article-move';
  down.textContent = '↓';
  down.title = 'Move down';
  down.dataset.g = String(g);
  down.dataset.blockIndex = String(bi);
  down.dataset.articleMove = 'down';
  down.disabled = bi === total - 1;
  var rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'article-remove';
  rm.textContent = '✕';
  rm.title = 'Remove block';
  rm.dataset.g = String(g);
  rm.dataset.blockIndex = String(bi);
  rm.dataset.articleRemove = '1';
  controls.appendChild(up);
  controls.appendChild(down);
  controls.appendChild(rm);
  head.appendChild(controls);
  row.appendChild(head);

  if (block.type === 'heading') {
    row.appendChild(richToolbar(g, bi));
    var hInput = richEditable(g, bi, 'Heading text', 'rich-editable-heading', block.text);
    row.appendChild(hInput);
  } else if (block.type === 'text') {
    row.appendChild(richToolbar(g, bi));
    var ta = richEditable(g, bi, 'Paragraph text', 'rich-editable-text', block.text);
    row.appendChild(ta);
  } else if (block.type === 'image') {
    var fileLabel = document.createElement('label');
    fileLabel.textContent = 'image ';
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = 'item-file';
    file.dataset.g = String(g);
    file.dataset.blockIndex = String(bi);
    file.dataset.bfile = 'src';
    fileLabel.appendChild(file);
    row.appendChild(fileLabel);
    if (block.src) row.appendChild(fileSetMark());
    var capInput = document.createElement('input');
    capInput.type = 'text';
    capInput.placeholder = 'Caption (optional)';
    capInput.dataset.g = String(g);
    capInput.dataset.blockIndex = String(bi);
    capInput.dataset.bfield = 'caption';
    capInput.value = block.caption || '';
    row.appendChild(capInput);
  }

  return row;
}

/** Re-render just one group's article section in place (structural edits
    — add/move/remove a block — need a fresh render; text edits don't). */
export function refreshGroupArticle(g) {
  var card = document.querySelector('.group-card[data-g="' + g + '"]');
  if (!card) return;
  var old = card.querySelector('.article-section');
  var fresh = renderArticleSection(g);
  if (old) card.replaceChild(fresh, old); else card.appendChild(fresh);
}

export function renderItemEditor(g, m) {
  var item = draftItem(g, m);
  var box = document.createElement('div');
  box.className = 'item-editor';
  box.dataset.g = String(g);
  box.dataset.m = String(m);

  var row = document.createElement('div');
  row.className = 'item-row';
  var label = document.createElement('input');
  label.type = 'text';
  label.placeholder = 'Piece ' + (m + 1) + ' label';
  label.dataset.g = String(g);
  label.dataset.m = String(m);
  label.dataset.ifield = 'label';
  label.value = item.label || '';
  row.appendChild(label);
  var color = document.createElement('input');
  color.type = 'color';
  color.title = 'Piece color (sticky notes and fallbacks)';
  color.dataset.g = String(g);
  color.dataset.m = String(m);
  color.dataset.ifield = 'color';
  color.value = (item.appearance && item.appearance.color) || '#f6e58d';
  row.appendChild(color);
  box.appendChild(row);

  var feedback = document.createElement('p');
  feedback.className = 'field-feedback';
  feedback.dataset.feedbackFor = 'label-' + g + '-' + m;
  feedback.hidden = true;
  box.appendChild(feedback);

  var chips = document.createElement('div');
  chips.className = 'kind-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Piece type');
  KIND_ORDER.forEach(function (kind) {
    var chipBtn = document.createElement('button');
    chipBtn.type = 'button';
    chipBtn.className = 'kind-chip' + (item.zone === kind ? ' is-active' : '');
    chipBtn.dataset.g = String(g);
    chipBtn.dataset.m = String(m);
    chipBtn.dataset.kind = kind;
    chipBtn.setAttribute('aria-pressed', String(item.zone === kind));
    chipBtn.textContent = PIECE_KIND_NAMES[kind];
    chips.appendChild(chipBtn);
  });
  box.appendChild(chips);

  var files = document.createElement('div');
  files.className = 'adv-row';
  var imgLabel = document.createElement('label');
  imgLabel.textContent = 'image ';
  var img = document.createElement('input');
  img.type = 'file';
  img.accept = 'image/*';
  img.className = 'item-file';
  img.dataset.g = String(g);
  img.dataset.m = String(m);
  img.dataset.ifile = 'info.image';
  imgLabel.appendChild(img);
  files.appendChild(imgLabel);
  if (item.info && item.info.image) files.appendChild(fileSetMark());
  if (item.zone === 'rack') {
    var scopeLabel = document.createElement('label');
    scopeLabel.textContent = 'scope image ';
    var sc = document.createElement('input');
    sc.type = 'file';
    sc.accept = 'image/*';
    sc.className = 'item-file';
    sc.dataset.g = String(g);
    sc.dataset.m = String(m);
    sc.dataset.ifile = 'scope.image';
    scopeLabel.appendChild(sc);
    files.appendChild(scopeLabel);
    if (item.scope && item.scope.image) files.appendChild(fileSetMark());
  }
  box.appendChild(files);

  var adv = document.createElement('details');
  var sum = document.createElement('summary');
  sum.textContent = 'Advanced';
  adv.appendChild(sum);
  var advRow = document.createElement('div');
  advRow.className = 'adv-row';
  var idNote = document.createElement('span');
  idNote.textContent = 'id: ' + item.id + ' (from the label)';
  advRow.appendChild(idNote);
  var infoTitle = document.createElement('input');
  infoTitle.type = 'text';
  infoTitle.placeholder = 'spoken title';
  infoTitle.dataset.g = String(g);
  infoTitle.dataset.m = String(m);
  infoTitle.dataset.ifield = 'infoTitle';
  infoTitle.value = (item.info && item.info.title) || '';
  advRow.appendChild(infoTitle);
  var infoText = document.createElement('input');
  infoText.type = 'text';
  infoText.placeholder = 'spoken clue text';
  infoText.dataset.g = String(g);
  infoText.dataset.m = String(m);
  infoText.dataset.ifield = 'infoText';
  infoText.value = (item.info && item.info.text) || '';
  advRow.appendChild(infoText);
  adv.appendChild(advRow);

  // Clue text size override — multiplies the auto-fit result computed at
  // play time (see fitPieceLabels() in game.js). Absent (the default:
  // slider centered on 100%, no override stored) means the piece just
  // auto-fits like every other; this is only for nudging one stubborn
  // long clue smaller, or overriding a piece an author wants bigger.
  var sizeRow = document.createElement('div');
  sizeRow.className = 'adv-row label-scale-row';
  var sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'clue text size';
  sizeRow.appendChild(sizeLabel);
  var sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = '0.6';
  sizeInput.max = '1.4';
  sizeInput.step = '0.05';
  sizeInput.dataset.g = String(g);
  sizeInput.dataset.m = String(m);
  sizeInput.dataset.ifield = 'labelScale';
  sizeInput.value = String(isFinite(item.labelScale) ? item.labelScale : 1);
  sizeRow.appendChild(sizeInput);
  var sizeReadout = document.createElement('span');
  sizeReadout.className = 'label-scale-readout';
  sizeReadout.textContent = isFinite(item.labelScale) ? Math.round(item.labelScale * 100) + '%' : 'auto';
  sizeRow.appendChild(sizeReadout);
  var sizeReset = document.createElement('button');
  sizeReset.type = 'button';
  sizeReset.className = 'btn';
  sizeReset.textContent = 'Auto';
  sizeReset.title = 'Clear the override, back to pure auto-fit';
  sizeReset.dataset.g = String(g);
  sizeReset.dataset.m = String(m);
  sizeReset.dataset.labelScaleReset = '1';
  sizeRow.appendChild(sizeReset);
  adv.appendChild(sizeRow);

  box.appendChild(adv);

  return box;
}

export function fileSetMark() {
  var s = document.createElement('span');
  s.className = 'preview-note';
  s.textContent = '✓ set';
  return s;
}

export function editorActionBtn(text, cls, fn) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = text;
  btn.addEventListener('click', fn);
  return btn;
}

export function renderMachineToggles() {
  var d = state.editorDraft;
  var wrap = document.getElementById('machine-toggles');
  if (!wrap) return;
  wrap.innerHTML = '';
  var NAMES = { scope: 'Microscope', lightbox: 'Wall lightbox' };
  var WARNS = {
    scope: 'This puzzle has slides; they need the microscope.',
    lightbox: 'This puzzle has X-ray films; they need the light box.',
  };
  var needs = {
    scope: d.items.some(function (i) { return i.zone === 'rack'; }),
    lightbox: d.items.some(function (i) { return i.zone === 'tubes'; }),
  };
  ALL_MACHINES.forEach(function (mch) {
    var div = document.createElement('div');
    div.className = 'machine-toggle';
    var label = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.machine = mch;
    cb.checked = d.machines.indexOf(mch) !== -1;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(NAMES[mch]));
    div.appendChild(label);
    if (needs[mch] && !cb.checked) {
      var warn = document.createElement('span');
      warn.className = 'machine-warn';
      warn.textContent = WARNS[mch];
      div.appendChild(warn);
    }
    wrap.appendChild(div);
  });
}

/* ── Image upload crop/zoom/reposition modal ─────────────────────────
 * Every editor image upload (article image blocks, item photo/scope
 * image) funnels through openCropModal(): the raw FileReader data URI
 * goes in, the user frames it in a fixed 4:3 viewport (zoom + drag,
 * mouse or touch), and on confirm the ALREADY-CROPPED canvas render —
 * not the original — is what onConfirm(dataUrl) receives and stores.
 * Default framing is "cover" (whole frame filled, centered, no zoom
 * beyond the minimum needed) so confirming immediately with no
 * adjustment still produces a sane result. ──────────────────────── */

export var CROP_OUT_W = 640, CROP_OUT_H = 480; // stored/output resolution (4:3)
var cropCtx = null;   // { onConfirm }
var cropImg = null;   // { el, natW, natH, coverScale, zoomMul, offX, offY }

export function buildCropModal() {
  if (els.cropOverlay) return;
  var overlay = document.createElement('div');
  overlay.className = 'overlay crop-overlay';
  overlay.id = 'crop-overlay';
  overlay.hidden = true;

  var card = document.createElement('div');
  card.className = 'overlay-card crop-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  var h2 = document.createElement('h2');
  h2.textContent = 'Position the image';
  card.appendChild(h2);

  var frame = document.createElement('div');
  frame.className = 'crop-frame';
  var canvas = document.createElement('canvas');
  canvas.className = 'crop-canvas';
  canvas.width = CROP_OUT_W;
  canvas.height = CROP_OUT_H;
  frame.appendChild(canvas);
  card.appendChild(frame);

  var controls = document.createElement('div');
  controls.className = 'crop-controls';
  var zoomLabel = document.createElement('label');
  zoomLabel.textContent = 'Zoom ';
  var zoom = document.createElement('input');
  zoom.type = 'range';
  zoom.min = '1';
  zoom.max = '4';
  zoom.step = '0.01';
  zoom.value = '1';
  zoomLabel.appendChild(zoom);
  controls.appendChild(zoomLabel);
  card.appendChild(controls);

  var instructions = document.createElement('p');
  instructions.className = 'crop-instructions';
  instructions.textContent = 'Drag to reposition. Scroll, pinch, or use the slider to zoom.';
  card.appendChild(instructions);

  var actions = document.createElement('div');
  actions.className = 'overlay-actions';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = 'Cancel';
  var confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn btn-primary';
  confirm.textContent = 'Use image';
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  els.cropOverlay = overlay;
  els.cropCanvas = canvas;
  els.cropZoom = zoom;
  els.cropCancel = cancel;
  els.cropConfirm = confirm;

  canvas.addEventListener('pointerdown', cropPointerDown);
  canvas.addEventListener('wheel', cropWheel, { passive: false });
  zoom.addEventListener('input', function () { setCropZoom(Number(zoom.value)); });
  cancel.addEventListener('click', closeCropModal);
  confirm.addEventListener('click', confirmCropModal);
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeCropModal(); });
}

/** dataUrl: the raw FileReader result. onConfirm(croppedDataUrl) fires
    once, only on confirm — cancel calls nothing. */
export function openCropModal(dataUrl, onConfirm) {
  buildCropModal();
  cropCtx = { onConfirm: onConfirm };
  els.cropOverlay.hidden = false;
  var img = new Image();
  img.onload = function () {
    var coverScale = Math.max(CROP_OUT_W / img.naturalWidth, CROP_OUT_H / img.naturalHeight);
    cropImg = {
      el: img,
      natW: img.naturalWidth,
      natH: img.naturalHeight,
      coverScale: coverScale,
      zoomMul: 1, // multiplier over coverScale; 1 = default "whole frame, no extra zoom"
      offX: 0,
      offY: 0,
    };
    centerCropImage();
    els.cropZoom.value = '1';
    renderCropCanvas();
  };
  img.src = dataUrl;
}

export function closeCropModal() {
  if (els.cropOverlay) els.cropOverlay.hidden = true;
  cropCtx = null;
  cropImg = null;
}

export function confirmCropModal() {
  if (!cropCtx || !cropImg) { closeCropModal(); return; }
  var dataUrl = els.cropCanvas.toDataURL('image/jpeg', 0.85);
  var cb = cropCtx.onConfirm;
  closeCropModal();
  if (cb) cb(dataUrl);
}

export function centerCropImage() {
  var scale = cropImg.coverScale * cropImg.zoomMul;
  cropImg.offX = (CROP_OUT_W - cropImg.natW * scale) / 2;
  cropImg.offY = (CROP_OUT_H - cropImg.natH * scale) / 2;
}

export function clampCropOffsets() {
  var scale = cropImg.coverScale * cropImg.zoomMul;
  var w = cropImg.natW * scale, h = cropImg.natH * scale;
  cropImg.offX = clamp(cropImg.offX, CROP_OUT_W - w, 0);
  cropImg.offY = clamp(cropImg.offY, CROP_OUT_H - h, 0);
}

export function setCropZoom(mul) {
  if (!cropImg) return;
  var prevScale = cropImg.coverScale * cropImg.zoomMul;
  // Keep the frame's center point anchored while zooming, not the image's
  // top-left corner, so zooming feels like it's centered on the viewport.
  var cx = (CROP_OUT_W / 2 - cropImg.offX) / prevScale;
  var cy = (CROP_OUT_H / 2 - cropImg.offY) / prevScale;
  cropImg.zoomMul = clamp(mul, 1, 4);
  var scale = cropImg.coverScale * cropImg.zoomMul;
  cropImg.offX = CROP_OUT_W / 2 - cx * scale;
  cropImg.offY = CROP_OUT_H / 2 - cy * scale;
  clampCropOffsets();
  els.cropZoom.value = String(cropImg.zoomMul);
  renderCropCanvas();
}

export function renderCropCanvas() {
  if (!cropImg) return;
  var ctx = els.cropCanvas.getContext('2d');
  var scale = cropImg.coverScale * cropImg.zoomMul;
  ctx.clearRect(0, 0, CROP_OUT_W, CROP_OUT_H);
  ctx.drawImage(cropImg.el, cropImg.offX, cropImg.offY, cropImg.natW * scale, cropImg.natH * scale);
}

export function cropWheel(ev) {
  if (!cropImg) return;
  ev.preventDefault();
  setCropZoom(cropImg.zoomMul + (ev.deltaY < 0 ? 0.08 : -0.08));
}

export function cropPointerDown(ev) {
  if (!cropImg) return;
  ev.preventDefault();
  var canvas = els.cropCanvas;
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
  var rect = canvas.getBoundingClientRect();
  var ratio = CROP_OUT_W / rect.width; // CSS px -> canvas-internal px
  var startX = ev.clientX, startY = ev.clientY;
  var startOffX = cropImg.offX, startOffY = cropImg.offY;
  function onMove(mv) {
    if (!cropImg) return;
    cropImg.offX = startOffX + (mv.clientX - startX) * ratio;
    cropImg.offY = startOffY + (mv.clientY - startY) * ratio;
    clampCropOffsets();
    renderCropCanvas();
  }
  function onUp() {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
}

/** Rough size of a data URI's decoded bytes, for the same >200KB toast
    the raw-upload path used to show — now measuring the STORED (cropped)
    image, since that's what actually bloats the JSON. */
export function approxDataUrlKB(dataUrl) {
  var i = dataUrl.indexOf(',');
  var b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  return Math.round((b64.length * 0.75) / 1024);
}

export function sizeToast(dataUrl, name) {
  var kb = approxDataUrlKB(dataUrl);
  return kb > 200
    ? 'Embedded ' + name + ' — heads up, ' + kb + ' KB bloats the JSON.'
    : 'Embedded ' + name + '.';
}

/* ── Editing (all delegated; bound once in init) ─────────────────── */

export function onEditorInput(ev) {
  var t = ev.target;
  var d = state.editorDraft;
  if (!d) return;
  if (t.dataset.meta) {
    d[t.dataset.meta] = t.value;
  } else if (t.dataset.gfield) {
    var g = Number(t.dataset.g);
    if (t.dataset.gfield === 'tier') {
      d.groups[g].tier = Number(t.value);
      var card = t.closest('.group-card');
      if (card) card.style.setProperty('--gc', 'var(--tier-' + d.groups[g].tier + ')');
    } else {
      d.groups[g][t.dataset.gfield] = t.value;
    }
  } else if (t.dataset.bfield) {
    var gb = Number(t.dataset.g), bi = Number(t.dataset.blockIndex);
    // Rich heading/text blocks are contenteditable divs — sanitize on
    // every keystroke so the DRAFT (what gets exported / previewed) is
    // always the restricted-HTML subset, even mid-typing. This never
    // rewrites the live element's innerHTML, so the caret never jumps.
    d.groups[gb].article[bi][t.dataset.bfield] = t.dataset.rich ? sanitizeRichHtml(t.innerHTML) : t.value;
  } else if (t.dataset.ifield) {
    var gi = Number(t.dataset.g), mi = Number(t.dataset.m);
    var item = draftItem(gi, mi);
    if (t.dataset.ifield === 'label') {
      item.label = t.value;
      autoId(gi, mi);
      var note = t.closest('.item-editor').querySelector('details span');
      if (note) note.textContent = 'id: ' + item.id + ' (from the label)';
    } else if (t.dataset.ifield === 'color') {
      item.appearance = item.appearance || {};
      item.appearance.color = t.value;
    } else if (t.dataset.ifield === 'infoTitle') {
      item.info = item.info || {};
      if (t.value) item.info.title = t.value; else delete item.info.title;
    } else if (t.dataset.ifield === 'infoText') {
      item.info = item.info || {};
      if (t.value) item.info.text = t.value; else delete item.info.text;
    } else if (t.dataset.ifield === 'labelScale') {
      var scaleV = parseFloat(t.value);
      // Centered (1x) reads as "no override" so puzzles an author never
      // touches this control on don't pick up a redundant stored field.
      if (isFinite(scaleV) && Math.abs(scaleV - 1) > 0.001) item.labelScale = scaleV;
      else delete item.labelScale;
      var readout = t.closest('.label-scale-row').querySelector('.label-scale-readout');
      if (readout) readout.textContent = isFinite(item.labelScale) ? Math.round(item.labelScale * 100) + '%' : 'auto';
    }
  } else {
    return;
  }
  saveEditorDraft();
  refreshEditorStatus();
  pushPreview();
}

export function onEditorClick(ev) {
  var d = state.editorDraft;
  if (!d) return;

  // Rich text toolbar (B/I/U/Clear): mousedown already preventDefault'd
  // (see init()) so the field's focus/selection survived the click —
  // execCommand acts on it, then re-sanitize + store the block's HTML.
  var richBtn = ev.target.closest ? ev.target.closest('[data-rich-cmd]') : null;
  if (richBtn) {
    var gr = Number(richBtn.dataset.g), bir = Number(richBtn.dataset.blockIndex);
    try { document.execCommand(richBtn.dataset.richCmd, false, null); } catch (e) { /* unsupported — no-op */ }
    var editable = document.querySelector('.rich-editable[data-g="' + gr + '"][data-block-index="' + bir + '"]');
    if (editable) {
      d.groups[gr].article[bir].text = sanitizeRichHtml(editable.innerHTML);
      saveEditorDraft();
      refreshEditorStatus();
      pushPreview();
    }
    return;
  }

  var scaleResetBtn = ev.target.closest ? ev.target.closest('[data-label-scale-reset]') : null;
  if (scaleResetBtn) {
    var gs = Number(scaleResetBtn.dataset.g), ms = Number(scaleResetBtn.dataset.m);
    var itemS = draftItem(gs, ms);
    delete itemS.labelScale;
    var row = scaleResetBtn.closest('.label-scale-row');
    var rangeInput = row.querySelector('input[type="range"]');
    var readoutEl = row.querySelector('.label-scale-readout');
    if (rangeInput) rangeInput.value = '1';
    if (readoutEl) readoutEl.textContent = 'auto';
    saveEditorDraft();
    refreshEditorStatus();
    pushPreview();
    return;
  }

  var chipBtn = ev.target.closest ? ev.target.closest('.kind-chip') : null;
  if (chipBtn) {
    var g = Number(chipBtn.dataset.g), m = Number(chipBtn.dataset.m);
    var item = draftItem(g, m);
    if (item.zone === chipBtn.dataset.kind) return;
    item.zone = chipBtn.dataset.kind;
    if (item.zone !== 'rack' && item.scope) delete item.scope;
    saveEditorDraft();
    // structural change: re-render this item's editor + machine warnings
    var oldBox = chipBtn.closest('.item-editor');
    oldBox.parentNode.replaceChild(renderItemEditor(g, m), oldBox);
    renderMachineToggles();
    refreshEditorStatus();
    pushPreview();
    return;
  }

  var addBtn = ev.target.closest ? ev.target.closest('[data-article-add]') : null;
  if (addBtn) {
    var ga = Number(addBtn.dataset.g);
    var grp = d.groups[ga];
    if (!Array.isArray(grp.article)) grp.article = [];
    var type = addBtn.dataset.articleAdd;
    grp.article.push(type === 'image' ? { type: 'image', src: '', caption: '' } : { type: type, text: '' });
    saveEditorDraft();
    refreshGroupArticle(ga);
    refreshEditorStatus();
    pushPreview();
    return;
  }

  var moveBtn = ev.target.closest ? ev.target.closest('[data-article-move]') : null;
  if (moveBtn) {
    var gm = Number(moveBtn.dataset.g), bim = Number(moveBtn.dataset.blockIndex);
    var arr = d.groups[gm].article;
    var swapWith = bim + (moveBtn.dataset.articleMove === 'up' ? -1 : 1);
    if (swapWith < 0 || swapWith >= arr.length) return;
    var tmp = arr[bim]; arr[bim] = arr[swapWith]; arr[swapWith] = tmp;
    saveEditorDraft();
    refreshGroupArticle(gm);
    pushPreview();
    return;
  }

  var rmBtn = ev.target.closest ? ev.target.closest('[data-article-remove]') : null;
  if (rmBtn) {
    var gr = Number(rmBtn.dataset.g), bir = Number(rmBtn.dataset.blockIndex);
    d.groups[gr].article.splice(bir, 1);
    saveEditorDraft();
    refreshGroupArticle(gr);
    refreshEditorStatus();
    pushPreview();
    return;
  }
}

export function onEditorChange(ev) {
  var t = ev.target;
  var d = state.editorDraft;
  if (!d) return;
  if (t.dataset.machine) {
    var set = new Set(d.machines);
    if (t.checked) set.add(t.dataset.machine); else set.delete(t.dataset.machine);
    d.machines = ALL_MACHINES.filter(function (mn) { return set.has(mn); });
    saveEditorDraft();
    renderMachineToggles();
    refreshEditorStatus();
    pushPreview();
    return;
  }
  // Every image upload goes FileReader -> crop modal -> canvas render ->
  // THAT cropped data URI is what gets stored (never the original), so
  // the JSON always carries an already-sized, already-framed image.
  if (t.dataset.bfile && t.files && t.files[0]) {
    var gb = Number(t.dataset.g), bi = Number(t.dataset.blockIndex);
    var block = d.groups[gb].article[bi];
    var bfile = t.files[0];
    var breader = new FileReader();
    breader.onload = function () {
      openCropModal(breader.result, function (croppedDataUrl) {
        block.src = croppedDataUrl;
        saveEditorDraft();
        toast(sizeToast(croppedDataUrl, bfile.name));
        refreshGroupArticle(gb);
        refreshEditorStatus();
        pushPreview();
      });
    };
    breader.readAsDataURL(bfile);
    t.value = ''; // allow re-picking the same file later (change won't refire otherwise)
    return;
  }
  if (t.dataset.ifile && t.files && t.files[0]) {
    var g = Number(t.dataset.g), m = Number(t.dataset.m);
    var item = draftItem(g, m);
    var path = t.dataset.ifile;
    var file = t.files[0];
    var reader = new FileReader();
    reader.onload = function () {
      openCropModal(reader.result, function (croppedDataUrl) {
        if (path === 'info.image') {
          item.info = item.info || {};
          item.info.image = croppedDataUrl;
        } else {
          item.scope = { image: croppedDataUrl };
        }
        saveEditorDraft();
        toast(sizeToast(croppedDataUrl, file.name));
        refreshEditorStatus();
        pushPreview();
      });
    };
    reader.readAsDataURL(file);
    t.value = '';
  }
}

/* ── Validation + status chip + inline feedback ──────────────────── */

export function refreshEditorStatus() {
  var d = state.editorDraft;
  var chip = document.getElementById('editor-status-chip');
  if (!chip || !d) return;

  var issues = caseProblems(d).length;
  for (var g = 0; g < 4; g++) {
    var nameFeedback = document.querySelector('[data-feedback-for="gname-' + g + '"]');
    var emptyName = !d.groups[g].name;
    if (emptyName) issues++;
    if (nameFeedback) {
      nameFeedback.hidden = !emptyName;
      nameFeedback.textContent = 'Give this group a name.';
    }
    for (var m = 0; m < 4; m++) {
      var item = draftItem(g, m);
      var feedback = document.querySelector('[data-feedback-for="label-' + g + '-' + m + '"]');
      var empty = !item.label;
      if (empty) issues++;
      if (feedback) {
        feedback.hidden = !empty;
        feedback.textContent = 'Give this piece a label.';
      }
    }
  }
  chip.className = 'status-chip ' + (issues === 0 ? 'ok' : 'bad');
  chip.textContent = issues === 0 ? 'Ready to export ✓' : issues + ' thing' + (issues === 1 ? '' : 's') + ' to fix';
}

/* ── Live preview plumbing ───────────────────────────────────────────
 * Bug fixed in round 9: the very first pushPreview() used to fire before
 * the iframe had even registered its own 'message' listener, so it was
 * silently dropped and only Test Play ever showed a fresh draft. Fix is a
 * handshake: the ?preview boot posts 'dp2d-preview-ready' once its
 * listener is live; until that arrives, the editor queues messages and
 * flushes them on ready (plus a re-push on the iframe's 'load' event as
 * belt-and-suspenders). ──────────────────────────────────────────── */

var previewTimer = null;
var previewReady = false;
var previewQueue = [];

/** main.js calls this when the preview iframe handshakes. */
export function setPreviewReady(v) { previewReady = v; }

export function pushPreview() {
  try { localStorage.setItem(SAVE_PREFIX + 'preview-draft', JSON.stringify(state.editorDraft)); } catch (e) { /* ignore */ }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(function () { postToPreview({ type: 'dp2d-preview' }); }, 150);
}

/** Post to the preview iframe, queuing until it has signaled ready. */
export function postToPreview(msg) {
  var f = document.getElementById('preview-frame');
  if (!f) return;
  if (!previewReady) { previewQueue.push(msg); return; }
  if (f.contentWindow) f.contentWindow.postMessage(msg, '*');
}

export function flushPreviewQueue() {
  if (!previewQueue.length) return;
  var queued = previewQueue;
  previewQueue = [];
  queued.forEach(postToPreview);
}

/** ?preview boot: render whatever draft the editor last pushed. */
export function bootPreviewDraft() {
  var draft = null;
  try { draft = JSON.parse(localStorage.getItem(SAVE_PREFIX + 'preview-draft')); } catch (e) { /* ignore */ }
  openPuzzle(draft && typeof draft === 'object' ? draft : normalizeDraft({}));
}

/* ── Editor UI persistence (drawer width) ────────────────────────── */

export var EDITOR_UI_KEY = SAVE_PREFIX + 'editor-ui';
export function loadEditorUi() {
  try { return JSON.parse(localStorage.getItem(EDITOR_UI_KEY) || '{}'); } catch (e) { return {}; }
}
export function saveEditorUi(patch) {
  var cur = loadEditorUi();
  for (var k in patch) cur[k] = patch[k];
  try { localStorage.setItem(EDITOR_UI_KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ }
}
export function clampDrawerWidth(w) {
  return Math.max(300, Math.min(720, w));
}

/** Recompute the live-preview iframe's fixed-ratio scale + position so it
    fits the region beside the drawer (or the full screen when the drawer
    is collapsed), preserving V's aspect ratio. Called on drawer toggle,
    window resize, and live while dragging the resize handle. */
export function layoutPreviewStage() {
  var iframe = document.getElementById('preview-frame');
  var stage = document.querySelector('.editor-preview-stage');
  var V = state.previewV;
  if (!iframe || !stage || !V) return;
  var drawer = document.querySelector('.editor-drawer');
  var drawerOpen = drawer && !drawer.classList.contains('panel-hidden');
  var margin = 24;
  var drawerSpace = drawerOpen ? drawer.getBoundingClientRect().width + margin : 0;
  var regionW = Math.max(160, window.innerWidth - drawerSpace);
  var regionH = window.innerHeight;
  var s = Math.min(regionW / V.w, regionH / V.h);
  var scaledW = V.w * s, scaledH = V.h * s;
  iframe.style.width = V.w + 'px';
  iframe.style.height = V.h + 'px';
  iframe.style.transformOrigin = 'top left';
  iframe.style.transform = 'scale(' + s + ')';
  iframe.style.left = Math.max(0, (regionW - scaledW) / 2) + 'px';
  iframe.style.top = Math.max(0, (regionH - scaledH) / 2) + 'px';
}

/** Pointer-capture drag on the drawer's left-edge strip: mutates
    --drawer-w live (clamped ~300-720px), rescaling the preview stage on
    every move, and persists the final width to dp2d:editor-ui. */
export function bindDrawerResize(handle, drawer) {
  handle.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('is-dragging');
    var stage = document.querySelector('.editor-preview-stage');
    if (stage) stage.classList.add('no-anim');
    var startX = ev.clientX;
    var startW = drawer.getBoundingClientRect().width;

    function onMove(mv) {
      var w = clampDrawerWidth(startW + (startX - mv.clientX));
      drawer.style.setProperty('--drawer-w', w + 'px');
      layoutPreviewStage();
    }
    function onUp() {
      handle.releasePointerCapture(ev.pointerId);
      handle.classList.remove('is-dragging');
      if (stage) stage.classList.remove('no-anim');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      saveEditorUi({ drawerW: drawer.getBoundingClientRect().width });
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

/* ── Init — the ONLY place any event listener is attached ────────── */

