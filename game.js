'use strict';

/* ════════════════════════════════════════════════════════════════════
 * RULES ENGINE — pure, DOM-free.
 *
 * A 4-tray × 4-slot staging grid, independent per-tray Lock In, mistakes,
 * "one away" detection, and the intro → playing → won|lost phase machine.
 * Nothing in this section touches the DOM — see "DOM LAYER" further down
 * for rendering, input, persistence, and sound.
 * ════════════════════════════════════════════════════════════════════ */

var MAX_MISTAKES = 4;
var GROUP_SIZE = 4;
var BOX_COUNT = 4;
var SLOT_COUNT = 4;

/** Minimal pub/sub. */
function Emitter() {
  this.listeners = Object.create(null);
}
Emitter.prototype.on = function (event, fn) {
  if (!this.listeners[event]) this.listeners[event] = [];
  this.listeners[event].push(fn);
  var self = this;
  return function () { self.off(event, fn); };
};
Emitter.prototype.off = function (event, fn) {
  if (!this.listeners[event]) return;
  this.listeners[event] = this.listeners[event].filter(function (f) { return f !== fn; });
};
Emitter.prototype.emit = function (event, payload) {
  var fns = this.listeners[event];
  if (!fns) return;
  fns.slice().forEach(function (fn) { fn(payload); });
};
/** Detach every listener — used when a game instance is replaced. */
Emitter.prototype.removeAll = function () {
  this.listeners = Object.create(null);
};

/* Piece kinds. The ids are legacy zone names kept for old puzzle files;
   every piece of UI copy uses the friendly names instead. */
var PIECE_KIND_NAMES = {
  corkboard: 'sticky note',
  folder: 'paper sheet',
  rack: 'slide',
  tubes: 'X-ray film',
  photo: 'photograph',
  rx: 'prescription',
};

/** Retired piece kinds are mapped forward when a puzzle loads. */
var KIND_MIGRATIONS = { deskCards: 'folder' };

function normalizeKinds(c) {
  if (c && Array.isArray(c.items)) {
    c.items.forEach(function (i) {
      if (i && KIND_MIGRATIONS[i.zone]) i.zone = KIND_MIGRATIONS[i.zone];
    });
  }
  return c;
}

/* Machines a puzzle may declare. Absent `machines` field = all three. */
var ALL_MACHINES = ['scope', 'lightbox'];

/** The machine set a puzzle declares (back-compat: absent = everything). */
function puzzleMachines(c) {
  if (!c || !Array.isArray(c.machines)) return ALL_MACHINES.slice();
  return c.machines.filter(function (m) { return ALL_MACHINES.indexOf(m) !== -1; });
}

/**
 * Collect every structural problem with a puzzle case (empty = valid).
 * Checks counts, ids, group coverage, and that every piece kind that
 * NEEDS a machine to be readable has that machine declared.
 */
function caseProblems(c) {
  var problems = [];
  if (!c || !Array.isArray(c.items) || c.items.length !== 16) {
    problems.push('expected 16 items, got ' + (c && c.items ? c.items.length : 0));
  }
  if (!c || !Array.isArray(c.groups) || c.groups.length !== 4) {
    problems.push('expected 4 groups, got ' + (c && c.groups ? c.groups.length : 0));
  }
  if (!c || !Array.isArray(c.items) || !Array.isArray(c.groups)) return problems;

  var ids = new Set(c.items.map(function (i) { return i.id; }));
  if (ids.size !== c.items.length) problems.push('duplicate item ids');

  var grouped = new Set();
  c.groups.forEach(function (g) {
    var itemIds = g.itemIds || [];
    if (itemIds.length !== 4) problems.push('group "' + g.name + '" has ' + itemIds.length + ' items');
    itemIds.forEach(function (id) {
      if (!ids.has(id)) problems.push('group "' + g.name + '" references unknown item "' + id + '"');
      if (grouped.has(id)) problems.push('item "' + id + '" appears in two groups');
      grouped.add(id);
    });
    // Optional long-form explanation shown on the results screen. Light
    // validation only — this never blocks a puzzle from loading.
    if (g.article !== undefined) {
      if (!Array.isArray(g.article)) {
        problems.push('group "' + g.name + '" article must be a list of blocks');
      } else {
        g.article.forEach(function (block, bi) {
          if (!block || ['heading', 'text', 'image'].indexOf(block.type) === -1) {
            problems.push('group "' + g.name + '" article block ' + (bi + 1) + ' has an invalid type');
          } else if (block.type === 'image' && !block.src) {
            problems.push('group "' + g.name + '" article image block ' + (bi + 1) + ' is missing its image');
          }
        });
      }
    }
  });
  if (grouped.size !== 16) problems.push('groups cover ' + grouped.size + '/16 items');

  c.items.forEach(function (i) {
    if (!PIECE_KIND_NAMES[i.zone]) problems.push('item "' + i.id + '" has unknown piece type "' + i.zone + '"');
  });

  // Machines cross-check: a slide with no microscope (or a film with no
  // light box) would be an unreadable clue — that's an invalid puzzle.
  if (c.machines !== undefined && !Array.isArray(c.machines)) {
    problems.push('"machines" must be a list (e.g. ["scope","lightbox"])');
  }
  var machines = puzzleMachines(c);
  var hasSlides = c.items.some(function (i) { return i.zone === 'rack'; });
  var hasFilms = c.items.some(function (i) { return i.zone === 'tubes'; });
  if (hasSlides && machines.indexOf('scope') === -1) {
    problems.push('this puzzle has slides but no microscope, so they would be unreadable');
  }
  if (hasFilms && machines.indexOf('lightbox') === -1) {
    problems.push('this puzzle has X-ray films but no light box, so they would be unreadable');
  }
  return problems;
}

/** Throws with a readable message if the case is structurally invalid. */
function validateCase(c) {
  var problems = caseProblems(c);
  if (problems.length) {
    throw new Error('Invalid puzzle case "' + (c && c.id) + '":\n - ' + problems.join('\n - '));
  }
}

/** Find the group an item belongs to. Throws if the item has no group. */
function groupOfItem(c, itemId) {
  var g = c.groups.find(function (g) { return g.itemIds.indexOf(itemId) !== -1; });
  if (!g) throw new Error('item ' + itemId + ' has no group');
  return g;
}

/** A fresh 4×4 grid of empty slot cells. */
function emptyGrid() {
  var grid = [];
  for (var b = 0; b < BOX_COUNT; b++) {
    var row = [];
    for (var s = 0; s < SLOT_COUNT; s++) row.push(null);
    grid.push(row);
  }
  return grid;
}

/**
 * DeskPuzzleGame — the state machine. Phases: intro → playing → won|lost.
 * `casual` (settable any time) lifts the mistake ceiling to Infinity so a
 * run never hits 'lost'; mistakes are still counted and shown.
 */
function DeskPuzzleGame(puzzle, opts) {
  opts = opts || {};
  this.puzzle = puzzle;
  this.events = new Emitter();
  this.casual = !!opts.casual;

  this.phase_ = 'intro';
  this.staging_ = emptyGrid();
  this.mistakes_ = 0;
  this.solved_ = [];
  this.attempts_ = []; // { itemIds: string[4], correct: boolean, boxIndex } — for the share grid
}

Object.defineProperties(DeskPuzzleGame.prototype, {
  phase: { get: function () { return this.phase_; } },
  staging: { get: function () { return this.staging_; } },
  mistakes: { get: function () { return this.mistakes_; } },
  maxMistakes: { get: function () { return this.casual ? Infinity : MAX_MISTAKES; } },
  mistakesLeft: { get: function () { return this.maxMistakes - this.mistakes_; } },
  solved: { get: function () { return this.solved_; } },
  attempts: { get: function () { return this.attempts_; } },
});

DeskPuzzleGame.prototype.isSolvedItem = function (itemId) {
  var g = groupOfItem(this.puzzle, itemId);
  return this.solved_.some(function (s) { return s.groupId === g.id; });
};

/** Box index currently holding this item, or -1. */
DeskPuzzleGame.prototype.boxOfItem = function (itemId) {
  return this.staging_.findIndex(function (box) { return box.indexOf(itemId) !== -1; });
};

/** Slot cell {box, slot} currently holding this item, or null. */
DeskPuzzleGame.prototype.cellOfItem = function (itemId) {
  for (var b = 0; b < BOX_COUNT; b++) {
    var s = this.staging_[b].indexOf(itemId);
    if (s >= 0) return { box: b, slot: s };
  }
  return null;
};

DeskPuzzleGame.prototype.isStaged = function (itemId) {
  return this.cellOfItem(itemId) !== null;
};

DeskPuzzleGame.prototype.isBoxLocked = function (boxIndex) {
  return this.solved_.some(function (s) { return s.boxIndex === boxIndex; });
};

/** First empty slot index in a box, or -1. */
DeskPuzzleGame.prototype.firstEmptySlot = function (boxIndex) {
  return this.staging_[boxIndex].indexOf(null);
};

/** Item ids still in play (not solved, not staged) — desk display order. */
DeskPuzzleGame.prototype.activeItemIds = function () {
  var self = this;
  return this.puzzle.items
    .map(function (i) { return i.id; })
    .filter(function (id) { return !self.isSolvedItem(id) && !self.isStaged(id); });
};

DeskPuzzleGame.prototype.setPhase = function (p) {
  if (this.phase_ === p) return;
  this.phase_ = p;
  this.events.emit('phase', p);
  this.touch();
};

/**
 * Put an item into a specific slot cell of box `boxIndex`. If that cell is
 * taken by another item, fall back to the first empty cell in the box (or
 * 'full' if none). Moving an already-staged item returns 'moved' (no
 * 'staged' event); a new item from the desk returns 'staged'.
 */
DeskPuzzleGame.prototype.stageToSlot = function (itemId, boxIndex, slotIndex) {
  if (this.phase_ !== 'playing' || this.isSolvedItem(itemId)) return 'ignored';
  if (boxIndex < 0 || boxIndex >= BOX_COUNT || this.isBoxLocked(boxIndex)) return 'ignored';
  if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return 'ignored';

  var from = this.cellOfItem(itemId);

  var target = slotIndex;
  var occupant = this.staging_[boxIndex][target];
  if (occupant !== null && occupant !== itemId) {
    target = this.firstEmptySlot(boxIndex);
    if (target < 0) return 'full';
  }

  if (from && from.box === boxIndex && from.slot === target) return 'ignored';

  if (from) {
    this.staging_[from.box][from.slot] = null;
    this.staging_[boxIndex][target] = itemId;
    this.touch();
    return 'moved';
  }

  this.staging_[boxIndex][target] = itemId;
  this.events.emit('staged', { itemId: itemId, boxIndex: boxIndex, slotIndex: target });
  this.touch();
  return 'staged';
};

/** Drop into the first unlocked box that has an empty cell. 'full' if none. */
DeskPuzzleGame.prototype.autoPlace = function (itemId) {
  if (this.phase_ !== 'playing' || this.isSolvedItem(itemId)) return 'ignored';
  for (var b = 0; b < BOX_COUNT; b++) {
    if (this.isBoxLocked(b)) continue;
    var slot = this.firstEmptySlot(b);
    if (slot >= 0) return this.stageToSlot(itemId, b, slot);
  }
  return 'full';
};

/** Send an item from a tray back to the desk. */
DeskPuzzleGame.prototype.unstage = function (itemId) {
  var cell = this.cellOfItem(itemId);
  if (!cell || this.phase_ !== 'playing') return;
  if (this.isBoxLocked(cell.box) || this.isSolvedItem(itemId)) return;
  this.staging_[cell.box][cell.slot] = null;
  this.events.emit('unstaged', { itemId: itemId });
  this.touch();
};

/** True when exactly 3 of the 4 guessed items share a single group. */
DeskPuzzleGame.prototype.isOneAway = function (groups) {
  var counts = new Map();
  groups.forEach(function (g) { counts.set(g.id, (counts.get(g.id) || 0) + 1); });
  var found = false;
  counts.forEach(function (n) { if (n === 3) found = true; });
  return found;
};

/** "Lock In" one staging box as a group guess. */
DeskPuzzleGame.prototype.submitBox = function (boxIndex) {
  if (this.phase_ !== 'playing' || this.isBoxLocked(boxIndex)) {
    return { kind: 'incomplete', boxIndex: boxIndex };
  }
  var box = this.staging_[boxIndex];
  var ids = box.filter(function (c) { return c !== null; });
  if (ids.length !== GROUP_SIZE) {
    var r = { kind: 'incomplete', boxIndex: boxIndex };
    this.events.emit('submit', r);
    return r;
  }

  var groups = ids.map(function (id) { return groupOfItem(this.puzzle, id); }, this);
  var allSame = groups.every(function (g) { return g.id === groups[0].id; });

  var result;
  if (allSame) {
    var order = this.solved_.length;
    this.solved_.push({ groupId: groups[0].id, order: order, boxIndex: boxIndex });
    this.attempts_.push({ itemIds: ids.slice(), correct: true, boxIndex: boxIndex });
    result = { kind: 'correct', group: groups[0], order: order, boxIndex: boxIndex };
  } else {
    this.mistakes_ += 1;
    this.attempts_.push({ itemIds: ids.slice(), correct: false, boxIndex: boxIndex });
    result = {
      kind: 'wrong',
      mistakesLeft: this.mistakesLeft,
      boxIndex: boxIndex,
      oneAway: this.isOneAway(groups),
    };
  }
  this.events.emit('submit', result);

  if (this.solved_.length === this.puzzle.groups.length) this.setPhase('won');
  else if (this.mistakes_ >= this.maxMistakes) this.setPhase('lost');
  else this.touch();
  return result;
};

/** Groups not yet solved — shown on the results panel after a loss. */
DeskPuzzleGame.prototype.unsolvedGroups = function () {
  var done = new Set(this.solved_.map(function (s) { return s.groupId; }));
  return this.puzzle.groups.filter(function (g) { return !done.has(g.id); });
};

DeskPuzzleGame.prototype.snapshot = function () {
  return {
    caseId: this.puzzle.id,
    phase: this.phase_,
    staging: this.staging_.map(function (box) { return box.slice(); }),
    mistakes: this.mistakes_,
    solved: this.solved_.slice(),
    attempts: this.attempts_.slice(),
  };
};

/** Restore a mid-game save. Emits nothing — callers re-sync visuals once. */
DeskPuzzleGame.prototype.restore = function (s) {
  if (!s || s.caseId !== this.puzzle.id) return;
  this.phase_ = s.phase;
  this.staging_ = s.staging.map(function (box) { return box.slice(); });
  this.mistakes_ = s.mistakes;
  this.solved_ = (s.solved || []).slice();
  this.attempts_ = (s.attempts || []).slice();
};

DeskPuzzleGame.prototype.reset = function () {
  this.phase_ = 'intro';
  this.staging_ = emptyGrid();
  this.mistakes_ = 0;
  this.solved_ = [];
  this.attempts_ = [];
  this.touch();
};

DeskPuzzleGame.prototype.touch = function () {
  this.events.emit('change', this.snapshot());
};

/* ════════════════════════════════════════════════════════════════════
 * EMBEDDED FALLBACK PUZZLE — content-equivalent copy of the current puzzle
 * and index so the game still works when fetch() fails (e.g. file://).
 * ════════════════════════════════════════════════════════════════════ */

var CURRENT_PUZZLE = {
  id: 'starry-sky-society-2026-08-21',
  title: 'Starry Sky Society Puzzle',
  date: '2026-08-21',
  machines: ['scope', 'lightbox'],
  groups: [
    {
      id: 'g-staph-aureus',
      name: 'Manifestations of Staph aureus',
      tier: 1,
      explanation: 'Bullous impetigo, tricuspid valve endocarditis, osteomyelitis, and a gram stain can all point to Staphylococcus aureus.',
      itemIds: ['bullous-impetigo', 'tricuspid-valve-endocarditis', 'osteomyelitis', 'gram-stain'],
    },
    {
      id: 'g-simple-columnar',
      name: 'Simple columnar epithelium',
      tier: 2,
      explanation: 'The four clues point toward simple columnar epithelium in histology, organ identification, or gross anatomy.',
      itemIds: ['excretory-ducts', 'cholecystectomy-organ', 'small-bowel', 'stomach'],
    },
    {
      id: 'g-multiple-myeloma',
      name: 'Multiple myeloma CRAB symptoms',
      tier: 3,
      explanation: 'CRAB points to hyperCalcemia, Renal involvement, Anemia, and Bone lesions. Apple-green birefringence adds the amyloid clue associated with renal disease.',
      itemIds: ['anemia-blood-smear', 'hypercalcemia', 'apple-green-birefringence', 'lytic-bone-lesions'],
    },
    {
      id: 'g-angelman-syndrome',
      name: 'Angelman syndrome',
      tier: 4,
      explanation: 'These written clues point to Angelman syndrome: a neurodevelopmental disorder associated with maternal UBE3A dysfunction on chromosome 15.',
      itemIds: ['fascination-with-water', 'ube3a-mutation', 'chromosome-15', 'wide-spaced-teeth'],
    },
  ],
  items: [
    { id: 'bullous-impetigo', label: 'Bullous impetigo', zone: 'rack', info: { title: 'Bullous impetigo', text: 'Histology clue: a superficial intraepidermal blister.' } },
    { id: 'tricuspid-valve-endocarditis', label: 'Tricuspid valve endocarditis', zone: 'tubes', info: { title: 'Tricuspid valve endocarditis', text: 'Echocardiogram clue: a vegetation on the tricuspid valve.' } },
    { id: 'osteomyelitis', label: 'Osteomyelitis', zone: 'photo', info: { title: 'Osteomyelitis', text: 'Gross pathology clue: infected bone.' } },
    { id: 'gram-stain', label: 'Gram stain', zone: 'rack', info: { title: 'Gram stain', text: 'Microscopy clue: gram-positive cocci in clusters.' } },
    { id: 'excretory-ducts', label: 'Excretory ducts', zone: 'rack', info: { title: 'Excretory ducts', text: 'Histology clue: simple columnar epithelium in an excretory duct.' } },
    { id: 'cholecystectomy-organ', label: 'Organ removed in a cholecystectomy', zone: 'folder', info: { title: 'Gallbladder', text: 'The gallbladder is removed during a cholecystectomy.' } },
    { id: 'small-bowel', label: 'Small bowel', zone: 'rack', info: { title: 'Small bowel', text: 'Histology clue: simple columnar epithelium in the small bowel.' } },
    { id: 'stomach', label: 'Stomach', zone: 'photo', info: { title: 'Stomach', text: 'Gross anatomy clue: stomach.' } },
    { id: 'anemia-blood-smear', label: 'Blood smear of anemia', zone: 'rack', info: { title: 'Blood smear of anemia', text: 'The A in the CRAB mnemonic: anemia.' } },
    { id: 'hypercalcemia', label: 'Hypercalcemia', zone: 'folder', info: { title: 'Hypercalcemia', text: 'The C in the CRAB mnemonic.' } },
    { id: 'apple-green-birefringence', label: 'Apple Green Birefringence', zone: 'rack', info: { title: 'Apple Green Birefringence', text: 'Congo red amyloid under polarized light, associated here with renal involvement.' } },
    { id: 'lytic-bone-lesions', label: 'Lytic Bone Lesions', zone: 'tubes', info: { title: 'Lytic Bone Lesions', text: 'X-ray clue: lytic bone lesions, the B in CRAB.' } },
    { id: 'fascination-with-water', label: 'Fascination with water', zone: 'corkboard', info: { title: 'Fascination with water', text: 'Behavioral clue associated with Angelman syndrome.' } },
    { id: 'ube3a-mutation', label: 'UBE3A mutation', zone: 'corkboard', info: { title: 'UBE3A mutation', text: 'Genetic clue associated with Angelman syndrome.' } },
    { id: 'chromosome-15', label: 'Chromosome 15', zone: 'corkboard', info: { title: 'Chromosome 15', text: 'Chromosomal clue associated with Angelman syndrome.' } },
    { id: 'wide-spaced-teeth', label: 'Wide spaced teeth', zone: 'corkboard', info: { title: 'Wide spaced teeth', text: 'Physical finding associated with Angelman syndrome.' } },
  ],
};

/* file:// cannot fetch the authored JSON. index.html loads this local-only
   mirror before game.js so the desktop file preview uses the exact same
   payload as the published puzzle. */
if (window.DP2D_LOCAL_PUZZLE) CURRENT_PUZZLE = window.DP2D_LOCAL_PUZZLE;

var CURRENT_INDEX = {
  current: 'starry-sky-society-2026-08-21',
  puzzles: [
    { id: 'starry-sky-society-2026-08-21', title: 'Starry Sky Society Puzzle', date: '2026-08-21', file: 'starry-sky-society-2026-08-21.json' },
  ],
};

/* ════════════════════════════════════════════════════════════════════
 * DOM LAYER — top-down desk, strewn pile, drag everything.
 *
 * EVENT-BINDING RULE (hard): every document/window-level pointer, click,
 * key, and resize handler is bound EXACTLY ONCE in init(), in the CAPTURE
 * phase for pointer events, and routes by event target. Pieces carry no
 * individual listeners; syncs only mutate classes, positions, content.
 * ════════════════════════════════════════════════════════════════════ */

var SAVE_PREFIX = 'dp2d:';
var SETTINGS_KEY = SAVE_PREFIX + 'settings';
var LAYOUT_KEY = SAVE_PREFIX + 'layout';
var EDITOR_DRAFT_KEY = SAVE_PREFIX + 'editor-draft';
/* v3 namespace: earlier layouts' saves must never half-restore here. */
var SAVE_NS = SAVE_PREFIX + 'save3:';
var LEGACY_SAVE_NS = [SAVE_PREFIX + 'save:', SAVE_PREFIX + 'save2:'];

/* Asset version — extracted from the script's own ?v= query param (set in
   index.html as game.js?v=NN) so all fetched assets share the same cache key.
   Falls back to Date.now() if currentScript is unavailable (deferred). */
var ASSET_VERSION = (function () {
  var s = document.currentScript && document.currentScript.src;
  var m = s && /[?&]v=([^&]+)/.exec(s);
  return m ? m[1] : String(Date.now());
})();
function versioned(url) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + ASSET_VERSION; }

// HINTS_MAX retired in v15 — label printer no longer issues hint labels.
var TIER_EMOJI = { 1: '🟨', 2: '🟩', 3: '🟪', 4: '🟧' };

var PIECE_CLASS = {
  corkboard: 'piece-sticky',
  folder: 'piece-paper',
  rack: 'piece-slide',
  tubes: 'piece-film',
  photo: 'piece-photo',
  rx: 'piece-rx',
};

var PIECE_NOUN = {
  corkboard: 'sticky note',
  folder: 'paper sheet',
  rack: 'microscope slide',
  tubes: 'X-ray film',
  photo: 'photograph',
  rx: 'prescription script',
};

/* Paper-ish kinds share sounds and the seeded visual-variety system. */
/* Photo is deliberately NOT here: it renders its own pure-CSS Polaroid
   frame + window so the clue image lines up exactly inside the borders,
   and it takes no corner-fold, tape, or seeded flip. */
var PAPER_FAMILY = { corkboard: 1, folder: 1, rx: 1 };

var TRAY_NAMES = ['tray A', 'tray B', 'tray C', 'tray D'];

/* Dev layout knobs (?layout). Machine anchors are desk-fraction positions. */
var LAYOUT_DEFAULTS = {
  scope: { fx: 0.015, fy: 0.03 },
  lightbox: { w: 220, h: 240 },
  scatter: { lo: 0.36, hi: 0.92 },
  pieceScale: { sticky: 1.25, paper: 1.6, slide: 1.2, film: 1.45, photo: 1.75, rx: 1.35 },
  scopePanel: { w: 452, h: 322 },
};

var els = {};
var trayEls = [];
var trayHeaderEls = [];
var slotEls = [];
var lockBtnEls = [];
var peekOverlay = null; // dynamically created peek viewer overlay

/* ── Viewport health tip state ──────────────────────────────────── */
var viewportTipShownThisLoad = false;
var viewportTipAutoHideTimer = null;
var viewportTipResizeTimer = null;

var state = {
  settings: { casual: false, sound: true, theme: 'system' },
  game: null,
  pieceEls: {},
  desk: null, // { pos, rot, z, zTop, scope }
  drag: null,
  toastTimer: null,
  scopeSources: {},   // itemId -> canvas | HTMLImageElement (loaded)
  layout: null,
  layoutMode: false,
  layoutDrag: null,
  textures: null,     // Set of present texture filenames, or null
  editorDraft: null,
  filmLightTimer: null,
  // Runtime properties added during game load (declared here for clarity):
  activeMachines: null,   // string[] of machine ids active for current puzzle
  slideLetters: null,     // { [itemId]: letter } for rack pieces
  previewMode: false,     // true when loaded via ?preview
  editorMode: false,      // true when loaded via ?editor
  previewV: null,         // { w, h } logical preview viewport captured at editor boot
};

/* ── Small utilities ─────────────────────────────────────────────── */

function toCamel(id) {
  return id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
}

function hashString(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic PRNG — seeds the initial scatter per puzzle id. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function itemById(id) {
  return state.game.puzzle.items.find(function (i) { return i.id === id; });
}

/** Is this machine part of the current puzzle? */
function hasMachine(m) {
  return !state.activeMachines || state.activeMachines.indexOf(m) !== -1;
}

/** A rect no point is ever inside — stands in for absent machines. */
var NEVER_RECT = { left: -9, top: -9, right: -9, bottom: -9, width: 0, height: 0, cx: -9, cy: -9 };

function fallbackColor(id) {
  var hue = hashString(id) % 60; // warm band only (reds→yellows), no blue
  return 'hsl(' + (20 + hue) + ' 65% 78%)';
}

function downloadJson(filename, data) {
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

function cacheEls() {
  [
    'screen-menu', 'screen-play', 'screen-error', 'screen-editor', 'live-region', 'toast',
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

/* ── Settings, layout, save persistence ─────────────────────────── */

function loadSettings() {
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

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) { /* storage unavailable */ }
}

/* ── Theme (light / dark / system) ───────────────────────────────── */

var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function applyTheme() {
  var mode = state.settings.theme;
  var dark = mode === 'dark' || (mode === 'system' && darkQuery && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function setTheme(mode) {
  state.settings.theme = mode;
  saveSettings();
  applyTheme();
}

function syncSettingsUi() {
  // Null-guarded: a stale cached index.html must degrade, not crash init.
  if (els.toggleCasual) els.toggleCasual.checked = state.settings.casual;
  // Mute lives here now (the "Sound" checkbox) — the play-header's
  // standalone Mute button was removed (round 10); this is the only
  // sound on/off control left.
  if (els.toggleSound) els.toggleSound.checked = state.settings.sound;
  document.querySelectorAll('input[name="theme"]').forEach(function (r) {
    r.checked = r.value === state.settings.theme;
  });
}

var LAYOUT_MERGE_KEYS = ['scope', 'lightbox', 'scatter', 'pieceScale', 'scopePanel'];

function mergeLayoutLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return;
  LAYOUT_MERGE_KEYS.forEach(function (k) {
    if (layer[k] && typeof layer[k] === 'object') Object.assign(base[k], layer[k]);
  });
  if (layer.sound) base.sound = layer.sound;
}

/**
 * Layout precedence, lowest to highest: code defaults < layout.json (a
 * file dropped next to index.html, published by the ?layout Export
 * button) < the live localStorage override (?layout edits in THIS
 * browser). The file fetch is 404-tolerant and silent — most installs
 * never have one, and that's fine, defaults stand.
 */
function loadLayout() {
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

function persistLayout() {
  state.layout.sound = collectSoundLayer();
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout)); } catch (e) { /* ignore */ }
}

/** Apply layout config to the DOM (machine anchors, piece scales, panel). */
function applyLayout() {
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

function saveKey(puzzleId) { return SAVE_NS + puzzleId; }

function persistGame() {
  if (!state.game || !state.desk || state.previewMode) return;
  var snap = state.game.snapshot();
  snap.desk = state.desk;
  // Persist the mode so sanitizeEngineSave can use it on reload instead
  // of the current (possibly toggled) setting — fixes B2 casual reload bug.
  snap.casual = !!state.settings.casual;
  try {
    localStorage.setItem(saveKey(state.game.puzzle.id), JSON.stringify(snap));
  } catch (e) { /* storage full/unavailable */ }
}

function loadSavedGame(puzzleId) {
  try {
    var raw = localStorage.getItem(saveKey(puzzleId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/**
 * HEAL a saved engine snapshot so no save — stale, concurrent, or hand-
 * edited — can restore an inconsistent game. Invariants enforced:
 * staging holds only valid, unique item ids; each solved entry's box
 * contains exactly that group's four items; attempts are well-formed and
 * at least cover the solved locks; phase is recomputed from solved and
 * mistakes rather than trusted.
 */
function sanitizeEngineSave(saved, puzzle) {
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

  // Use the casual flag that was in effect when the game was saved, so that
  // toggling casual off and reloading never flips an in-progress game to
  // 'lost'. Falls back to current setting for saves written before this fix.
  var casual = typeof saved.casual === 'boolean' ? saved.casual : !!state.settings.casual;
  var phase = solved.length === puzzle.groups.length
    ? 'won'
    : (!casual && mistakes >= MAX_MISTAKES ? 'lost' : 'playing');
  // Extra guard: if the saved phase was 'playing' but the recomputed phase
  // would be 'lost' only because the player switched casual mode off since
  // the save, keep 'playing' and clamp mistakes so the game is not
  // immediately over on reload.
  if (saved.phase === 'playing' && phase === 'lost' &&
      typeof saved.casual === 'boolean' && saved.casual !== !!state.settings.casual) {
    phase = 'playing';
    mistakes = Math.min(mistakes, MAX_MISTAKES - 1);
  }

  return { caseId: puzzle.id, phase: phase, staging: staging, mistakes: mistakes, solved: solved, attempts: attempts, desk: saved.desk };
}

/* ── Desk state: scatter + healed restore ────────────────────────── */

function scatterSpot(rng) {
  var sc = state.layout.scatter;
  return {
    fx: 0.08 + 0.84 * rng(),
    fy: sc.lo + (sc.hi - sc.lo) * rng(),
  };
}

function freshDeskState(puzzle) {
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

/** Validate a saved desk block; fill gaps from a fresh scatter. */
function restoreDeskState(saved, puzzle, game) {
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

/* ════════════════════════════════════════════════════════════════════
 * SOUND — procedural WebAudio synthesis, file-overridable.
 *
 * Every cue is synthesized (no downloads). If assets/sounds/manifest.json
 * lists a file for a cue name, that file is fetched, decoded, and played
 * instead. All per-event tuning lives in SOUND_TUNING below.
 * ════════════════════════════════════════════════════════════════════ */

var SOUND_TUNING = {
  master: 0.5,             // master gain — everything stays well under 0dBFS
  'pickup-paper': { synth: 'noise', dur: 0.06, hp: 1400, lp: 6500, gain: 0.14, attack: 0.004 },
  'drop-paper':   { synth: 'noise', dur: 0.11, hp: 900, lp: 5200, gain: 0.22, attack: 0.006 },
  'film-rustle':  { synth: 'noise', dur: 0.13, hp: 320, lp: 2100, gain: 0.22, attack: 0.01 },
  'pickup-glass': { synth: 'partials', freqs: [2960, 4230], dur: 0.05, gain: 0.14 },
  'drop-glass':   { synth: 'partials', freqs: [2210, 3320], dur: 0.07, gain: 0.16 },
  'dock-glass':   { synth: 'partials', freqs: [1370, 2060], dur: 0.1, gain: 0.17 },
  'dial-tick':    { synth: 'tick', freq: 1800, dur: 0.028, gain: 0.2 },
  'pan-tick':     { synth: 'tick', freq: 1250, dur: 0.02, gain: 0.1 },
  /* "Scatter" cue — one smooth continuous whoosh, like a sheet of paper
     moving through air: a single noise source through a bandpass whose
     center sweeps 400→1200→600 Hz, with a gently ramped attack and a
     smooth decay to silence. No discrete bursts, no abrupt gain steps.
     Gain was 0.24 (louder than every other cue but "wrong"); brought down
     to 0.13 — in line with the other quiet paper cues (pickup-paper 0.14,
     drop-paper 0.22) — with a slightly slower attack so it reads as a
     soft riffle instead of a whoosh that grabs attention. */
  'shuffle':      { synth: 'shuffle', dur: 0.7, f0: 400, f1: 1200, f2: 600,
                     q: 0.8, attack: 0.12, gain: 0.13 },
  'correct':      { synth: 'notes', freqs: [392, 523.25], noteDur: 0.16, gain: 0.2 },
  'wrong':        { synth: 'thud', freq: 108, dur: 0.24, gain: 0.34 },
  'wrong-crack':  { synth: 'noise', dur: 0.09, hp: 2400, lp: 9000, gain: 0.2, attack: 0.002 },
  'one-away':     { synth: 'notes', freqs: [440], noteDur: 0.1, gain: 0.12 },
  'win':          { synth: 'notes', freqs: [392, 494, 587, 784], noteDur: 0.15, gain: 0.18 },
  'lose':         { synth: 'notes', freqs: [330, 262], noteDur: 0.22, gain: 0.16 },

  /* DEFAULT drag sound (research brief, Option A): distance-quantized
     scrape grains behind a speed-hysteresis gate. Silent at rest/hold;
     slow drags tick sparsely; fast slides fuse into a scrape. */
  scrape: {
    vOn: 250,        // px/s: gate opens
    vOff: 110,       // px/s: gate closes (hysteresis ~2:1)
    emaAlpha: 0.4,   // pointer-speed smoothing
    grainPx: 90,     // one grain per this many px of travel
    cooldownMs: 55,  // floor between grains
    gainLo: 0.35,    // grain gain at the gate
    gainHi: 1.0,     // grain gain at vRef
    vRef: 1400,      // px/s that reaches gainHi (sqrt curve)
    pitchLo: 0.89,   // ±2 semitones max
    pitchHi: 1.12,
    volJitterDb: 2.5,
    settleTick: true, // one soft tick on release after real motion
    materials: {
      paper: { hp: 1300, lp: 7000, dur: 0.045, gain: 0.09 },
      slide: { tick: true, freq: 2600, dur: 0.02, gain: 0.05 },
      film:  { hp: 300, lp: 1700, dur: 0.065, gain: 0.11 },
    },
  },

};

var SOUND_DEFAULTS = JSON.parse(JSON.stringify(SOUND_TUNING));

var audio = { ctx: null, master: null, buffers: {}, fileList: null, noise: null };

function audioCtx() {
  if (!state.settings.sound) return null;
  if (!audio.ctx) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = SOUND_TUNING.master;
    audio.master.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}

/** One shared 1s noise buffer, built lazily. */
function noiseBuffer(ctx) {
  if (!audio.noise) {
    audio.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var data = audio.noise.getChannelData(0);
    for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return audio.noise;
}

function envGain(ctx, start, peak, attack, dur) {
  var g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(peak, start + (attack || 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  g.connect(audio.master);
  return g;
}

function synthNoise(ctx, t, o, when) {
  var src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = o.rate || (0.9 + Math.random() * 0.25);
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = o.hp;
  var lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = o.lp;
  var start = when || t;
  src.connect(hp).connect(lp).connect(envGain(ctx, start, o.gain, o.attack, o.dur));
  src.start(start, Math.random() * 0.4, o.dur + 0.05);
}

function synthPartials(ctx, t, o) {
  o.freqs.forEach(function (f, i) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.01);
    osc.connect(envGain(ctx, t, o.gain / (i + 1), 0.002, o.dur * (1 + i * 0.3)));
    osc.start(t);
    osc.stop(t + o.dur * 2 + 0.05);
  });
}

function synthTick(ctx, t, o) {
  var osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = o.freq;
  osc.connect(envGain(ctx, t, o.gain, 0.001, o.dur));
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

function synthNotes(ctx, t, o) {
  o.freqs.forEach(function (f, i) {
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    var start = t + i * o.noteDur * 0.85;
    osc.connect(envGain(ctx, start, o.gain, 0.01, o.noteDur));
    osc.start(start);
    osc.stop(start + o.noteDur + 0.05);
  });
}

function synthThud(ctx, t, o) {
  var osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(o.freq * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(o.freq, t + o.dur * 0.5);
  osc.connect(envGain(ctx, t, o.gain, 0.004, o.dur));
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
  synthNoise(ctx, t, { hp: 80, lp: 500, gain: o.gain * 0.4, attack: 0.004, dur: o.dur * 0.5 });
}

/** "Scatter" cue: one smooth continuous whoosh — a single noise source
 *  through a bandpass whose center sweeps up then down (paper moving
 *  through air), with a gently ramped attack and a smooth decay to
 *  silence. Every automation is a ramp; there are no discrete bursts
 *  and no instant gain steps anywhere. */
function synthShuffle(ctx, t, o) {
  var dur = o.dur || 0.7;
  var peak = o.gain || 0.24;
  var attack = o.attack || 0.09;
  var src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = 0.9 + Math.random() * 0.12;
  var bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = o.q || 0.8;
  // Center frequency sweeps 400 → 1200 → 600 Hz across the whoosh.
  bp.frequency.setValueAtTime(o.f0 || 400, t);
  bp.frequency.linearRampToValueAtTime(o.f1 || 1200, t + dur * 0.4);
  bp.frequency.linearRampToValueAtTime(o.f2 || 600, t + dur);
  // Gain: gentle ramped attack, then a smooth two-stage ramp to silence.
  var g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.linearRampToValueAtTime(peak * 0.5, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  g.connect(audio.master);
  src.connect(bp).connect(g);
  src.start(t, Math.random() * 0.3, dur + 0.1);
  src.stop(t + dur + 0.05);
}

/** Load assets/sounds/manifest.json once; fetch listed override files. */
function loadSoundOverrides() {
  fetch(versioned('assets/sounds/manifest.json'))
    .then(function (r) { return r.ok ? r.json() : { present: [] }; })
    .then(function (m) {
      audio.fileList = {};
      (m.present || []).forEach(function (f) {
        var name = f.replace(/\.(mp3|wav|ogg)$/i, '');
        if (SOUND_TUNING[name]) audio.fileList[name] = 'assets/sounds/' + f;
      });
    })
    .catch(function () { audio.fileList = {}; });
}

function playFileCue(ctx, name, url) {
  if (audio.buffers[name]) {
    var src = ctx.createBufferSource();
    src.buffer = audio.buffers[name];
    src.connect(audio.master);
    src.start();
    return;
  }
  fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
    return ctx.decodeAudioData(ab);
  }).then(function (buf) {
    audio.buffers[name] = buf;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.master);
    src.start();
  }).catch(function () { /* fall back silently next call */ });
}

function playSound(name) {
  var o = SOUND_TUNING[name];
  if (!o) return;
  var ctx = audioCtx();
  if (!ctx) return;
  if (audio.fileList && audio.fileList[name]) {
    playFileCue(ctx, name, audio.fileList[name]);
    return;
  }
  var t = ctx.currentTime + 0.001;
  switch (o.synth) {
    case 'noise': synthNoise(ctx, t, o); break;
    case 'partials': synthPartials(ctx, t, o); break;
    case 'tick': synthTick(ctx, t, o); break;
    case 'notes': synthNotes(ctx, t, o); break;
    case 'thud': synthThud(ctx, t, o); break;
    case 'shuffle': synthShuffle(ctx, t, o); break;
  }
}

/** Pickup/drop cue routed by the piece's physical material. */
function pieceSound(zone, kind) {
  if (zone === 'rack') playSound(kind === 'pickup' ? 'pickup-glass' : 'drop-glass');
  else if (zone === 'tubes') playSound('film-rustle');
  else playSound(kind === 'pickup' ? 'pickup-paper' : 'drop-paper');
}

/* ════════════════════════════════════════════════════════════════════
 * TEXTURES — skeuomorphic pass, auto-detected.
 * No manifest, no registration step: drop a file with one of the known
 * names into assets/textures/ and it's used on the next load. Each name
 * is probed with an Image(); a missing file just keeps the CSS-drawn
 * look for that piece type (onerror is swallowed, nothing throws).
 * ════════════════════════════════════════════════════════════════════ */

var TEXTURE_VARS = {
  'desk.jpg': '--tex-desk',
  'sticky.png': '--tex-sticky',
  'sticky-pink.png': '--tex-sticky-pink',
  'sticky-green.png': '--tex-sticky-green',
  'sticky-orange.png': '--tex-sticky-orange',
  'sticky-2.png': '--tex-sticky-2',
  'sticky-3.png': '--tex-sticky-3',
  'paper.png': '--tex-paper',
  'paper-2.png': '--tex-paper-2',
  'slide.png': '--tex-slide',
  'film.png': '--tex-film',
  'photo.png': '--tex-photo',
  'photo-2.png': '--tex-photo-2',
  'rx.png': '--tex-rx',
  'rx-2.png': '--tex-rx-2',
};

/* Numbered alternates the per-piece seed may pick from (when present). */
var TEXTURE_VARIANTS = {
  corkboard: ['sticky.png', 'sticky-2.png', 'sticky-3.png'],
  folder: ['paper.png', 'paper-2.png'],
  photo: ['photo.png', 'photo-2.png'],
  rx: ['rx.png', 'rx-2.png'],
};

/**
 * Runtime alpha-trim: whatever margins or resolution a dropped file has,
 * only its non-transparent bounding box becomes the effective texture, so
 * every piece renders at the standardized per-type size. Returns the
 * trimmed bounding box's own dimensions too (even when no crop was
 * needed) so callers can reason about the texture's real aspect ratio —
 * `background-size: contain` letterboxes whenever that ratio doesn't match
 * the piece's CSS box, and the light box needs to know exactly where that
 * letterboxing falls (see updateFilmLighting).
 */
function alphaTrimInfo(img) {
  try {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h || w * h > 4096 * 4096) return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var d = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // fully transparent
    var tw = maxX - minX + 1, th = maxY - minY + 1;
    var url = null;
    if (tw !== w || th !== h) {
      var out = document.createElement('canvas');
      out.width = tw; out.height = th;
      out.getContext('2d').drawImage(c, minX, minY, tw, th, 0, 0, tw, th);
      url = out.toDataURL('image/png');
    }
    return { url: url, w: tw, h: th };
  } catch (e) {
    return null; // tainted/failed — use the file as-is
  }
}

function loadTextures() {
  var root = document.documentElement;
  state.textureAspect = state.textureAspect || {};
  Object.keys(TEXTURE_VARS).forEach(function (f) {
    var img = new Image();
    img.onload = function () {
      if (!state.textures) state.textures = new Set();
      state.textures.add(f);
      var url = 'url("assets/textures/' + f + '")';
      if (f !== 'desk.jpg') { // opaque full-frame backgrounds skip the trim
        var info = alphaTrimInfo(img);
        if (info) {
          if (info.url) url = 'url("' + info.url + '")';
          state.textureAspect[f] = info.w / info.h;
        }
      }
      root.style.setProperty(TEXTURE_VARS[f], url);
      document.body.classList.add('has-textures');
      if (f === 'desk.jpg') els.deskSurface.classList.add('textured');
      if (state.game) { fitPieceLabels(); syncPieces(); }
    };
    img.onerror = function () { /* not present — CSS look stands for this slot */ };
    img.src = 'assets/textures/' + f;
  });
}

/** Sticky color variant for an authored color (hue-matched). */
function stickyColorVariant(color) {
  var pick = 'sticky.png';
  if (color) {
    var c = color.replace('#', '');
    if (c.length === 3) c = c.replace(/(.)/g, '$1$1');
    var r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), bch = parseInt(c.slice(4, 6), 16);
    if (!isNaN(r)) {
      var mx = Math.max(r, g, bch), mn = Math.min(r, g, bch);
      var hue = 0;
      if (mx !== mn) {
        if (mx === r) hue = ((g - bch) / (mx - mn)) % 6;
        else if (mx === g) hue = (bch - r) / (mx - mn) + 2;
        else hue = (r - g) / (mx - mn) + 4;
        hue = (hue * 60 + 360) % 360;
      }
      if (hue >= 15 && hue < 45) pick = 'sticky-orange.png';
      else if (hue >= 90 && hue < 200) pick = 'sticky-green.png';
      else if (hue >= 260 || hue < 15) pick = 'sticky-pink.png';
    }
  }
  return pick;
}

/**
 * The seeded skin texture for a paper-family piece: colored stickies keep
 * their hue-matched variant; otherwise the seed picks among the numbered
 * alternates that actually loaded. Null when no texture applies.
 */
function pickSkinTexVar(item, rng) {
  if (!state.textures) { rng(); return null; }
  var kind = item.zone;
  var pick = null;
  if (kind === 'corkboard' && item.appearance && item.appearance.color) {
    pick = stickyColorVariant(item.appearance.color);
    if (!state.textures.has(pick)) pick = null;
  }
  if (!pick) {
    var pool = (TEXTURE_VARIANTS[kind] || []).filter(function (f) { return state.textures.has(f); });
    if (!pool.length) { rng(); return null; }
    pick = pool[Math.floor(rng() * pool.length) % pool.length];
  } else {
    rng();
  }
  return 'var(' + TEXTURE_VARS[pick] + ')';
}

/* ── Announcer + toast ───────────────────────────────────────────── */

function announce(text) {
  els.liveRegion.textContent = '';
  window.requestAnimationFrame(function () { els.liveRegion.textContent = text; });
}

function toast(text) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = text;
  els.toast.hidden = false;
  requestAnimationFrame(function () { els.toast.classList.add('show'); });
  state.toastTimer = setTimeout(function () {
    els.toast.classList.remove('show');
    setTimeout(function () { els.toast.hidden = true; }, 260);
  }, 2200);
}

/* ── Viewport health tip ─────────────────────────────────────────── */

function dismissViewportTip() {
  clearTimeout(viewportTipAutoHideTimer);
  var tip = document.getElementById('viewport-tip');
  if (!tip) return;
  tip.classList.remove('tip-visible');
  setTimeout(function () { tip.hidden = true; }, 260);
}

function showViewportTip() {
  if (viewportTipShownThisLoad) return;
  viewportTipShownThisLoad = true;
  var tip = document.getElementById('viewport-tip');
  if (!tip) return;
  tip.hidden = false;
  requestAnimationFrame(function () { tip.classList.add('tip-visible'); });
  viewportTipAutoHideTimer = setTimeout(dismissViewportTip, 15000);
}

/**
 * Checks whether the play-screen layout is under stress and shows the
 * viewport health tip (at most once per page load).
 *
 * Detection strategy:
 *   1. Skip genuine phones/tablets (coarse pointer + small screen — the
 *      responsive breakpoints already handle those).
 *   2. Horizontal document overflow: assets spilling outside the viewport.
 *   3. Viewport height < 500px or width < 640px on fine-pointer devices:
 *      below these values the desk + trays + header start colliding even
 *      after the responsive tweaks at 760/480px. (640px is the point the
 *      editor-drawer media query fires; 500px gives the wall area ~260px,
 *      header ~50px, and tray HUD ~120px — tight but possible; below 500px
 *      the three zones genuinely overlap.)
 *   4. Play-header height probe: when the header wraps onto two or more
 *      rows its measured height rises above ~80px (single row ≈ 42-48px;
 *      2× = ~84-96px). This fires whenever the user's window/zoom combo
 *      forces flex-wrap in the header, regardless of which dimension is
 *      the culprit — one cheap getBoundingClientRect call catches it all.
 */
function checkViewportHealth() {
  // Exclude genuine phones/tablets — responsive breakpoints cover them.
  if (window.matchMedia('(pointer: coarse)').matches
      && Math.min(screen.width, screen.height) <= 820) return;

  // Flag 1: horizontal overflow (zoomed in too far / very narrow window).
  if (document.documentElement.scrollWidth > window.innerWidth + 4) {
    showViewportTip();
    return;
  }

  // Flag 2: viewport dimensions below comfortable desktop minimums.
  if (window.innerHeight < 500 || window.innerWidth < 640) {
    showViewportTip();
    return;
  }

  // Flag 3: play-header has wrapped — a reliable single-element geometry probe.
  var header = document.querySelector('.play-header');
  if (header && header.getBoundingClientRect().height > 80) {
    showViewportTip();
  }
}

/* ── Screen switching ────────────────────────────────────────────── */

function showScreen(name) {
  ['screenMenu', 'screenPlay', 'screenError', 'screenEditor'].forEach(function (key) {
    if (els[key]) els[key].hidden = key !== name;
  });
}

function showOverlay(el) { el.hidden = false; }
function hideOverlay(el) { el.hidden = true; }

/** Give every new game a short orientation, while leaving editor and preview
    surfaces uncluttered. The primary button receives focus so the modal is
    immediately usable by keyboard. */
function showClueGuide() {
  if (state.previewMode || state.editorMode || state.layoutMode) return;
  showOverlay(els.overlayHelp);
  requestAnimationFrame(function () { els.btnCloseHelp.focus(); });
}

function closeClueGuide() {
  hideOverlay(els.overlayHelp);
  if (state.game) els.btnHelp.focus();
}

function showErrorScreen(message) {
  els.errorMessage.textContent = message;
  showScreen('screenError');
}

/* ── Registry + puzzle loading ───────────────────────────────────── */

function fetchJson(url) {
  return fetch(versioned(url)).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

function loadRegistry() {
  return fetchJson('puzzles/index.json').catch(function () { return CURRENT_INDEX; });
}

function loadPuzzleByEntry(entry) {
  return fetchJson('puzzles/' + entry.file).catch(function () {
    if (entry.id === CURRENT_PUZZLE.id) return CURRENT_PUZZLE;
    throw new Error('Could not load puzzle "' + entry.id + '" (fetch failed and no embedded fallback matches).');
  });
}

/* ── Menu rendering (puzzle-select dropdown, delegation — no per-item binds) ── */

function renderMenu(registry) {
  var puzzles = (registry.puzzles || []).slice().sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });

  // Update the trigger summary text.
  if (els.puzzleSelectSummary) {
    els.puzzleSelectSummary.textContent = puzzles.length
      ? puzzles.length + ' puzzle' + (puzzles.length !== 1 ? 's' : '')
      : 'No archived puzzles';
  }

  els.puzzleSelectList.innerHTML = '';

  if (!puzzles.length) {
    var empty = document.createElement('p');
    empty.className = 'archive-empty';
    empty.textContent = 'No archived puzzles yet.';
    els.puzzleSelectList.appendChild(empty);
    return;
  }

  puzzles.forEach(function (entry) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'puzzle-select-entry' + (entry.id === registry.current ? ' current' : '');
    btn.dataset.puzzleId = entry.id;
    btn.dataset.puzzleFile = entry.file;

    // Title
    var titleSpan = document.createElement('span');
    titleSpan.className = 'puzzle-select-entry-title';
    titleSpan.textContent = entry.title;
    btn.appendChild(titleSpan);

    // "This week" pill for the current puzzle
    if (entry.id === registry.current) {
      var pill = document.createElement('span');
      pill.className = 'puzzle-select-pill';
      pill.textContent = 'This week';
      btn.appendChild(pill);
    }

    // Played check mark (won or lost both count)
    var played = false;
    try {
      var raw = localStorage.getItem(SAVE_NS + entry.id);
      if (raw) {
        var save = JSON.parse(raw);
        played = save.phase === 'won' || save.phase === 'lost';
      }
    } catch (e) { /* treat as unplayed */ }
    if (played) {
      var check = document.createElement('span');
      check.className = 'puzzle-select-played';
      check.textContent = '✓';
      check.setAttribute('aria-label', 'Played');
      btn.appendChild(check);
    }

    // Date
    var dateSpan = document.createElement('span');
    dateSpan.className = 'archive-date';
    dateSpan.textContent = entry.date || '';
    btn.appendChild(dateSpan);

    li.appendChild(btn);
    els.puzzleSelectList.appendChild(li);
  });
}

/* ── Geometry ────────────────────────────────────────────────────── */

/** An element's rect in play-area coordinates. */
function rectRel(el) {
  var pr = els.playArea.getBoundingClientRect();
  var r = el.getBoundingClientRect();
  return {
    left: r.left - pr.left,
    top: r.top - pr.top,
    right: r.right - pr.left,
    bottom: r.bottom - pr.top,
    width: r.width,
    height: r.height,
    cx: r.left - pr.left + r.width / 2,
    cy: r.top - pr.top + r.height / 2,
  };
}

function pointIn(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/* ── Opening a puzzle ────────────────────────────────────────────── */

function openPuzzle(puzzleData) {
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

function onEngineChange() {
  persistGame();
  syncAll();
}

function onPhaseChange(p) {
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

/* ── Pieces: build once per puzzle, sync forever ─────────────────── */

function buildPieces() {
  var puzzle = state.game.puzzle;
  els.pieceLayer.innerHTML = '';
  state.pieceEls = {};

  puzzle.items.forEach(function (item) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'piece ' + PIECE_CLASS[item.zone];
    b.dataset.itemId = item.id;
    b.setAttribute('aria-describedby', 'piece-instructions');

    // Deterministic per-piece seed: handwriting jitter + visual variety.
    var rng = mulberry32(hashString(item.id));

    if (item.zone === 'corkboard') {
      var color = (item.appearance && item.appearance.color) || fallbackColor(item.id);
      b.style.setProperty('--pc-color', color);
    }

    // Paper-family pieces get a seeded "skin": texture variant, flip,
    // brightness/hue jitter, corner fold, and sometimes a tape strip —
    // so no two pieces read as clones.
    if (PAPER_FAMILY[item.zone]) decoratePaperPiece(b, item, rng);

    if (item.zone === 'rack') {
      // Slide: anonymous letter on the frosted end (A, B, C… — an
      // identifier, never the readable clue). The clue itself needs the microscope.
      var frost = document.createElement('span');
      frost.className = 'piece-frost';
      var letter = document.createElement('span');
      letter.className = 'slide-letter';
      letter.setAttribute('aria-hidden', 'true');
      letter.textContent = state.slideLetters[item.id] || '';
      frost.appendChild(letter);
      b.appendChild(frost);
    } else if (item.zone === 'tubes') {
      // X-ray film: lit layer only shows inside the light-box overlap.
      var lit = document.createElement('span');
      lit.className = 'film-lit';
      lit.setAttribute('aria-hidden', 'true');
      if (item.info && item.info.image) {
        lit.classList.add('has-image');
        lit.style.backgroundImage = 'url("' + item.info.image + '")';
      } else {
        var litLabel = document.createElement('span');
        litLabel.className = 'film-lit-label';
        litLabel.textContent = item.label;
        lit.appendChild(litLabel);
      }
      b.appendChild(lit);
      var filmEtch = document.createElement('span');
      filmEtch.className = 'piece-etch';
      filmEtch.setAttribute('aria-hidden', 'true');
      filmEtch.textContent = item.label;
      b.appendChild(filmEtch);
    } else if (item.zone === 'photo') {
      // Photograph: the image IS the clue; without one, a gray "no photo"
      // window with the label written on the bottom border strip.
      var win = document.createElement('span');
      win.className = 'photo-window';
      win.setAttribute('aria-hidden', 'true');
      if (item.info && item.info.image) {
        win.style.backgroundImage = 'url("' + item.info.image + '")';
        win.classList.add('has-image');
      }
      b.appendChild(win);
      if (!(item.info && item.info.image)) {
        var cap = document.createElement('span');
        cap.className = 'piece-label photo-caption';
        cap.textContent = item.label;
        cap.style.setProperty('--ink-rot', (-1.5 + 3 * rng()).toFixed(2) + 'deg');
        cap.style.setProperty('--ink-size', (0.92 + 0.16 * rng()).toFixed(3));
        b.appendChild(cap);
      }
    } else if (item.zone === 'rx') {
      // Prescription: printed ℞ glyph, medication line in handwriting.
      var glyph = document.createElement('span');
      glyph.className = 'rx-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = '℞';
      b.appendChild(glyph);
      var med = document.createElement('span');
      med.className = 'piece-label rx-line';
      med.textContent = item.label;
      med.style.setProperty('--ink-rot', (-2 + 4 * rng()).toFixed(2) + 'deg');
      med.style.setProperty('--ink-size', (0.92 + 0.16 * rng()).toFixed(3));
      b.appendChild(med);
    } else {
      var label = document.createElement('span');
      label.className = 'piece-label';
      label.textContent = item.label;
      label.style.setProperty('--ink-rot', (-2 + 4 * rng()).toFixed(2) + 'deg');
      label.style.setProperty('--ink-size', (0.92 + 0.16 * rng()).toFixed(3));
      b.appendChild(label);
    }

    state.pieceEls[item.id] = b;
    els.pieceLayer.appendChild(b);
  });
}

/** Seeded variety for paper-family pieces (stickies/papers/photos/scripts). */
function decoratePaperPiece(b, item, rng) {
  var skin = document.createElement('span');
  skin.className = 'piece-skin';
  skin.setAttribute('aria-hidden', 'true');
  // Seeded horizontal flip for variety — but never on rx (or photo, which
  // no longer reaches here): flipping baked Rx/photo content reads backwards.
  var flip = rng() < 0.5 ? '1' : '-1';
  skin.style.setProperty('--skin-flip', item.zone === 'rx' ? '1' : flip);
  var bright = (0.965 + rng() * 0.07).toFixed(3);
  var hue = (-4 + rng() * 8).toFixed(1);
  skin.style.setProperty('--skin-filter', 'brightness(' + bright + ') hue-rotate(' + hue + 'deg)');
  var tex = pickSkinTexVar(item, rng);
  if (tex) skin.style.setProperty('--skin-tex', tex);
  if (item.zone === 'rx') skin.style.setProperty('--skin-skew', (-1.5 + rng() * 3).toFixed(2) + 'deg');
  b.appendChild(skin);
}

/* Where does this piece currently live? */
function pieceLocation(id) {
  var game = state.game;
  var cell = game.cellOfItem(id);
  if (cell) return { kind: 'tray', box: cell.box, slot: cell.slot, locked: game.isBoxLocked(cell.box) };
  if (state.desk.scope === id) return { kind: 'scope' };
  if (itemById(id).zone === 'tubes') return { kind: 'wall' };
  return { kind: 'desk' };
}

/**
 * The viewer is a SQUARE sized from the height left between the header
 * and the tray HUD; the desk gets the remaining width at the same
 * height. Below 900px the CSS stacking layout takes over instead.
 */
function sizeViewer() {
  if (!els.screenPlay || els.screenPlay.hidden) return;

  // The lightbox gets an inline size from layout.json, which otherwise
  // permanently beats the CSS media query meant to shrink it on phones.
  // Below the lightbox breakpoint, clear the inline override so CSS can
  // provide the responsive size.
  if (window.innerWidth <= 760) {
    els.lightboxScreen.style.width = '';
    els.lightboxScreen.style.height = '';
  } else if (state.layout && state.layout.lightbox) {
    els.lightboxScreen.style.width = state.layout.lightbox.w + 'px';
    els.lightboxScreen.style.height = state.layout.lightbox.h + 'px';
  }
  clampMachinesToDesk();

  if (window.innerWidth < 900) {
    els.scopePanel.style.width = '';
    els.scopeDisplayWrap.style.width = '';
    els.scopeDisplayWrap.style.height = '';
    return;
  }
  // The panel is an overlay on wide screens. Keep it inset on the left and
  // give the microscope feed a wider-than-tall viewing window.
  var mainH = els.scopePanel.parentElement.getBoundingClientRect().height;
  var panelChromeV = 10 * 2 + 2; // padding top+bottom + border
  var availH = mainH - panelChromeV;
  var displayH = clamp(availH, 220, 300);
  var displayW = clamp(Math.min(window.innerWidth * 0.32, displayH * 1.45), 320, 430);
  els.scopeDisplayWrap.style.width = displayW + 'px';
  els.scopeDisplayWrap.style.height = displayH + 'px';
  els.scopePanel.style.width = (displayW + 22) + 'px';
  renderScopeView();
}

/** Keep the microscope stage inside the tabletop after every layout pass. */
function clampMachinesToDesk() {
  if (!els.deskSurface) return;
  var deskRect = els.deskSurface.getBoundingClientRect();
  if (!deskRect.width || !deskRect.height) return;
  var margin = 0;
  [els.machineScope].forEach(function (el) {
    if (!el || el.hidden) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var curLeft = r.left - deskRect.left;
    var curTop = r.top - deskRect.top;
    var maxLeft = Math.max(margin, deskRect.width - r.width - margin);
    var maxTop = Math.max(margin, deskRect.height - r.height - margin);
    var newLeft = clamp(curLeft, margin, maxLeft);
    var newTop = clamp(curTop, margin, maxTop);
    if (Math.abs(newLeft - curLeft) > 0.5) el.style.left = newLeft + 'px';
    if (Math.abs(newTop - curTop) > 0.5) el.style.top = newTop + 'px';
  });
}

function syncHintsBtn() {
  if (!els.btnHints) return;
  var phase = state.game ? state.game.phase : null;
  var isOver = phase === 'won' || phase === 'lost';
  els.btnHints.disabled = isOver;
}

function syncAll() {
  if (!state.game) return;
  sizeViewer();
  fitPieceLabels();
  syncHeader();
  syncTrays();
  syncMachines();
  syncPieces();
  syncRevealNote();
  syncHintsBtn();
}

/** Which element (if any) on a piece carries its readable clue text, per
 * zone. Slides (rack) and films (tubes) read off-piece — on the microscope
 * viewer / light box — so they're excluded; their on-piece letter/etch
 * chips are deliberately tiny and untouched by auto-fit. A photo with an
 * image has no caption element at all (the image IS the clue), so the
 * lookup can come up empty — callers must check for that. */
var LABEL_FIT_ZONES = {
  corkboard: { sel: '.piece-label', maxLines: 3 },
  folder:    { sel: '.piece-label', maxLines: 4 },
  deskCards: { sel: '.piece-label', maxLines: 3 },
  rx:        { sel: '.rx-line', maxLines: 3 },
  photo:     { sel: '.photo-caption', maxLines: 2 },
};
var LABEL_FIT_MIN_PX = 9.5;   // never shrink a clue below this — stays legible
var LABEL_FIT_STEP = 0.05;    // scale decrement per fit iteration
var LABEL_FIT_TOLERANCE = 1.06; // 6% slack before a line count "counts" as overflow

/**
 * Auto-fit every clue label to its piece: shrink font-size (via the
 * --fit-scale custom property, see styles.css) until the label's wrapped
 * height fits within a per-zone line budget, or a legibility floor is
 * hit — whichever comes first. Short labels are untouched (scale stays 1,
 * i.e. the type's normal baseline size); only labels that would otherwise
 * wrap awkwardly or overflow their piece shrink. Idempotent and cheap
 * enough to call on every layout pass (16 pieces, a handful of forced
 * reflows each) — called alongside sizeViewer() from syncAll() and the
 * window resize handler, so it re-settles on puzzle load, resize, and
 * every discrete game action.
 *
 * A per-item `labelScale` (authored in ?editor) multiplies the auto-fit
 * result: absent/undefined means pure auto-fit; present lets an author
 * nudge one stubborn clue smaller (fit tighter than the algorithm chose)
 * or larger (override it, accepting the overflow risk that implies).
 */
function fitPieceLabels() {
  var game = state.game;
  if (!game || !state.pieceEls) return;
  game.puzzle.items.forEach(function (item) {
    var pieceEl = state.pieceEls[item.id];
    if (!pieceEl) return;
    var cfg = LABEL_FIT_ZONES[item.zone];
    if (!cfg) return;
    var textEl = pieceEl.querySelector(cfg.sel);
    if (!textEl) return; // e.g. a photo with an image has no caption span
    fitOneLabel(textEl, cfg.maxLines, item);
  });
}

function fitOneLabel(textEl, maxLines, item) {
  // Reset to the natural (unshrunk) size before measuring — otherwise a
  // previous fit pass's scale would corrupt this one's baseline reading.
  textEl.style.removeProperty('--fit-scale');
  var cs = window.getComputedStyle(textEl);
  var baseFontPx = parseFloat(cs.fontSize) || 12;
  var lineHeightPx = parseFloat(cs.lineHeight);
  if (!isFinite(lineHeightPx)) lineHeightPx = baseFontPx * 1.2; // 'normal' fallback
  var lineHeightRatio = lineHeightPx / baseFontPx;
  var floorScale = Math.min(1, LABEL_FIT_MIN_PX / baseFontPx);

  // Measure the natural line count at scale=1 with a single read, then
  // compute the target scale arithmetically (one write) and verify with
  // at most 2 extra shrink steps. The old per-step write→read loop
  // forced a reflow every iteration — this cuts it to ≤3 reads per label.
  var scale = 1;
  var linesNatural = textEl.scrollHeight / lineHeightPx;
  if (linesNatural > maxLines * LABEL_FIT_TOLERANCE) {
    var rawScale = (maxLines * LABEL_FIT_TOLERANCE) / linesNatural;
    scale = Math.max(floorScale, Math.floor(rawScale / LABEL_FIT_STEP) * LABEL_FIT_STEP);
    textEl.style.setProperty('--fit-scale', String(scale));
    // Verification: at most 2 extra steps if the linear estimate was off
    // (word-wrap is non-linear — one or two corrections handle all real cases).
    for (var pass = 0; pass < 2 && scale > floorScale; pass++) {
      var curLineHeightPx = lineHeightRatio * baseFontPx * scale;
      if (textEl.scrollHeight / curLineHeightPx <= maxLines * LABEL_FIT_TOLERANCE) break;
      scale = Math.max(floorScale, +(scale - LABEL_FIT_STEP).toFixed(3));
      textEl.style.setProperty('--fit-scale', String(scale));
    }
  }

  var override = item && isFinite(item.labelScale) && item.labelScale > 0 ? item.labelScale : null;
  var finalScale = override ? clamp(scale * override, 0.35, 2) : scale;
  textEl.style.setProperty('--fit-scale', String(finalScale));
}

function syncHeader() {
  var game = state.game;
  var puzzle = game.puzzle;
  els.puzzleTitle.textContent = puzzle.title;
  els.puzzleDate.textContent = puzzle.date || '';
  document.title = puzzle.title + ' : Desk Puzzle';

  els.mistakeTracker.innerHTML = '';
  var box = document.createElement('div');
  box.className = 'guesses';
  box.id = 'guesses-box';
  var lab = document.createElement('span');
  lab.className = 'guesses-label';
  lab.textContent = state.settings.casual ? 'Mistakes' : 'Guesses left';
  box.appendChild(lab);
  if (state.settings.casual) {
    var count = document.createElement('span');
    count.className = 'guesses-count';
    count.textContent = String(game.mistakes);
    box.appendChild(count);
  } else {
    var wrap = document.createElement('div');
    wrap.className = 'pips';
    for (var i = 0; i < MAX_MISTAKES; i++) {
      var pip = document.createElement('span');
      pip.className = 'pip' + (i < game.mistakes ? ' used' : '');
      wrap.appendChild(pip);
    }
    box.appendChild(wrap);
    var count2 = document.createElement('span');
    count2.className = 'guesses-count';
    count2.textContent = String(Math.max(0, MAX_MISTAKES - game.mistakes));
    box.appendChild(count2);
  }
  els.mistakeTracker.appendChild(box);
  els.mistakeTracker.setAttribute('aria-label',
    state.settings.casual ? game.mistakes + ' mistakes so far' : Math.max(0, MAX_MISTAKES - game.mistakes) + ' guesses left');
}

function syncTrays() {
  var game = state.game;
  for (var b = 0; b < BOX_COUNT; b++) {
    var locked = game.isBoxLocked(b);
    var solvedEntry = null;
    for (var i = 0; i < game.solved.length; i++) {
      if (game.solved[i].boxIndex === b) solvedEntry = game.solved[i];
    }
    var group = solvedEntry
      ? game.puzzle.groups.find(function (g) { return g.id === solvedEntry.groupId; })
      : null;

    trayEls[b].classList.toggle('is-locked', locked);
    if (group) {
      trayEls[b].style.setProperty('--group-color', 'var(--tier-' + group.tier + ')');
      trayEls[b].style.setProperty('--group-ink', 'var(--tier-' + group.tier + '-ink)');
      trayHeaderEls[b].textContent = group.name;
    } else {
      trayEls[b].style.removeProperty('--group-color');
      trayEls[b].style.removeProperty('--group-ink');
      trayHeaderEls[b].textContent = 'Tray ' + String.fromCharCode(65 + b);
    }

    var count = game.staging[b].filter(function (c) { return c !== null; }).length;
    lockBtnEls[b].disabled = locked || count !== GROUP_SIZE;
    lockBtnEls[b].hidden = locked;
  }
}

/* ── Machines sync: scope display + printer counter ──────────────── */

// hintsLeft() is legacy — printer label creation is retired in v15.
// Returns 0 always so printLabel()'s guard never passes; printLabel is dead
// code retained only for save-format compatibility; nothing calls it.
function hintsLeft() {
  return 0;
}

function syncMachines() {
  if (hasMachine('scope')) renderScopeView();
  // Printer counter chips removed (v15: printer is retired from hint duties).
  if (els.printerCount) els.printerCount.innerHTML = '';
}

/* ════════════════════════════════════════════════════════════════════
 * SCOPE DISPLAY — canvas viewport with objectives, pan, and resize.
 * NO text is drawn for slides with a real image; slides WITHOUT one get
 * their label rendered as the etched-glass specimen itself (otherwise a
 * text-only puzzle would be unsolvable).
 * ════════════════════════════════════════════════════════════════════ */

/** Procedural specimen for slides without a scope image: the word IS the
    tissue — etched into pink glass, readable at any magnification. */
function makeLabelSpecimen(item) {
  var w = 900, h = 560;
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  if (!ctx) return c;
  var rng = mulberry32(hashString(item.id));

  var grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#f6ebf0');
  grad.addColorStop(1, '#eddbe5');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // faint smear field
  for (var i = 0; i < 26; i++) {
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 30 + rng() * 110, 18 + rng() * 60, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(214,120,150,' + (0.04 + rng() * 0.07).toFixed(3) + ')';
    ctx.fill();
  }
  // speckles
  for (var j = 0; j < 140; j++) {
    ctx.beginPath();
    ctx.arc(rng() * w, rng() * h, 0.6 + rng() * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(96,44,96,' + (0.08 + rng() * 0.16).toFixed(3) + ')';
    ctx.fill();
  }

  // the etched word
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var size = 170;
  ctx.font = '700 ' + size + 'px Georgia, serif';
  while (ctx.measureText(item.label).width > w * 0.86 && size > 40) {
    size -= 10;
    ctx.font = '700 ' + size + 'px Georgia, serif';
  }
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-3 + rng() * 6) * Math.PI / 180);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText(item.label, 2, 3);
  ctx.fillStyle = 'rgba(93,58,102,0.6)';
  ctx.fillText(item.label, 0, 0);
  ctx.strokeStyle = 'rgba(93,58,102,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeText(item.label, 0, 0);
  ctx.restore();
  return c;
}

/** Resolve the docked slide's view source (cached; images load async). */
function scopeSource(item) {
  var cached = state.scopeSources[item.id];
  if (cached) return cached.ready ? cached.el : null;
  if (item.scope && item.scope.image) {
    var img = new Image();
    var entry = { el: img, ready: false };
    state.scopeSources[item.id] = entry;
    img.onload = function () { entry.ready = true; renderScopeView(); };
    img.onerror = function () {
      // fall back to the etched-label specimen
      state.scopeSources[item.id] = { el: makeLabelSpecimen(item), ready: true };
      renderScopeView();
    };
    img.src = item.scope.image;
    return null;
  }
  var spec = { el: makeLabelSpecimen(item), ready: true };
  state.scopeSources[item.id] = spec;
  return spec.el;
}

function renderScopeView() {
  var canvas = els.scopeCanvas;
  if (!canvas) return;
  var cw = els.scopeDisplayWrap.clientWidth;
  var ch = els.scopeDisplayWrap.clientHeight;
  if (cw < 10 || ch < 10) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // idle bed
  var bed = ctx.createRadialGradient(cw / 2, ch / 2, 10, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
  bed.addColorStop(0, '#f4ecdc');
  bed.addColorStop(1, '#d9cdb4');
  ctx.fillStyle = bed;
  ctx.fillRect(0, 0, cw, ch);

  var slideId = state.desk && state.desk.scope;
  var titleEl = document.getElementById('scope-slide-title');
  if (titleEl) titleEl.textContent = slideId ? 'Slide ' + (state.slideLetters[slideId] || '') : '';
  if (!slideId) {
    // empty stage: a faint objective circle, no text
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(77, 68, 55, 0.25)';
    ctx.lineWidth = 3;
    ctx.stroke();
    return;
  }

  var item = itemById(slideId);
  var src = scopeSource(item);
  if (!src) {
    // image still loading: soft shimmer ring
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(122, 79, 192, 0.35)';
    ctx.lineWidth = 4;
    ctx.stroke();
    return;
  }

  var sw = src.width, sh = src.height;
  var cover = Math.max(cw / sw, ch / sh);
  var vw = cw / cover, vh = ch / cover;
  var sx = (sw - vw) / 2;
  var sy = (sh - vh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, sx, sy, vw, vh, 0, 0, cw, ch);

  // soft vignette so it reads as an eyepiece feed
  var vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.42, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
  vg.addColorStop(0, 'rgba(40, 30, 16, 0)');
  vg.addColorStop(1, 'rgba(40, 30, 16, 0.35)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, cw, ch);
}

/* ════════════════════════════════════════════════════════════════════
 * FILM LIGHTING — the light box shines THROUGH films. Each film's lit
 * layer is clipped to the geometric intersection of the film rect with
 * the light box rect, so half-on means half-lit. Films never rotate.
 * ════════════════════════════════════════════════════════════════════ */

function updateFilmLighting() {
  if (!state.game || !state.desk) return;
  if (!hasMachine('lightbox')) return; // no box, nothing lights
  var boxR = els.lightboxScreen.getBoundingClientRect();
  state.game.puzzle.items.forEach(function (item) {
    if (item.zone !== 'tubes') return;
    var el = state.pieceEls[item.id];
    if (!el) return;
    var lit = el.firstChild && el.querySelector('.film-lit');
    if (!lit) return;
    var r = el.getBoundingClientRect();
    if (boxR.left >= r.right || boxR.right <= r.left || boxR.top >= r.bottom || boxR.bottom <= r.top) {
      lit.style.clipPath = 'inset(100%)';
      return;
    }
    var top = Math.max(0, boxR.top - r.top);
    var left = Math.max(0, boxR.left - r.left);
    var right = Math.max(0, r.right - boxR.right);
    var bottom = Math.max(0, r.bottom - boxR.bottom);
    lit.style.clipPath = 'inset(' + top.toFixed(1) + 'px ' + right.toFixed(1) + 'px ' + bottom.toFixed(1) + 'px ' + left.toFixed(1) + 'px)';
  });
}

/** Films animate into place over ~0.22s — recompute after they settle. */
function scheduleFilmLighting() {
  updateFilmLighting();
  clearTimeout(state.filmLightTimer);
  state.filmLightTimer = setTimeout(updateFilmLighting, 280);
}

/* ── Piece sync: position, classes, aria, labels ─────────────────── */

function syncPieces() {
  var game = state.game;
  var deskRect = rectRel(els.deskSurface);
  var wallRect = rectRel(els.xrayRail);
  var stageRect = rectRel(els.scopeStage);

  game.puzzle.items.forEach(function (item) {
    var id = item.id;
    var el = state.pieceEls[id];
    if (!el) return;

    // Textures may arrive after buildPieces — update skin + class then.
    if (state.textures) {
      var skinEl = el.querySelector('.piece-skin');
      if (skinEl && !skinEl.style.getPropertyValue('--skin-tex')) {
        var tex = pickSkinTexVar(item, mulberry32(hashString(item.id)));
        if (tex) skinEl.style.setProperty('--skin-tex', tex);
      }
      var hasType = PAPER_FAMILY[item.zone]
        ? !!(skinEl && skinEl.style.getPropertyValue('--skin-tex'))
        : state.textures.has({ rack: 'slide.png', tubes: 'film.png' }[item.zone]);
      el.classList.toggle('textured', !!hasType);
    }

    // Legacy printed hint label (idempotent — keeps old in-progress saves readable).
    if (state.desk.labels[id] && !el.querySelector('.hint-label')) {
      var legacyTag = document.createElement('span');
      legacyTag.className = 'hint-label';
      legacyTag.setAttribute('aria-hidden', 'true');
      legacyTag.textContent = item.label;
      el.appendChild(legacyTag);
    }

    // H1 id-tag: shows info.title on image pieces when Label Images hint is used (idempotent).
    var hints = state.desk.hints;
    if (hints && hints.labels
        && (item.zone === 'photo' || item.zone === 'rack' || item.zone === 'tubes')
        && item.info && item.info.title
        && !el.querySelector('.id-tag')) {
      var idTag = document.createElement('span');
      idTag.className = 'id-tag';
      idTag.setAttribute('aria-hidden', 'true');
      idTag.textContent = item.info.title;
      el.appendChild(idTag);
    }

    // H2 pin marker: only show on staged-but-not-locked pieces (idempotent).
    var isPinned = hints && hints.pinned && hints.pinned[id] !== undefined;
    var pieceLocNow = pieceLocation(id);
    var shouldShowPin = isPinned && pieceLocNow.kind === 'tray' && !pieceLocNow.locked;
    var isPeekable = shouldShowPin && (item.zone === 'rack' || item.zone === 'tubes');
    if (shouldShowPin && !el.querySelector('.pin-marker')) {
      var pinMark = document.createElement('span');
      pinMark.className = 'pin-marker';
      pinMark.setAttribute('aria-hidden', 'true');
      el.appendChild(pinMark);
    }
    if (!shouldShowPin && el.querySelector('.pin-marker')) {
      var oldPin = el.querySelector('.pin-marker');
      if (oldPin) oldPin.parentNode.removeChild(oldPin);
    }
    // Loupe badge + zoom-in cursor for peekable pinned pieces (rack/tubes).
    el.classList.toggle('piece-peekable', isPeekable);
    if (isPeekable && !el.querySelector('.peek-loupe')) {
      var loupeEl = document.createElement('span');
      loupeEl.className = 'peek-loupe';
      loupeEl.setAttribute('aria-hidden', 'true');
      el.appendChild(loupeEl);
    }
    if (!isPeekable && el.querySelector('.peek-loupe')) {
      var oldLoupe = el.querySelector('.peek-loupe');
      if (oldLoupe) oldLoupe.parentNode.removeChild(oldLoupe);
    }

    if (state.drag && state.drag.id === id) return; // never fight an active drag

    var loc = pieceLocation(id);
    var frozen = loc.kind === 'tray' && loc.locked;
    var x, y, rot;

    if (loc.kind === 'tray') {
      var slotRect = rectRel(slotEls[loc.box][loc.slot]);
      x = slotRect.cx;
      y = slotRect.cy;
      rot = 0;
    } else if (loc.kind === 'scope') {
      x = stageRect.cx;
      y = stageRect.cy - 4;
      rot = 0;
    } else if (loc.kind === 'wall') {
      var wp = state.desk.pos[id];
      x = wallRect.left + wp.fx * wallRect.width;
      // The rail's top edge is the hanging line. Use the rendered film
      // height so this remains aligned after narrow-screen scaling too.
      y = wallRect.top + el.getBoundingClientRect().height / 2;
      rot = 0;
    } else {
      var p = state.desk.pos[id];
      x = deskRect.left + p.fx * deskRect.width;
      y = deskRect.top + p.fy * deskRect.height;
      rot = state.desk.rot[id];
      // Scatter fx/fy plus per-type pieceScale are both authored against a
      // roomy desktop desk; on a narrow phone desk an enlarged piece near
      // the scatter margin's edge can render with part of its box past the
      // desk boundary — and since the desk has no overflow clip, that
      // widens the whole page (the same class of bug the machines had).
      // Clamp the piece's rendered half-size back inside the desk. A 1.7x
      // safety factor stands in for the CSS scale() this box may carry
      // (pieceScale, up to 1.6 in the shipped layout.json) plus rotation
      // slack, without the cost of decomposing the live transform matrix.
      var halfW = (el.offsetWidth / 2) * 1.7, halfH = (el.offsetHeight / 2) * 1.7;
      if (halfW * 2 <= deskRect.width) x = clamp(x, deskRect.left + halfW, deskRect.left + deskRect.width - halfW);
      if (halfH * 2 <= deskRect.height) y = clamp(y, deskRect.top + halfH, deskRect.top + deskRect.height - halfH);
    }

    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--rot', rot + 'deg');
    el.style.zIndex = String(10 + (state.desk.z[id] || 1));

    el.classList.toggle('in-tray', loc.kind === 'tray');
    el.classList.toggle('on-machine', loc.kind === 'scope');
    el.classList.toggle('on-wall', loc.kind === 'wall');
    el.classList.toggle('is-locked', frozen);
    el.tabIndex = frozen ? -1 : 0;

    var noun = PIECE_NOUN[item.zone];
    var where;
    if (loc.kind === 'tray') {
      if (frozen) {
        var g = groupOfItem(game.puzzle, id);
        where = 'locked in ' + g.name;
      } else {
        where = 'in ' + TRAY_NAMES[loc.box] + ', slot ' + (loc.slot + 1);
      }
    } else if (loc.kind === 'scope') {
      where = 'on the microscope stage';
    } else if (loc.kind === 'wall') {
      where = 'on the wall X-ray rail';
    } else {
      where = 'on the desk';
    }
    var labeled = state.desk.labels[id] ? ', labeled' : '';
    var isViewablePinned = isPinned && (item.zone === 'rack' || item.zone === 'tubes');
    var pinnedNote = isPinned ? (isViewablePinned ? ' — pinned, press V or tap to view' : ', pinned by hint') : '';
    var spoken = item.zone === 'rack' ? 'Slide ' + (state.slideLetters[id] || '?') : item.label;
    el.setAttribute('aria-label', spoken + ', ' + noun + labeled + pinnedNote + ', ' + where);
  });

  scheduleFilmLighting();
}

/* ── The label printer ───────────────────────────────────────────── */

function printLabel(id) {
  var item = itemById(id);
  if (state.desk.labels[id]) {
    toast('That piece already has a label.');
    announce(item.label + ' already has a label.');
    return false;
  }
  if (!hasMachine('printer')) {
    toast('This puzzle has no label printer.');
    announce('This puzzle has no label printer.');
    return false;
  }
  if (hintsLeft() <= 0) {
    toast('Out of blank labels.');
    announce('No blank labels left.');
    return false;
  }
  state.desk.labels[id] = true;
  state.desk.hintsUsed += 1;
  // Bring the labeled piece to the front of the desk z-order so its
  // printed label (which now overflows the piece's own box — see the
  // .hint-label rule in styles.css) can't be covered by a neighboring
  // piece that happens to sit on top of it.
  state.desk.z[id] = ++state.desk.zTop;
  playSound('print');
  announce('Label printed: ' + item.label + '.');
  syncAll();
  persistGame();
  return true;
}

/* ════════════════════════════════════════════════════════════════════
 * HINTS SYSTEM (v15) — three free hints per puzzle, each once.
 *
 * H1 Label Images: attaches .id-tag showing info.title on image pieces.
 * H2 Seed the Trays: places one piece per unsolved group + pins it.
 * H3 Reveal a Category: shows lowest-tier unsolved group name on a sticky.
 *
 * State lives in state.desk.hints = { labels, seeds, category,
 *   revealedGroupId, pinned:{itemId:boxIndex} }.
 * ════════════════════════════════════════════════════════════════════ */

function openSettingsPanel() {
  if (!els.settingsPanel || !els.btnSettings) return;
  closeHintsPanel(); // only one panel open at a time
  els.settingsPanel.hidden = false;
  els.btnSettings.setAttribute('aria-expanded', 'true');
}

function closeSettingsPanel() {
  if (!els.settingsPanel) return;
  els.settingsPanel.hidden = true;
  if (els.btnSettings) els.btnSettings.setAttribute('aria-expanded', 'false');
}

function toggleSettingsPanel() {
  if (!els.settingsPanel) return;
  if (els.settingsPanel.hidden) openSettingsPanel(); else closeSettingsPanel();
}

function openHintsPanel() {
  if (!els.hintsPanel || !els.btnHints) return;
  closeSettingsPanel(); // only one panel open at a time
  buildHintsPanel();
  els.hintsPanel.hidden = false;
  els.btnHints.setAttribute('aria-expanded', 'true');
  // Focus first enabled row button.
  var first = els.hintsPanel.querySelector('.hint-row-btn:not([disabled])');
  if (first) first.focus();
}

function closeHintsPanel() {
  if (!els.hintsPanel) return;
  els.hintsPanel.hidden = true;
  if (els.btnHints) els.btnHints.setAttribute('aria-expanded', 'false');
}

function toggleHintsPanel() {
  if (!els.hintsPanel) return;
  if (els.hintsPanel.hidden) openHintsPanel(); else closeHintsPanel();
}

function buildHintsPanel() {
  var panel = els.hintsPanel;
  if (!panel) return;
  panel.innerHTML = '';
  var game = state.game;
  var hints = state.desk && state.desk.hints;
  var phase = game ? game.phase : null;
  var isOver = phase === 'won' || phase === 'lost';

  // H1 — Label Images
  var solvedGroupIds = game ? new Set(game.solved.map(function (s) { return s.groupId; })) : new Set();
  var imagePieces = game ? game.puzzle.items.filter(function (item) {
    return (item.zone === 'photo' || item.zone === 'rack' || item.zone === 'tubes')
      && item.info && item.info.title;
  }) : [];
  var h1Used = hints && hints.labels;
  var h1Disabled = !imagePieces.length;
  var h1Reason = h1Disabled ? 'No unidentified images in this puzzle.' : (h1Used ? 'Used' : '');
  addHintRow(panel, 'Label Images', 'Reveals the name of every image piece.', h1Used, h1Disabled && !h1Used, h1Reason, function () {
    closeHintsPanel();
    applyH1LabelImages();
  });

  // H2 — Seed the Trays
  var unsolvedCount = game ? game.puzzle.groups.length - game.solved.length : 0;
  var h2Used = hints && hints.seeds;
  var h2DisabledReason = unsolvedCount <= 1 ? 'Only one group left — every remaining piece belongs to it.' : '';
  addHintRow(panel, 'Seed the Trays', 'Places one piece from each unsolved group into its tray and pins it. Tap a seeded slide or film to view it.', h2Used, !!h2DisabledReason && !h2Used, h2DisabledReason || (h2Used ? 'Used' : ''), function () {
    closeHintsPanel();
    applyH2SeedTrays();
  });

  // H3 — Reveal a Category
  var h3Used = hints && hints.category;
  addHintRow(panel, 'Reveal a Category', 'Shows the name of the lowest-tier unsolved group.', h3Used, false, h3Used ? 'Used' : '', function () {
    closeHintsPanel();
    applyH3RevealCategory();
  });
}

function addHintRow(panel, name, desc, used, disabled, reason, onClick) {
  var row = document.createElement('div');
  row.className = 'hint-row' + (used ? ' hint-row-used' : '');
  row.setAttribute('role', 'menuitem');

  var info = document.createElement('div');
  info.className = 'hint-row-info';

  var nameEl = document.createElement('span');
  nameEl.className = 'hint-row-name';
  nameEl.textContent = name;
  info.appendChild(nameEl);

  var descEl = document.createElement('span');
  descEl.className = 'hint-row-desc';
  descEl.textContent = desc;
  info.appendChild(descEl);

  if (reason) {
    var reasonEl = document.createElement('span');
    reasonEl.className = 'hint-row-reason';
    reasonEl.textContent = reason;
    info.appendChild(reasonEl);
  }

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn hint-row-btn';
  btn.textContent = used ? 'Used' : 'Use';
  btn.disabled = used || disabled;
  btn.setAttribute('aria-disabled', String(used || disabled));
  if (!used && !disabled) btn.addEventListener('click', onClick);

  row.appendChild(info);
  row.appendChild(btn);
  panel.appendChild(row);
}

/* ── H1: Label Images ─────────────────────────────────────────────── */

function applyH1LabelImages() {
  var game = state.game;
  var desk = state.desk;
  if (!game || !desk) return;
  if (desk.hints.labels) { toast('Labels already applied.'); return; }
  var imagePieces = game.puzzle.items.filter(function (item) {
    return (item.zone === 'photo' || item.zone === 'rack' || item.zone === 'tubes')
      && item.info && item.info.title;
  });
  if (!imagePieces.length) {
    toast('No unidentified images in this puzzle.');
    return;
  }
  desk.hints.labels = true;
  announce('Image labels revealed.');
  syncAll();
  persistGame();
}

/* ── H2: Seed the Trays ───────────────────────────────────────────── */

function applyH2SeedTrays() {
  var game = state.game;
  var desk = state.desk;
  if (!game || !desk) return;
  if (desk.hints.seeds) { toast('Trays already seeded.'); return; }
  if (state.drag) return; // in-progress drag — ignore silently

  var solvedBoxes = new Set(game.solved.map(function (s) { return s.boxIndex; }));
  var unsolvedBoxes = [0, 1, 2, 3].filter(function (b) { return !solvedBoxes.has(b); });

  if (unsolvedBoxes.length <= 1) {
    toast('Only one group left — every remaining piece belongs to it.');
    return;
  }

  var solvedGroupIds = new Set(game.solved.map(function (s) { return s.groupId; }));
  var unsolvedGroups = game.puzzle.groups
    .filter(function (g) { return !solvedGroupIds.has(g.id); })
    .slice().sort(function (a, b) { return a.tier - b.tier; });

  // Pass 1: claim trays where a group's piece is already staged there.
  var claimedTray = {};   // groupId -> boxIndex
  var claimedBoxes = new Set();
  var pinnedPieces = {};  // itemId -> true (just mark; actual box from staging)

  unsolvedGroups.forEach(function (group) {
    for (var ii = 0; ii < group.itemIds.length; ii++) {
      var itemId = group.itemIds[ii];
      var cell = game.cellOfItem(itemId);
      if (!cell) continue;
      if (solvedBoxes.has(cell.box)) continue;
      if (claimedBoxes.has(cell.box)) continue;
      claimedTray[group.id] = cell.box;
      claimedBoxes.add(cell.box);
      pinnedPieces[itemId] = cell.box;
      break;
    }
  });

  // Pass 2: assign remaining groups to remaining boxes in tier order.
  var remainingBoxes = unsolvedBoxes.filter(function (b) { return !claimedBoxes.has(b); });
  var remainingGroups = unsolvedGroups.filter(function (g) { return claimedTray[g.id] === undefined; });
  remainingGroups.forEach(function (group, i) {
    if (i < remainingBoxes.length) {
      claimedTray[group.id] = remainingBoxes[i];
      claimedBoxes.add(remainingBoxes[i]);
    }
  });

  // Build reverse map: boxIndex -> groupId
  var groupByBox = {};
  Object.keys(claimedTray).forEach(function (gid) { groupByBox[claimedTray[gid]] = gid; });

  // Pass 3: evict staged, unpinned pieces that are in the wrong tray.
  var evicted = 0;
  for (var b = 0; b < BOX_COUNT; b++) {
    if (!groupByBox[b]) continue;
    var targetGroupId = groupByBox[b];
    for (var s = 0; s < SLOT_COUNT; s++) {
      var occupantId = game.staging[b][s];
      if (!occupantId) continue;
      if (pinnedPieces[occupantId] !== undefined) continue; // already pinned by pass 1
      var occupantGroup = groupOfItem(game.puzzle, occupantId);
      if (occupantGroup && occupantGroup.id === targetGroupId) continue; // belongs here
      game.unstage(occupantId);
      settleOnDesk(occupantId, null, null, null);
      evicted++;
    }
  }
  if (evicted > 0) {
    toast(evicted + ' piece' + (evicted === 1 ? '' : 's') + ' returned to the desk.');
  }

  // Pass 4: for groups lacking a pin, pick a random desk piece and stage + pin it.
  unsolvedGroups.forEach(function (group) {
    var trayBox = claimedTray[group.id];
    if (trayBox === undefined) return;
    var hasPinned = group.itemIds.some(function (iid) { return pinnedPieces[iid] !== undefined; });
    if (hasPinned) return;
    var deskPieces = group.itemIds.filter(function (iid) { return pieceLocation(iid).kind === 'desk'; });
    if (!deskPieces.length) return;
    var pick = deskPieces[Math.floor(Math.random() * deskPieces.length)];
    var slot = game.firstEmptySlot(trayBox);
    if (slot < 0) return;
    var result = game.stageToSlot(pick, trayBox, slot);
    if (result === 'staged' || result === 'moved') {
      pinnedPieces[pick] = trayBox;
    }
  });

  // Apply pins to desk.hints.pinned.
  Object.keys(pinnedPieces).forEach(function (iid) {
    desk.hints.pinned[iid] = pinnedPieces[iid];
  });

  desk.hints.seeds = true;
  announce('Trays seeded with one piece from each group.');
  syncAll();
  persistGame();
}

/* ── H3: Reveal a Category ────────────────────────────────────────── */

function applyH3RevealCategory() {
  var game = state.game;
  var desk = state.desk;
  if (!game || !desk) return;
  if (desk.hints.category) { toast('Category already revealed.'); return; }

  var solvedGroupIds = new Set(game.solved.map(function (s) { return s.groupId; }));
  var unsolvedGroups = game.puzzle.groups
    .filter(function (g) { return !solvedGroupIds.has(g.id); })
    .slice().sort(function (a, b) { return a.tier - b.tier; });

  if (!unsolvedGroups.length) {
    toast('All groups are solved.');
    return;
  }

  var lowest = unsolvedGroups[0];
  desk.hints.category = true;
  desk.hints.revealedGroupId = lowest.id;
  announce('One group is: ' + lowest.name);
  syncRevealNote();
  persistGame();
}

function syncRevealNote() {
  var note = els.revealNote;
  if (!note) return;
  var desk = state.desk;
  if (!desk || !desk.hints || !desk.hints.revealedGroupId) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  var game = state.game;
  if (!game) { note.hidden = true; return; }
  var group = game.puzzle.groups.find(function (g) { return g.id === desk.hints.revealedGroupId; });
  if (!group) { note.hidden = true; return; }
  var solved = game.solved.some(function (s) { return s.groupId === group.id; });
  note.hidden = false;
  note.className = 'reveal-note' + (solved ? ' reveal-note-solved' : '');
  note.innerHTML = '';
  var label = document.createElement('span');
  label.className = 'reveal-note-label';
  label.textContent = 'One group is:';
  var name = document.createElement('strong');
  name.textContent = group.name;
  note.appendChild(label);
  note.appendChild(document.createTextNode(' '));
  note.appendChild(name);
  if (solved) {
    var check = document.createElement('span');
    check.className = 'reveal-note-check';
    check.textContent = ' ✓';
    check.setAttribute('aria-label', 'solved');
    note.appendChild(check);
  }
}

/* ── Dragging (Pointer Events, handlers bound ONCE in init) ─────── */

function forceEndStaleDrag() {
  var d = state.drag;
  if (!d) return;
  if (d.hotEl) d.hotEl.classList.remove('drop-hot');
  d.el.classList.remove('is-dragging');
  state.drag = null;
  if (d.isFilm) settleOnWall(d.id, null, d.wallRect);
  else settleOnDesk(d.id, null, null, null);
  syncAll();
  persistGame();
}

function onPointerDown(ev) {
  // Dev layout mode: machines are draggable instead of pieces.
  if (state.layoutMode && layoutPointerDown(ev)) return;

  if (!state.game || state.game.phase !== 'playing') return;
  var pieceEl = ev.target.closest ? ev.target.closest('.piece') : null;
  if (!pieceEl) return;

  // A stale drag session (missed pointerup) must never wedge the game.
  if (state.drag) forceEndStaleDrag();

  var id = pieceEl.dataset.itemId;
  var loc = pieceLocation(id);
  if (loc.kind === 'tray' && loc.locked) return;

  // Block dragging pinned pieces (H2 hint). Slides and films open a peek viewer instead.
  if (state.desk && state.desk.hints && state.desk.hints.pinned && state.desk.hints.pinned[id] !== undefined) {
    var pinnedItem = itemById(id);
    if (pinnedItem.zone === 'rack' || pinnedItem.zone === 'tubes') {
      ev.preventDefault();
      openPinnedPeek(id, pinnedItem);
    } else {
      toast('That piece is pinned by a hint.');
    }
    return;
  }

  ev.preventDefault();
  pieceEl.focus({ preventScroll: true });
  try { pieceEl.setPointerCapture(ev.pointerId); } catch (e) { /* stale pointer id — document handlers still track */ }

  var playRect = els.playArea.getBoundingClientRect();
  var r = pieceEl.getBoundingClientRect();
  var cx = r.left - playRect.left + r.width / 2;
  var cy = r.top - playRect.top + r.height / 2;
  var px = ev.clientX - playRect.left;
  var py = ev.clientY - playRect.top;

  var item = itemById(id);
  var wasStaged = loc.kind === 'tray';
  var wasDocked = loc.kind === 'scope';
  var wasWall = loc.kind === 'wall';
  var wallRect = rectRel(els.xrayRail);
  state.desk.z[id] = ++state.desk.zTop;

  state.drag = {
    id: id,
    el: pieceEl,
    pointerId: ev.pointerId,
    offX: px - cx,
    offY: py - cy,
    playRect: playRect,
    wasStaged: wasStaged,
    wasDocked: wasDocked,
    wasWall: wasWall,
    isFilm: item.zone === 'tubes',
    wallRect: wallRect,
    wallY: wallRect.top + r.height / 2,
    filmHalfW: r.width / 2,
    rects: {
      desk: rectRel(els.deskSurface),
      stage: hasMachine('scope') ? rectRel(els.scopeStage) : NEVER_RECT,
      printer: NEVER_RECT,
      trays: trayEls.map(function (t) { return rectRel(t); }),
      slots: slotEls.map(function (row) { return row.map(function (s) { return rectRel(s); }); }),
    },
    hotEl: null,
  };

  pieceEl.classList.add('is-dragging');
  pieceEl.style.setProperty('--rot', '0deg');
  pieceEl.style.zIndex = String(10 + state.desk.z[id]);
  pieceEl.style.left = cx + 'px';
  pieceEl.style.top = cy + 'px';

  // Pickup side effects AFTER the drag session exists, so the engine's
  // change → syncAll pass skips this piece instead of repositioning it.
  if (wasStaged) state.game.unstage(id);
  if (wasDocked) { state.desk.scope = null; renderScopeView(); }

}

function dragPoint(ev) {
  var d = state.drag;
  return {
    x: ev.clientX - d.playRect.left - d.offX,
    y: ev.clientY - d.playRect.top - d.offY,
  };
}

function onPointerMove(ev) {
  if (state.layoutDrag) { layoutPointerMove(ev); return; }
  var d = state.drag;
  if (!d || ev.pointerId !== d.pointerId) return;
  ev.preventDefault();
  var p = dragPoint(ev);
  if (d.isFilm) {
    var overTray = d.rects.trays.some(function (tray) { return pointIn(tray, p.x, p.y); });
    if (!overTray) {
      p.y = d.wallY;
      p.x = clamp(p.x, d.wallRect.left + d.filmHalfW, d.wallRect.right - d.filmHalfW);
    }
  }
  d.el.style.left = p.x + 'px';
  d.el.style.top = p.y + 'px';
  updateDropHot(p.x, p.y);
  if (d.isFilm) updateFilmLighting(); // light-through follows the drag live
}

function updateDropHot(x, y) {
  var d = state.drag;
  var c = classifyDrop(classifyInput(d, x, y));
  var hot = null;
  if (c.kind === 'slot' || c.kind === 'tray-full') hot = trayEls[c.box];
  else if (c.kind === 'scope') hot = els.scopeStage;
  if (d.hotEl && d.hotEl !== hot) d.hotEl.classList.remove('drop-hot');
  if (hot && d.hotEl !== hot) hot.classList.add('drop-hot');
  d.hotEl = hot;
}

function onPointerUp(ev) {
  if (state.layoutDrag) { state.layoutDrag = null; return; }
  var d = state.drag;
  if (!d || ev.pointerId !== d.pointerId) return;
  var p = dragPoint(ev);
  if (d.hotEl) d.hotEl.classList.remove('drop-hot');
  d.el.classList.remove('is-dragging');
  state.drag = null;
  applyDrop(d, p.x, p.y);
  syncAll();
  persistGame();
}

function onPointerCancel(ev) {
  if (state.layoutDrag) { state.layoutDrag = null; return; }
  var d = state.drag;
  if (!d || ev.pointerId !== d.pointerId) return;
  if (d.hotEl) d.hotEl.classList.remove('drop-hot');
  d.el.classList.remove('is-dragging');
  state.drag = null;
  if (d.isFilm) settleOnWall(d.id, null, d.wallRect);
  else settleOnDesk(d.id, null, null, d.rects.desk);
  syncAll();
  persistGame();
}

/**
 * PURE drop classifier — no DOM, no globals. Given the drop point, the
 * cached target rects, and current occupancy, decide what a drop means.
 * returns: {kind:'slot',box,slot} | {kind:'tray-locked'|'tray-full',box}
 *   | {kind:'scope'|'scope-wrong'|'scope-occupied'}
 *   | {kind:'printer'} | {kind:'desk'}
 */
function classifyDrop(input) {
  for (var b = 0; b < input.rects.trays.length; b++) {
    if (!pointIn(input.rects.trays[b], input.x, input.y)) continue;
    if (input.lockedBoxes[b]) return { kind: 'tray-locked', box: b };
    var slot = -1;
    for (var s = 0; s < input.rects.slots[b].length; s++) {
      if (pointIn(input.rects.slots[b][s], input.x, input.y) && input.staging[b][s] === null) {
        slot = s;
        break;
      }
    }
    if (slot < 0) slot = input.staging[b].indexOf(null);
    if (slot < 0) return { kind: 'tray-full', box: b };
    return { kind: 'slot', box: b, slot: slot };
  }
  if (pointIn(input.rects.stage, input.x, input.y)) {
    if (input.zone !== 'rack') return { kind: 'scope-wrong' };
    if (input.scope && input.scope !== input.itemId) return { kind: 'scope-occupied' };
    return { kind: 'scope' };
  }
  if (pointIn(input.rects.printer, input.x, input.y)) {
    return { kind: 'printer' };
  }
  return { kind: 'desk' };
}

/** Assemble classifyDrop's input from the live drag session + game state. */
function classifyInput(d, x, y) {
  var game = state.game;
  return {
    x: x,
    y: y,
    rects: d.rects,
    zone: itemById(d.id).zone,
    itemId: d.id,
    lockedBoxes: [0, 1, 2, 3].map(function (b) { return game.isBoxLocked(b); }),
    staging: game.staging,
    scope: state.desk.scope,
  };
}

/** Apply a classified drop's side effects (engine, machines, sounds, aria). */
function applyDrop(d, x, y) {
  var game = state.game;
  var id = d.id;
  var item = itemById(id);
  var c = classifyDrop(classifyInput(d, x, y));

  switch (c.kind) {
    case 'slot': {
      var result = game.stageToSlot(id, c.box, c.slot);
      if (result === 'staged' || result === 'moved') {
        pieceSound(item.zone, 'drop');
        announce(item.label + ' placed in ' + TRAY_NAMES[c.box] + ', slot ' + (c.slot + 1) + '.');
      } else {
        settleOnDesk(id, x, y, d.rects.desk);
      }
      return;
    }
    case 'tray-locked':
      toast('That tray is locked.');
      break;
    case 'tray-full':
      toast('Tray ' + String.fromCharCode(65 + c.box) + ' is full.');
      break;
    case 'scope':
      state.desk.scope = id;
      playSound('dock-glass');
      announce('On the microscope: ' + revealText(item));
      return;
    case 'scope-wrong':
      toast('Only slides go on the microscope stage.');
      break;
    case 'scope-occupied':
      toast('The stage already holds a slide.');
      break;
    case 'printer':
      toast("The printer's out of ink — try the Hints menu.");
      break;
    case 'desk':
      if (item.zone === 'tubes') settleOnWall(id, x, d.wallRect);
      else settleOnDesk(id, x, y, d.rects.desk);
      pieceSound(item.zone, 'drop');
      if (d.wasStaged || d.wasDocked) {
        announce(item.zone === 'tubes' ? item.label + ' returned to the X-ray rail.' : item.label + ' returned to the desk.');
      }
      return;
  }

  // Rejected drops (locked/full/wrong/occupied) settle back onto the desk.
  settleOnDesk(id, x, y, d.rects.desk);
}

/** Park a piece on the desk. Pass x/y = null to keep its stored spot. */
function settleOnDesk(id, x, y, deskRect) {
  if (itemById(id).zone === 'tubes') {
    settleOnWall(id, x, rectRel(els.xrayRail));
    return;
  }
  if (x !== null && y !== null && deskRect) {
    var fx = clamp((x - deskRect.left) / deskRect.width, 0.04, 0.96);
    var fy = clamp((y - deskRect.top) / deskRect.height, 0.06, 0.94);
    state.desk.pos[id] = { fx: fx, fy: fy };
  }
  var item = itemById(id);
  state.desk.rot[id] = item.zone === 'tubes' ? 0 : -7 + Math.random() * 14;
}

function settleOnWall(id, x, wallRect) {
  var rect = wallRect || rectRel(els.xrayRail);
  var p = state.desk.pos[id] || { fx: 0.2, fy: 0.5 };
  var nextX = x === null || x === undefined ? rect.left + p.fx * rect.width : x;
  state.desk.pos[id] = {
    fx: clamp((nextX - rect.left) / rect.width, 0.08, 0.92),
    fy: 0.5,
  };
  state.desk.rot[id] = 0;
}

/* ── Keyboard controls (bound ONCE on document) ─────────────────── */

function onKeyDown(ev) {
  if (ev.key === 'Escape' && !els.overlayHelp.hidden) {
    closeClueGuide();
    return;
  }
  if (ev.key === 'Escape' && els.settingsPanel && !els.settingsPanel.hidden) {
    closeSettingsPanel();
    if (els.btnSettings) els.btnSettings.focus();
    return;
  }
  // Peek overlay Esc close.
  if (ev.key === 'Escape' && peekOverlay && !peekOverlay.hidden) {
    closePinnedPeek();
    return;
  }
  // Hints panel Esc close.
  if (ev.key === 'Escape' && els.hintsPanel && !els.hintsPanel.hidden) {
    closeHintsPanel();
    if (els.btnHints) els.btnHints.focus();
    return;
  }
  if (!state.game || state.game.phase !== 'playing') return;
  if (!els.overlayHelp.hidden || !els.overlayResults.hidden || (els.settingsPanel && !els.settingsPanel.hidden) || (peekOverlay && !peekOverlay.hidden)) return;
  // Hints panel L key: toggle from anywhere during play (before piece-focus check).
  if (ev.key === 'l' || ev.key === 'L') {
    ev.preventDefault();
    toggleHintsPanel();
    return;
  }

  var active = document.activeElement;
  if (!active || !active.classList || !active.classList.contains('piece')) return;
  var id = active.dataset.itemId;
  var item = itemById(id);
  var loc = pieceLocation(id);
  if (loc.kind === 'tray' && loc.locked) return;

  // Block piece-action keys for pinned pieces (H2 hint) — mirrors the pointer guard.
  // Slides and films allow V (and Enter/Space as synonym) to open the peek viewer.
  if (state.desk && state.desk.hints && state.desk.hints.pinned && state.desk.hints.pinned[id] !== undefined) {
    if ((item.zone === 'rack' || item.zone === 'tubes') &&
        (ev.key === 'v' || ev.key === 'V' || ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      openPinnedPeek(id, item);
    } else {
      toast('That piece is pinned by a hint.');
    }
    return;
  }

  if (ev.key.length === 1 && ev.key >= '1' && ev.key <= '4') {
    ev.preventDefault();
    sendToTray(id, Number(ev.key) - 1);
  } else if (ev.key === '0' || ev.key === 'Backspace') {
    ev.preventDefault();
    returnToDesk(id);
  } else if (ev.key === 'v' || ev.key === 'V') {
    ev.preventDefault();
    viewOnMachine(id, item);
  } else if (ev.key.indexOf('Arrow') === 0) {
    ev.preventDefault();
    var p = state.desk.pos[id];
    if (loc.kind === 'wall') {
      if (ev.key === 'ArrowLeft') p.fx = clamp(p.fx - 0.025, 0.08, 0.92);
      if (ev.key === 'ArrowRight') p.fx = clamp(p.fx + 0.025, 0.08, 0.92);
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') return;
    } else if (loc.kind === 'desk') {
      if (ev.key === 'ArrowLeft') p.fx = clamp(p.fx - 0.025, 0.04, 0.96);
      if (ev.key === 'ArrowRight') p.fx = clamp(p.fx + 0.025, 0.04, 0.96);
      if (ev.key === 'ArrowUp') p.fy = clamp(p.fy - 0.035, 0.06, 0.94);
      if (ev.key === 'ArrowDown') p.fy = clamp(p.fy + 0.035, 0.06, 0.94);
    } else {
      return;
    }
    syncPieces();
    persistGame();
  }
}

function sendToTray(id, b) {
  var game = state.game;
  var item = itemById(id);
  if (game.isBoxLocked(b)) {
    announce(TRAY_NAMES[b] + ' is locked.');
    toast('That tray is locked.');
    return;
  }
  var slot = game.firstEmptySlot(b);
  if (slot < 0) {
    announce(TRAY_NAMES[b] + ' is full.');
    toast('Tray ' + String.fromCharCode(65 + b) + ' is full.');
    return;
  }
  if (state.desk.scope === id) { state.desk.scope = null; renderScopeView(); }
  var result = game.stageToSlot(id, b, slot);
  if (result === 'staged' || result === 'moved') {
    pieceSound(item.zone, 'drop');
    announce(item.label + ' placed in ' + TRAY_NAMES[b] + ', slot ' + (slot + 1) + '.');
    state.pieceEls[id].focus({ preventScroll: true });
  }
  syncAll();
  persistGame();
}

function returnToDesk(id) {
  var game = state.game;
  var item = itemById(id);
  var loc = pieceLocation(id);
  if (loc.kind === 'tray') {
    game.unstage(id); // change event syncs + persists
  } else if (loc.kind === 'scope') {
    state.desk.scope = null;
    renderScopeView();
  } else if (loc.kind === 'wall') {
    settleOnWall(id, null, rectRel(els.xrayRail));
    announce(item.label + ' is on the X-ray rail.');
    state.pieceEls[id].focus({ preventScroll: true });
    syncAll();
    persistGame();
    return;
  } else {
    return;
  }
  pieceSound(item.zone, 'drop');
  announce(item.label + ' returned to the desk.');
  state.pieceEls[id].focus({ preventScroll: true });
  syncAll();
  persistGame();
}

function viewOnMachine(id, item) {
  if (item.zone === 'rack' && !hasMachine('scope')) { announce('This puzzle has no microscope.'); return; }
  if (item.zone === 'tubes' && !hasMachine('lightbox')) { announce('This puzzle has no light box.'); return; }
  if (item.zone === 'rack') {
    if (state.game.isStaged(id)) state.game.unstage(id);
    state.desk.scope = id; // replaces any current slide (it returns to its desk spot)
    playSound('dock-glass');
    announce('On the microscope: ' + revealText(item));
  } else if (item.zone === 'tubes') {
    // Films stay on the wall rail; V slides the film to the lightbox center.
    if (state.game.isStaged(id)) state.game.unstage(id);
    var lr = rectRel(els.lightboxScreen);
    var wr = rectRel(els.xrayRail);
    state.desk.pos[id] = { fx: clamp((lr.cx - wr.left) / wr.width, 0.08, 0.92), fy: 0.5 };
    state.desk.rot[id] = 0;
    state.desk.z[id] = ++state.desk.zTop;
    playSound('film-rustle');
    announce('On the light box: ' + revealText(item));
  } else {
    announce(item.label + ' reads directly — no machine needed.');
    return;
  }
  state.pieceEls[id].focus({ preventScroll: true });
  syncAll();
  persistGame();
}

/* ════════════════════════════════════════════════════════════════════
 * PEEK OVERLAY — read-only viewer for hint-pinned slides and films.
 * The piece stays in its tray; no engine state is touched.
 * ════════════════════════════════════════════════════════════════════ */

/** Build (once) and show the peek overlay for a pinned rack or tubes piece. */
function openPinnedPeek(id, item) {
  // Lazily create the overlay DOM the first time.
  if (!peekOverlay) {
    var ov = document.createElement('div');
    ov.className = 'overlay overlay-peek';
    ov.id = 'overlay-peek';
    ov.hidden = true;

    var card = document.createElement('div');
    card.className = 'overlay-card peek-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'peek-caption');
    card.setAttribute('tabindex', '-1');

    var viewerWrap = document.createElement('div');
    viewerWrap.className = 'peek-viewer-wrap';
    viewerWrap.id = 'peek-viewer-wrap';
    card.appendChild(viewerWrap);

    var caption = document.createElement('p');
    caption.className = 'peek-caption';
    caption.id = 'peek-caption';
    card.appendChild(caption);

    var actions = document.createElement('div');
    actions.className = 'overlay-actions';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closePinnedPeek);
    actions.appendChild(closeBtn);
    card.appendChild(actions);

    ov.appendChild(card);
    document.body.appendChild(ov);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closePinnedPeek(); });
    peekOverlay = ov;
  }

  var wrap = document.getElementById('peek-viewer-wrap');
  var captionEl = document.getElementById('peek-caption');
  wrap.innerHTML = '';

  // Build caption from label + optional info.title.
  var captionParts = [item.label];
  if (item.info && item.info.title && item.info.title !== item.label) captionParts.push(item.info.title);
  captionEl.textContent = captionParts.join(' — ');

  if (item.zone === 'rack') {
    // Scope-style viewer — same canvas rendering as renderScopeView().
    var scopeWrap = document.createElement('div');
    scopeWrap.className = 'peek-scope-wrap';
    var peekCanvas = document.createElement('canvas');
    peekCanvas.className = 'peek-canvas';
    peekCanvas.setAttribute('aria-label', 'Microscope view');
    scopeWrap.appendChild(peekCanvas);
    wrap.appendChild(scopeWrap);
    peekOverlay.hidden = false;
    // Defer rendering until the wrap has layout dimensions.
    requestAnimationFrame(function () { renderPeekScopeCanvas(item, peekCanvas, scopeWrap); });
  } else {
    // Film lightbox viewer — same lit layer as in buildPieces() for tubes.
    var filmWrap = document.createElement('div');
    filmWrap.className = 'peek-film-wrap';
    var litDiv = document.createElement('div');
    litDiv.className = 'peek-film-lit';
    if (item.info && item.info.image) {
      litDiv.classList.add('has-image');
      litDiv.style.backgroundImage = 'url("' + item.info.image + '")';
    } else {
      var litLbl = document.createElement('span');
      litLbl.className = 'film-lit-label';
      litLbl.textContent = item.label;
      litDiv.appendChild(litLbl);
    }
    filmWrap.appendChild(litDiv);
    wrap.appendChild(filmWrap);
    peekOverlay.hidden = false;
  }

  // Remember which piece gets focus back on close.
  peekOverlay.dataset.returnFocusId = id;
  var card2 = peekOverlay.querySelector('.peek-card');
  if (card2) setTimeout(function () { card2.focus(); }, 40);
}

/** Draw the scope view for the peek overlay, retrying until the source is ready. */
function renderPeekScopeCanvas(item, canvas, scopeWrap) {
  if (!peekOverlay || peekOverlay.hidden) return; // overlay closed before render
  var cw = scopeWrap.clientWidth;
  var ch = scopeWrap.clientHeight;
  if (cw < 10 || ch < 10) {
    // Layout not settled yet — retry.
    setTimeout(function () { renderPeekScopeCanvas(item, canvas, scopeWrap); }, 40);
    return;
  }
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Idle bed background (matches renderScopeView).
  var bed = ctx.createRadialGradient(cw / 2, ch / 2, 10, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
  bed.addColorStop(0, '#f4ecdc');
  bed.addColorStop(1, '#d9cdb4');
  ctx.fillStyle = bed;
  ctx.fillRect(0, 0, cw, ch);

  var src = scopeSource(item);
  if (!src) {
    // Image still loading — draw a shimmer ring and poll.
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(122, 79, 192, 0.35)';
    ctx.lineWidth = 4;
    ctx.stroke();
    setTimeout(function () { renderPeekScopeCanvas(item, canvas, scopeWrap); }, 150);
    return;
  }

  var sw = src.width, sh = src.height;
  var cover = Math.max(cw / sw, ch / sh);
  var vw = cw / cover, vh = ch / cover;
  var sx = (sw - vw) / 2, sy = (sh - vh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, sx, sy, vw, vh, 0, 0, cw, ch);

  // Soft vignette — matches renderScopeView.
  var vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.42, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
  vg.addColorStop(0, 'rgba(40, 30, 16, 0)');
  vg.addColorStop(1, 'rgba(40, 30, 16, 0.35)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, cw, ch);
}

/** Close the peek overlay and restore focus to the source piece. */
function closePinnedPeek() {
  if (!peekOverlay) return;
  peekOverlay.hidden = true;
  var returnId = peekOverlay.dataset.returnFocusId;
  if (returnId && state.pieceEls && state.pieceEls[returnId]) {
    state.pieceEls[returnId].focus({ preventScroll: true });
  }
}

/** Spoken description of what a machine reveals for an item (aria only —
    the displays themselves stay text-free). */
function revealText(item) {
  var parts = [item.label];
  var info = item.info || {};
  if (info.title && info.title !== item.label) parts.push(info.title);
  if (info.text) parts.push(info.text);
  if (item.analyzer && item.analyzer.lines && item.analyzer.lines.length) {
    parts.push(item.analyzer.lines.join(', '));
  }
  return parts.join('. ');
}

/* ── Lock In (delegated click on #trays, bound ONCE) ────────────── */

function onTraysClick(ev) {
  var lockBtn = ev.target.closest ? ev.target.closest('[data-lock]') : null;
  if (!lockBtn || !state.game) return;
  var b = Number(lockBtn.dataset.lock);
  var game = state.game;
  var result = game.submitBox(b);
  if (result.kind === 'incomplete') return;

  if (result.kind === 'correct') {
    playSound('correct');
    announce('Correct! "' + result.group.name + '" locked in.');
  } else {
    playSound('wrong');
    playSound('wrong-crack');
    var gbox = document.getElementById('guesses-box');
    if (gbox) {
      gbox.classList.remove('wrong-feedback');
      void gbox.offsetWidth;
      gbox.classList.add('wrong-feedback');
      var lastPip = gbox.querySelectorAll('.pip.used');
      lastPip = lastPip[lastPip.length - 1];
      if (lastPip) lastPip.classList.add('just-broke');
      setTimeout(function () {
        gbox.classList.remove('wrong-feedback');
        if (lastPip) lastPip.classList.remove('just-broke');
      }, 700);
    }
    slotEls[b].forEach(function (slotEl) {
      slotEl.classList.remove('wrong-shake');
      void slotEl.offsetWidth;
      slotEl.classList.add('wrong-shake');
    });
    var msg = state.settings.casual
      ? 'Not quite. Mistake ' + game.mistakes + '.'
      : 'Not quite. ' + Math.max(game.mistakesLeft, 0) + ' mistake' + (game.mistakesLeft === 1 ? '' : 's') + ' left.';
    if (result.oneAway) {
      msg += ' One away!';
      playSound('one-away');
      toast('One away!');
    }
    announce(msg);
  }
}

/* ── Scatter (re-spread the desk pieces; internal name stays "shuffle") ── */

function onShuffle() {
  var game = state.game;
  if (!game || game.phase !== 'playing') return;
  game.puzzle.items.forEach(function (item) {
    var loc = pieceLocation(item.id);
    if (loc.kind !== 'desk') return;
    state.desk.pos[item.id] = scatterSpot(Math.random);
    state.desk.rot[item.id] = item.zone === 'tubes' ? 0 : -15 + 30 * Math.random();
  });
  playSound('shuffle');
  syncPieces();
  persistGame();
  announce('Desk pieces shuffled.');
}

/* ── Restricted-HTML sanitizer (rich text in article heading/text) ──────
 * Article `text`/`heading` blocks may now carry a tiny allowlisted set of
 * inline formatting tags — b/strong, i/em, u, br, sub, sup — authored via
 * the editor's contenteditable + B/I/U toolbar. Everything else (a, img,
 * script, style, on* attributes, EVERY attribute in fact) is stripped.
 * Disallowed tags are unwrapped to their text/children, never dropped
 * silently and never kept as-is, so e.g. `<a href=evil>click</a>` becomes
 * plain text "click" with no link.
 *
 * Parsing untrusted HTML with `el.innerHTML = html` on a live DOM node is
 * itself a footgun — a detached node still loads <img src> and can fire
 * inline on* handlers (e.g. onerror) the instant the markup is parsed,
 * before any walk-and-strip pass gets to run. A <template> element's
 * `.content` is a DocumentFragment that is explicitly inert per spec: no
 * script execution, no image/resource fetching, so parsing happens there
 * first and nothing in the source string ever gets a chance to run. */
var RICH_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, BR: 1, SUB: 1, SUP: 1 };

function sanitizeRichHtml(html) {
  if (!html) return '';
  var tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  var out = document.createElement('div');
  sanitizeChildrenInto(tpl.content, out);
  return out.innerHTML;
}

/** Walk srcNode's children into outParent: allowlisted tags are rebuilt
    fresh (never copied — so no attribute, however apparently harmless,
    ever survives), everything else is unwrapped to its own children. */
function sanitizeChildrenInto(srcNode, outParent) {
  srcNode.childNodes.forEach(function (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      outParent.appendChild(document.createTextNode(node.nodeValue));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return; // comments etc. — drop
    if (RICH_TAGS[node.tagName]) {
      var clean = document.createElement(node.tagName);
      sanitizeChildrenInto(node, clean);
      outParent.appendChild(clean);
    } else {
      sanitizeChildrenInto(node, outParent); // unwrap: keep text, drop tag
    }
  });
}

/* ── Results overlay + share ─────────────────────────────────────── */

/** heading/text/image -> a DOM node in web-article typography. Heading and
    text go through sanitizeRichHtml()+innerHTML — the sanitizer's allowlist
    is the only injection-safety boundary, so it runs here even though the
    editor already sanitizes on every keystroke (defense in depth against a
    hand-edited save or an imported puzzle file). Plain strings with no
    tags pass through unchanged, so old plain-text articles render exactly
    as before. Image src is always a stored data URI that becomes an
    <img src>, never innerHTML. */
function renderArticleBlock(block) {
  if (!block) return null;
  if (block.type === 'heading') {
    var h = document.createElement('h4');
    h.className = 'result-article-heading';
    h.innerHTML = sanitizeRichHtml(block.text || '');
    return h;
  }
  if (block.type === 'text') {
    var p = document.createElement('p');
    p.className = 'result-article-text';
    p.innerHTML = sanitizeRichHtml(block.text || '');
    return p;
  }
  if (block.type === 'image' && block.src) {
    var fig = document.createElement('figure');
    fig.className = 'result-article-figure';
    var img = document.createElement('img');
    img.src = block.src;
    img.alt = block.caption || '';
    fig.appendChild(img);
    if (block.caption) {
      var cap = document.createElement('figcaption');
      cap.className = 'result-article-caption';
      cap.textContent = block.caption;
      fig.appendChild(cap);
    }
    return fig;
  }
  return null;
}

/** One tier-colored placard: name, tier, items, lede (`explanation`), and
    — if the group has one — its full article body underneath. Groups
    without an article render exactly as before (placard + explanation). */
function buildResultPlacard(puzzle, g, solvedGroupIds) {
  var card = document.createElement('div');
  card.className = 'result-placard' + (solvedGroupIds.has(g.id) ? ' solved-by-player' : '');
  card.style.setProperty('--group-color', 'var(--tier-' + g.tier + ')');
  var nameEl = document.createElement('p');
  nameEl.className = 'result-placard-name';
  nameEl.textContent = 'Tier ' + g.tier;
  var h3 = document.createElement('h3');
  h3.textContent = g.name;
  var itemsEl = document.createElement('p');
  itemsEl.className = 'result-placard-items';
  itemsEl.textContent = g.itemIds.map(function (id) {
    var item = puzzle.items.find(function (i) { return i.id === id; });
    return item ? item.label : id;
  }).join(' · ');
  var explEl = document.createElement('p');
  explEl.className = 'result-placard-explanation';
  explEl.textContent = g.explanation;
  card.appendChild(nameEl);
  card.appendChild(h3);
  card.appendChild(itemsEl);
  card.appendChild(explEl);

  if (Array.isArray(g.article) && g.article.length) {
    var article = document.createElement('div');
    article.className = 'result-article';
    g.article.forEach(function (block) {
      var node = renderArticleBlock(block);
      if (node) article.appendChild(node);
    });
    card.appendChild(article);
  }
  return card;
}

/** Renders the results overlay for any puzzle + solved-group set. Both the
    real end-of-game path (showResults) and the editor's "Preview results"
    button funnel through here, so what you author is exactly what plays. */
function showResultsForPuzzle(puzzle, opts) {
  opts = opts || {};
  els.resultsTitle.textContent = opts.title || 'Solved!';
  els.resultsSub.textContent = opts.sub || '';
  var hintsObj = opts.hints || {};
  var hintNames = [];
  if (hintsObj.labels) hintNames.push('Label Images');
  if (hintsObj.seeds) hintNames.push('Seed the Trays');
  if (hintsObj.category) hintNames.push('Reveal a Category');
  if (els.resultsHints) {
    els.resultsHints.textContent = hintNames.length
      ? 'Hints used: ' + hintNames.join(', ')
      : (opts.legacyHintsUsed ? 'Hints used: ' + opts.legacyHintsUsed : '');
    els.resultsHints.hidden = !hintNames.length && !opts.legacyHintsUsed;
  }

  els.resultsGroups.innerHTML = '';
  var solvedGroupIds = opts.solvedGroupIds || new Set();
  var ordered = puzzle.groups.slice().sort(function (a, b) { return a.tier - b.tier; });
  ordered.forEach(function (g) {
    els.resultsGroups.appendChild(buildResultPlacard(puzzle, g, solvedGroupIds));
  });

  els.shareFallback.hidden = true;
  if (els.btnCopyAnki) {
    var ankiResult = buildAnkiSearch(puzzle);
    els.btnCopyAnki.hidden = ankiResult.noteCount === 0;
  }
  showOverlay(els.overlayResults);
}

function showResults() {
  var game = state.game;
  var won = game.phase === 'won';
  var solvedGroupIds = new Set(game.solved.map(function (s) { return s.groupId; }));
  showResultsForPuzzle(game.puzzle, {
    title: won ? 'Solved!' : 'Out of mistakes',
    sub: won
      ? 'Solved with ' + game.mistakes + ' mistake' + (game.mistakes === 1 ? '' : 's') + '.'
      : 'Here is how the groups fit together.',
    hints: state.desk.hints || {},
    legacyHintsUsed: state.desk.hintsUsed,
    solvedGroupIds: solvedGroupIds,
  });
}

/** ?preview boot, in response to the editor's "Preview results" button:
    load the current draft and show its results overlay as if every group
    had just been solved — the exact game-end view, without playing. */
function showPreviewResultsFromDraft() {
  bootPreviewDraft();
  if (!state.game) return;
  var puzzle = state.game.puzzle;
  showResultsForPuzzle(puzzle, {
    title: 'Solved!',
    sub: 'Solved with 0 mistakes.',
    solvedGroupIds: new Set(puzzle.groups.map(function (g) { return g.id; })),
  });
}

function buildShareText() {
  var game = state.game;
  var puzzle = game.puzzle;
  var lines = [];
  lines.push('Starry Sky Society Puzzle');
  lines.push(puzzle.title + (puzzle.date ? ', ' + puzzle.date : ''));
  lines.push('Mistakes: ' + game.mistakes + (state.settings.casual ? ' (casual)' : '/' + MAX_MISTAKES));
  var hintEmojis = '';
  var hints = state.desk.hints || {};
  if (hints.labels) hintEmojis += '🏷️';
  if (hints.seeds) hintEmojis += '📌';
  if (hints.category) hintEmojis += '📝';
  // Fallback: old saves without hints block but with hintsUsed > 0.
  if (!hintEmojis && state.desk.hintsUsed > 0) hintEmojis = String(state.desk.hintsUsed);
  if (hintEmojis) lines.push('Hints: ' + hintEmojis);
  lines.push('');
  game.attempts.forEach(function (attempt) {
    var row = attempt.itemIds.map(function (id) {
      var group = groupOfItem(puzzle, id);
      return TIER_EMOJI[group.tier] || '⬜';
    }).join('');
    lines.push(row);
  });
  return lines.join('\n');
}

function onShare() {
  var text = buildShareText();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast('Copied to clipboard!');
    }, function () { showShareFallback(text); });
  } else {
    showShareFallback(text);
  }
}

function showShareFallback(text) {
  els.shareFallback.value = text;
  els.shareFallback.hidden = false;
  els.shareFallback.focus();
  els.shareFallback.select();
  toast('Select the text below to copy.');
}

function buildAnkiSearch(puzzle) {
  var groups = (puzzle && Array.isArray(puzzle.groups)) ? puzzle.groups : [];
  var seen = Object.create(null);
  var nids = [];
  var groupCount = 0;
  groups.forEach(function (g) {
    if (!g || !g.anki || !Array.isArray(g.anki.nids)) return;
    groupCount++;
    g.anki.nids.forEach(function (id) {
      if (typeof id === 'number' && Number.isInteger(id) && id > 0 && !seen[id]) {
        seen[id] = true;
        nids.push(id);
      }
    });
  });
  if (nids.length === 0) return { text: '', noteCount: 0, groupCount: 0 };
  return { text: 'nid:' + nids.join(','), noteCount: nids.length, groupCount: groupCount };
}

function onCopyAnki() {
  var puzzle = state.game && state.game.puzzle;
  var result = buildAnkiSearch(puzzle);
  var text = result.text;
  var noteCount = result.noteCount;
  var msg = 'Copied Anki search for ' + noteCount + ' notes - paste into Browse';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast(msg);
    }, function () { showShareFallback(text); });
  } else {
    showShareFallback(text);
  }
}

/* ── Menu / navigation actions ───────────────────────────────────── */

// Shared in-flight guard: prevents double-click races on playToday and
// onPuzzleSelectEntry. Both set this true before starting a load and clear
// it in .finally() so a second tap while a fetch is pending is a no-op.
var puzzleLoadInFlight = false;

function playToday() {
  if (puzzleLoadInFlight) return;
  puzzleLoadInFlight = true;
  els.btnPlayToday.disabled = true; // belt-and-suspenders for keyboard users
  loadRegistry().then(function (registry) {
    var entry = (registry.puzzles || []).find(function (p) { return p.id === registry.current; })
      || { id: registry.current, file: registry.current + '.json' };
    return loadPuzzleByEntry(entry);
  }).then(openPuzzle).catch(function (err) {
    showErrorScreen(err.message);
  }).finally(function () {
    puzzleLoadInFlight = false;
    els.btnPlayToday.disabled = false;
  });
}

/* ── Puzzle-select dropdown ──────────────────────────────────────── */

function openPuzzleSelect() {
  els.puzzleSelectPanel.hidden = false;
  els.btnPuzzleSelect.setAttribute('aria-expanded', 'true');
  var first = els.puzzleSelectList.querySelector('.puzzle-select-entry');
  if (first) first.focus();
}

function closePuzzleSelect() {
  els.puzzleSelectPanel.hidden = true;
  els.btnPuzzleSelect.setAttribute('aria-expanded', 'false');
}

function onPuzzleSelectEntry(ev) {
  var btn = ev.target.closest ? ev.target.closest('.puzzle-select-entry') : null;
  if (!btn) return;
  if (puzzleLoadInFlight) return; // ignore second tap while load is in flight
  puzzleLoadInFlight = true;
  closePuzzleSelect();
  var entry = { id: btn.dataset.puzzleId, file: btn.dataset.puzzleFile };
  loadPuzzleByEntry(entry).then(openPuzzle).catch(function (err) {
    showErrorScreen(err.message);
  }).finally(function () {
    puzzleLoadInFlight = false;
  });
}

function backToMenu() {
  closeHintsPanel();
  closeSettingsPanel();
  showScreen('screenMenu');
  refreshMenu();
}

function refreshMenu() {
  loadRegistry().then(renderMenu);
}

function onPlayAgain() {
  hideOverlay(els.overlayResults);
  var puzzle = state.game.puzzle;
  try { localStorage.removeItem(saveKey(puzzle.id)); } catch (e) { /* ignore */ }
  openPuzzle(JSON.parse(JSON.stringify(puzzle)));
}

/** Toolbar "Reset" — same reset-from-scratch as onPlayAgain (fresh copy
    of the puzzle, its save wiped so a reload can't resurrect the old
    desk), but reachable mid-game. A quick native confirm guards it —
    lightweight on purpose — whenever there's actual progress to lose. */
function onResetPuzzle() {
  var game = state.game;
  if (!game) return;
  if (game.phase === 'playing'
    && !window.confirm('Reset this puzzle? Staged pieces and mistakes will be cleared.')) {
    return;
  }
  var puzzle = game.puzzle;
  try { localStorage.removeItem(saveKey(puzzle.id)); } catch (e) { /* ignore */ }
  // Re-arm the viewport health tip so it may show once more after the reset.
  viewportTipShownThisLoad = false;
  dismissViewportTip();
  openPuzzle(JSON.parse(JSON.stringify(puzzle)));
}

/* ── Deep link (?puzzle=<id>) ────────────────────────────────────── */

function tryDeepLink() {
  var params = new URLSearchParams(window.location.search);
  var puzzleId = params.get('puzzle');
  if (!puzzleId) return false;

  loadRegistry().then(function (registry) {
    var entry = (registry.puzzles || []).find(function (p) { return p.id === puzzleId; });
    if (!entry) {
      if (puzzleId === CURRENT_PUZZLE.id) {
        openPuzzle(CURRENT_PUZZLE);
        return;
      }
      showErrorScreen('No puzzle found for id "' + puzzleId + '".');
      return;
    }
    return loadPuzzleByEntry(entry).then(openPuzzle);
  }).catch(function (err) { showErrorScreen(err.message); });
  return true;
}

/* ════════════════════════════════════════════════════════════════════
 * DEV — LAYOUT MODE (?layout). Drag machines on the desk; sliders for
 * everything else; persists to localStorage; exports layout JSON.
 * ════════════════════════════════════════════════════════════════════ */

/* Live sound overrides: a `sound` block persisted with the layout. */
var EDITABLE_CUES = ['pickup-paper', 'drop-paper', 'pickup-glass', 'drop-glass', 'dock-glass',
  'film-rustle', 'dial-tick', 'pan-tick', 'shuffle', 'correct', 'wrong', 'wrong-crack',
  'one-away', 'win', 'lose'];

/* Cue keys stay internal ids (also the manifest.json override names) —
   this only relabels the sound-editor row for the ones with a different
   user-facing name in the UI. */
var CUE_DISPLAY_NAMES = { shuffle: 'scatter' };

function applySoundLayer(sound) {
  if (!sound || typeof sound !== 'object') return;
  if (isFinite(sound.master)) {
    SOUND_TUNING.master = sound.master;
    if (audio.master) audio.master.gain.value = sound.master;
  }
  if (sound.cues) {
    EDITABLE_CUES.forEach(function (c) {
      if (isFinite(sound.cues[c]) && SOUND_TUNING[c]) SOUND_TUNING[c].gain = sound.cues[c];
    });
  }
  if (sound.scrape) {
    Object.keys(sound.scrape).forEach(function (k) {
      if (isFinite(sound.scrape[k]) && k in SOUND_TUNING.scrape) SOUND_TUNING.scrape[k] = sound.scrape[k];
    });
  }
  if (sound.matGains) {
    Object.keys(SOUND_TUNING.scrape.materials).forEach(function (m) {
      if (isFinite(sound.matGains[m])) SOUND_TUNING.scrape.materials[m].gain = sound.matGains[m];
    });
  }
}

function collectSoundLayer() {
  var cues = {};
  EDITABLE_CUES.forEach(function (c) { cues[c] = SOUND_TUNING[c].gain; });
  var sc = SOUND_TUNING.scrape;
  return {
    master: SOUND_TUNING.master,
    cues: cues,
    scrape: {
      vOn: sc.vOn, vOff: sc.vOff, grainPx: sc.grainPx, cooldownMs: sc.cooldownMs,
      gainLo: sc.gainLo, gainHi: sc.gainHi, vRef: sc.vRef,
      pitchLo: sc.pitchLo, pitchHi: sc.pitchHi, volJitterDb: sc.volJitterDb,
    },
    matGains: {
      paper: sc.materials.paper.gain,
      slide: sc.materials.slide.gain,
      film: sc.materials.film.gain,
    },
  };
}

function resetSoundLayer() {
  var d = JSON.parse(JSON.stringify(SOUND_DEFAULTS));
  SOUND_TUNING.master = d.master;
  EDITABLE_CUES.forEach(function (c) { SOUND_TUNING[c] = d[c]; });
  SOUND_TUNING.scrape = d.scrape;
  if (audio.master) audio.master.gain.value = d.master;
}

function layoutPointerDown(ev) {
  var machine = ev.target.closest ? ev.target.closest('.machine') : null;
  if (!machine || machine !== els.machineScope) return false;
  ev.preventDefault();
  var deskRect = els.deskSurface.getBoundingClientRect();
  state.layoutDrag = { el: machine, deskRect: deskRect };
  return true;
}

function layoutPointerMove(ev) {
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

var LAYOUT_UI_KEY = SAVE_PREFIX + 'layout-ui';

function devSectionState() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_UI_KEY) || '{}'); } catch (e) { return {}; }
}
function saveDevSectionState(title, open) {
  var m = devSectionState();
  m[title] = open;
  try { localStorage.setItem(LAYOUT_UI_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
}

/** A collapsible dev-panel section (chevron summary, persisted state). */
function devSection(parent, title, defaultOpen) {
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

function devSlider(parent, labelText, min, max, step, get, set) {
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

function buildLayoutPanel() {
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

var KIND_ORDER = ['corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx'];

function loadEditorDraft() {
  try {
    var raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    if (raw) return normalizeDraft(JSON.parse(raw));
  } catch (e) { /* fall through */ }
  return normalizeDraft(JSON.parse(JSON.stringify(CURRENT_PUZZLE)));
}

function saveEditorDraft() {
  try { localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(state.editorDraft)); } catch (e) { /* ignore */ }
}

/** Coerce any draft into the editor's shape: 4 groups × exactly 4 item
    ids, 16 items, machines list explicit. Old files load unchanged. */
function normalizeDraft(d) {
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
function draftIsPristine(d) {
  try {
    var fresh = normalizeDraft(JSON.parse(JSON.stringify(CURRENT_PUZZLE)));
    return JSON.stringify(fresh) === JSON.stringify(d);
  } catch (e) { return false; }
}

/** Validate + (optionally, after a confirm) load `candidate` into the
    editor draft. Returns true on success; leaves the current draft
    untouched and toasts a reason on any failure. */
function importCaseIntoEditor(candidate, sourceLabel) {
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
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

/** Item at group g, slot m of the draft (always exists after normalize). */
function draftItem(g, m) {
  var id = state.editorDraft.groups[g].itemIds[m];
  return state.editorDraft.items.find(function (i) { return i.id === id; });
}

/** Re-id an item from its label, keeping ids unique + groups in sync. */
function autoId(g, m) {
  var d = state.editorDraft;
  var item = draftItem(g, m);
  var base = slugify(item.label || 'g' + (g + 1) + '-item' + (m + 1));
  var id = base, n = 2;
  while (d.items.some(function (i) { return i !== item && i.id === id; })) id = base + '-' + n++;
  item.id = id;
  d.groups[g].itemIds[m] = id;
}

/* ── Rendering ───────────────────────────────────────────────────── */

function buildEditor() {
  state.editorDraft = loadEditorDraft();
  renderEditor();
}

function renderEditor() {
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

function renderGroupCard(g) {
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
function renderArticleSection(g) {
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
function richToolbar(g, bi) {
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
function richEditable(g, bi, placeholder, extraClass, text) {
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

function renderArticleBlockEditor(g, bi, block, total) {
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
function refreshGroupArticle(g) {
  var card = document.querySelector('.group-card[data-g="' + g + '"]');
  if (!card) return;
  var old = card.querySelector('.article-section');
  var fresh = renderArticleSection(g);
  if (old) card.replaceChild(fresh, old); else card.appendChild(fresh);
}

function renderItemEditor(g, m) {
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

function fileSetMark() {
  var s = document.createElement('span');
  s.className = 'preview-note';
  s.textContent = '✓ set';
  return s;
}

function editorActionBtn(text, cls, fn) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = text;
  btn.addEventListener('click', fn);
  return btn;
}

function renderMachineToggles() {
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

var CROP_OUT_W = 640, CROP_OUT_H = 480; // stored/output resolution (4:3)
var cropCtx = null;   // { onConfirm }
var cropImg = null;   // { el, natW, natH, coverScale, zoomMul, offX, offY }

function buildCropModal() {
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
function openCropModal(dataUrl, onConfirm) {
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

function closeCropModal() {
  if (els.cropOverlay) els.cropOverlay.hidden = true;
  cropCtx = null;
  cropImg = null;
}

function confirmCropModal() {
  if (!cropCtx || !cropImg) { closeCropModal(); return; }
  var dataUrl = els.cropCanvas.toDataURL('image/jpeg', 0.85);
  var cb = cropCtx.onConfirm;
  closeCropModal();
  if (cb) cb(dataUrl);
}

function centerCropImage() {
  var scale = cropImg.coverScale * cropImg.zoomMul;
  cropImg.offX = (CROP_OUT_W - cropImg.natW * scale) / 2;
  cropImg.offY = (CROP_OUT_H - cropImg.natH * scale) / 2;
}

function clampCropOffsets() {
  var scale = cropImg.coverScale * cropImg.zoomMul;
  var w = cropImg.natW * scale, h = cropImg.natH * scale;
  cropImg.offX = clamp(cropImg.offX, CROP_OUT_W - w, 0);
  cropImg.offY = clamp(cropImg.offY, CROP_OUT_H - h, 0);
}

function setCropZoom(mul) {
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

function renderCropCanvas() {
  if (!cropImg) return;
  var ctx = els.cropCanvas.getContext('2d');
  var scale = cropImg.coverScale * cropImg.zoomMul;
  ctx.clearRect(0, 0, CROP_OUT_W, CROP_OUT_H);
  ctx.drawImage(cropImg.el, cropImg.offX, cropImg.offY, cropImg.natW * scale, cropImg.natH * scale);
}

function cropWheel(ev) {
  if (!cropImg) return;
  ev.preventDefault();
  setCropZoom(cropImg.zoomMul + (ev.deltaY < 0 ? 0.08 : -0.08));
}

function cropPointerDown(ev) {
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
function approxDataUrlKB(dataUrl) {
  var i = dataUrl.indexOf(',');
  var b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  return Math.round((b64.length * 0.75) / 1024);
}

function sizeToast(dataUrl, name) {
  var kb = approxDataUrlKB(dataUrl);
  return kb > 200
    ? 'Embedded ' + name + ' — heads up, ' + kb + ' KB bloats the JSON.'
    : 'Embedded ' + name + '.';
}

/* ── Editing (all delegated; bound once in init) ─────────────────── */

function onEditorInput(ev) {
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

function onEditorClick(ev) {
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

function onEditorChange(ev) {
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

function refreshEditorStatus() {
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

function pushPreview() {
  try { localStorage.setItem(SAVE_PREFIX + 'preview-draft', JSON.stringify(state.editorDraft)); } catch (e) { /* ignore */ }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(function () { postToPreview({ type: 'dp2d-preview' }); }, 150);
}

/** Post to the preview iframe, queuing until it has signaled ready. */
function postToPreview(msg) {
  var f = document.getElementById('preview-frame');
  if (!f) return;
  if (!previewReady) { previewQueue.push(msg); return; }
  if (f.contentWindow) f.contentWindow.postMessage(msg, '*');
}

function flushPreviewQueue() {
  if (!previewQueue.length) return;
  var queued = previewQueue;
  previewQueue = [];
  queued.forEach(postToPreview);
}

/** ?preview boot: render whatever draft the editor last pushed. */
function bootPreviewDraft() {
  var draft = null;
  try { draft = JSON.parse(localStorage.getItem(SAVE_PREFIX + 'preview-draft')); } catch (e) { /* ignore */ }
  openPuzzle(draft && typeof draft === 'object' ? draft : JSON.parse(JSON.stringify(CURRENT_PUZZLE)));
}

/* ── Editor UI persistence (drawer width) ────────────────────────── */

var EDITOR_UI_KEY = SAVE_PREFIX + 'editor-ui';
function loadEditorUi() {
  try { return JSON.parse(localStorage.getItem(EDITOR_UI_KEY) || '{}'); } catch (e) { return {}; }
}
function saveEditorUi(patch) {
  var cur = loadEditorUi();
  for (var k in patch) cur[k] = patch[k];
  try { localStorage.setItem(EDITOR_UI_KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ }
}
function clampDrawerWidth(w) {
  return Math.max(300, Math.min(720, w));
}

/** Recompute the live-preview iframe's fixed-ratio scale + position so it
    fits the region beside the drawer (or the full screen when the drawer
    is collapsed), preserving V's aspect ratio. Called on drawer toggle,
    window resize, and live while dragging the resize handle. */
function layoutPreviewStage() {
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
function bindDrawerResize(handle, drawer) {
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
    clearTimeout(viewportTipResizeTimer);
    viewportTipResizeTimer = setTimeout(checkViewportHealth, 400);
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
      previewReady = true;
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
