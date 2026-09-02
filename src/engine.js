/* ════════════════════════════════════════════════════════════════════
 * engine.js — pure rules engine, no DOM.
 *
 * Emitter, DeskPuzzleGame, helpers and all engine-level constants.
 * No import needed (no dependencies).
 * ════════════════════════════════════════════════════════════════════ */

export var MAX_MISTAKES = 4;
export var GROUP_SIZE = 4;
export var BOX_COUNT = 4;
export var SLOT_COUNT = 4;

/** Minimal pub/sub. */
export function Emitter() {
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
export var PIECE_KIND_NAMES = {
  corkboard: 'sticky note',
  folder: 'paper sheet',
  rack: 'slide',
  tubes: 'X-ray film',
  photo: 'photograph',
  rx: 'prescription',
};

/** Retired piece kinds are mapped forward when a puzzle loads. */
export var KIND_MIGRATIONS = { deskCards: 'folder' };

export function normalizeKinds(c) {
  if (c && Array.isArray(c.items)) {
    c.items.forEach(function (i) {
      if (i && KIND_MIGRATIONS[i.zone]) i.zone = KIND_MIGRATIONS[i.zone];
    });
  }
  return c;
}

/* Machines a puzzle may declare. Absent `machines` field = all three. */
export var ALL_MACHINES = ['scope', 'lightbox'];

/** The machine set a puzzle declares (back-compat: absent = everything). */
export function puzzleMachines(c) {
  if (!c || !Array.isArray(c.machines)) return ALL_MACHINES.slice();
  return c.machines.filter(function (m) { return ALL_MACHINES.indexOf(m) !== -1; });
}

/**
 * Collect every structural problem with a puzzle case (empty = valid).
 */
export function caseProblems(c) {
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
export function validateCase(c) {
  var problems = caseProblems(c);
  if (problems.length) {
    throw new Error('Invalid puzzle case "' + (c && c.id) + '":\n - ' + problems.join('\n - '));
  }
}

/** Find the group an item belongs to. Throws if the item has no group. */
export function groupOfItem(c, itemId) {
  var g = c.groups.find(function (g) { return g.itemIds.indexOf(itemId) !== -1; });
  if (!g) throw new Error('item ' + itemId + ' has no group');
  return g;
}

/** A fresh 4×4 grid of empty slot cells. */
export function emptyGrid() {
  var grid = [];
  for (var b = 0; b < BOX_COUNT; b++) {
    var row = [];
    for (var s = 0; s < SLOT_COUNT; s++) row.push(null);
    grid.push(row);
  }
  return grid;
}

// HINTS_MAX retired in v15. TIER_EMOJI lives here as a pure display constant.
export var TIER_EMOJI = { 1: '🟨', 2: '🟩', 3: '🟪', 4: '🟧' };

/**
 * DeskPuzzleGame — the state machine. Phases: intro → playing → won|lost.
 */
export function DeskPuzzleGame(puzzle, opts) {
  opts = opts || {};
  this.puzzle = puzzle;
  this.events = new Emitter();
  this.casual = !!opts.casual;

  this.phase_ = 'intro';
  this.staging_ = emptyGrid();
  this.mistakes_ = 0;
  this.solved_ = [];
  this.attempts_ = [];
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

DeskPuzzleGame.prototype.boxOfItem = function (itemId) {
  return this.staging_.findIndex(function (box) { return box.indexOf(itemId) !== -1; });
};

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

DeskPuzzleGame.prototype.firstEmptySlot = function (boxIndex) {
  return this.staging_[boxIndex].indexOf(null);
};

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

DeskPuzzleGame.prototype.autoPlace = function (itemId) {
  if (this.phase_ !== 'playing' || this.isSolvedItem(itemId)) return 'ignored';
  for (var b = 0; b < BOX_COUNT; b++) {
    if (this.isBoxLocked(b)) continue;
    var slot = this.firstEmptySlot(b);
    if (slot >= 0) return this.stageToSlot(itemId, b, slot);
  }
  return 'full';
};

DeskPuzzleGame.prototype.unstage = function (itemId) {
  var cell = this.cellOfItem(itemId);
  if (!cell || this.phase_ !== 'playing') return;
  if (this.isBoxLocked(cell.box) || this.isSolvedItem(itemId)) return;
  this.staging_[cell.box][cell.slot] = null;
  this.events.emit('unstaged', { itemId: itemId });
  this.touch();
};

DeskPuzzleGame.prototype.isOneAway = function (groups) {
  var counts = new Map();
  groups.forEach(function (g) { counts.set(g.id, (counts.get(g.id) || 0) + 1); });
  var found = false;
  counts.forEach(function (n) { if (n === 3) found = true; });
  return found;
};

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
