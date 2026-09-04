/* ════════════════════════════════════════════════════════════════════
 * ui-play.js — DOM play layer: pieces, machines, dragging, hints,
 * results, announcer/toast, viewport tip, screen helpers.
 *
 * Imports: engine.js, state.js, audio.js, textures.js.
 * ════════════════════════════════════════════════════════════════════ */

import {
  MAX_MISTAKES, GROUP_SIZE, BOX_COUNT, SLOT_COUNT,
  TIER_EMOJI, PIECE_KIND_NAMES, ALL_MACHINES, groupOfItem,
} from './engine.js';

import {
  state, els, trayEls, trayHeaderEls, slotEls, lockBtnEls,
  hashString, mulberry32, clamp, itemById, hasMachine, NEVER_RECT,
  fallbackColor, downloadJson, persistGame, scatterSpot,
} from './state.js';

import { playSound, pieceSound } from './audio.js';

import { TEXTURE_VARS, TEXTURE_VARIANTS, pickSkinTexVar } from './textures.js';

/* ── DOM-layer piece constants ───────────────────────────────────── */
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


var RICH_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, BR: 1, SUB: 1, SUP: 1 };

/* module-level debounce timer for inline results editing */
var resultsEditTimer = null;

/* ── Announcer + toast ───────────────────────────────────────────── */

export function announce(text) {
  els.liveRegion.textContent = '';
  window.requestAnimationFrame(function () { els.liveRegion.textContent = text; });
}

export function toast(text) {
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

export function dismissViewportTip() {
  clearTimeout(state.viewportTipAutoHideTimer);
  var tip = document.getElementById('viewport-tip');
  if (!tip) return;
  tip.classList.remove('tip-visible');
  setTimeout(function () { tip.hidden = true; }, 260);
}

export function showViewportTip() {
  if (state.viewportTipShownThisLoad) return;
  state.viewportTipShownThisLoad = true;
  var tip = document.getElementById('viewport-tip');
  if (!tip) return;
  tip.hidden = false;
  requestAnimationFrame(function () { tip.classList.add('tip-visible'); });
  state.viewportTipAutoHideTimer = setTimeout(dismissViewportTip, 15000);
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
export function checkViewportHealth() {
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

export function showScreen(name) {
  ['screenMenu', 'screenPlay', 'screenError', 'screenEditor'].forEach(function (key) {
    if (els[key]) els[key].hidden = key !== name;
  });
}

export function showOverlay(el) { el.hidden = false; }
export function hideOverlay(el) { el.hidden = true; }

/** Give every new game a short orientation, while leaving editor and preview
    surfaces uncluttered. The primary button receives focus so the modal is
    immediately usable by keyboard. */
export function showClueGuide() {
  if (state.previewMode || state.editorMode || state.layoutMode) return;
  showOverlay(els.overlayHelp);
  requestAnimationFrame(function () { els.btnCloseHelp.focus(); });
}

export function closeClueGuide() {
  hideOverlay(els.overlayHelp);
  if (state.game) els.btnHelp.focus();
}

export function showErrorScreen(message) {
  els.errorMessage.textContent = message;
  showScreen('screenError');
}

/* ── Geometry ────────────────────────────────────────────────────── */

export function rectRel(el) {
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

export function pointIn(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/* ── Pieces: build once per puzzle ───────────────────────────────── */

export function buildPieces() {
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
export function decoratePaperPiece(b, item, rng) {
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

export function pieceLocation(id) {
  var game = state.game;
  var cell = game.cellOfItem(id);
  if (cell) return { kind: 'tray', box: cell.box, slot: cell.slot, locked: game.isBoxLocked(cell.box) };
  if (state.desk.scope === id) return { kind: 'scope' };
  if (itemById(id).zone === 'tubes') return { kind: 'wall' };
  return { kind: 'desk' };
}

export function sizeViewer() {
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
export function clampMachinesToDesk() {
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

export function syncHintsBtn() {
  if (!els.btnHints) return;
  var phase = state.game ? state.game.phase : null;
  var isOver = phase === 'won' || phase === 'lost';
  els.btnHints.disabled = isOver;
}

export function syncAll() {
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

export function fitPieceLabels() {
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

export function fitOneLabel(textEl, maxLines, item) {
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

export function syncHeader() {
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

export function syncTrays() {
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

/* ── Machines sync ────────────────────────────────────────────────── */

export function hintsLeft() {
  return 0;
}

export function syncMachines() {
  if (hasMachine('scope')) renderScopeView();
  // Printer counter chips removed (v15: printer is retired from hint duties).
  if (els.printerCount) els.printerCount.innerHTML = '';
}


/* ── Scope display ────────────────────────────────────────────────── */

export function makeLabelSpecimen(item) {
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
export function scopeSource(item) {
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

export function renderScopeView() {
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

/* ── Film lighting ────────────────────────────────────────────────── */

export function updateFilmLighting() {
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
export function scheduleFilmLighting() {
  updateFilmLighting();
  clearTimeout(state.filmLightTimer);
  state.filmLightTimer = setTimeout(updateFilmLighting, 280);
}

/* ── Slot-fit helpers ────────────────────────────────────────────── */

/* TRAY_PC_SCALE must stay in sync with `.piece.in-tray { --pc-scale: 0.82 }`
   in styles.css. If that CSS value changes, update this constant too. */
var TRAY_PC_SCALE = 0.82;
var SLOT_PAD = 6; // px kept clear inside the slot on each axis

/* Zone → layout.json pieceScale key, which applyLayout() writes to
   --scale-<key> on :root; each .piece-<kind> rule reads it as --type-scale. */
var ZONE_TO_SCALE_KEY = {
  corkboard: 'sticky',
  folder: 'paper',
  rack: 'slide',
  tubes: 'film',
  photo: 'photo',
  rx: 'rx',
};

function pieceTypeScale(item) {
  var key = ZONE_TO_SCALE_KEY[item.zone];
  if (!key || !state.layout || !state.layout.pieceScale) return 1;
  return state.layout.pieceScale[key] || 1;
}

/* Mirror of styles.css (search --responsive-scale at the 760px breakpoint):
   @media (max-width: 760px) { .piece { --responsive-scale: clamp(0.72, calc(100vw / 760px), 1); } }
   Breakpoint 760px, clamp floor 0.72, cap 1. */
function responsiveScale() {
  if (window.innerWidth > 760) return 1;
  return Math.min(1, Math.max(0.72, window.innerWidth / 760));
}

/* Pure math: given slot inner dimensions, untransformed piece box, and the
   combined base scale (pc-scale * type-scale * responsive-scale), return the
   largest additional factor ≤ 1 that keeps the piece inside the slot.
   Exported so window.__dp2d.fitFactor gives a browser debug hook. */
export function fitFactor(innerW, innerH, offW, offH, base) {
  if (innerW <= 0 || innerH <= 0 || offW <= 0 || offH <= 0) return 1;
  var w = offW * base;
  var h = offH * base;
  return Math.min(1, innerW / w, innerH / h);
}

function slotFitScale(el, slotEl, item) {
  var innerW = slotEl.clientWidth - SLOT_PAD;
  var innerH = slotEl.clientHeight - SLOT_PAD;
  var typeScale = pieceTypeScale(item);
  var responsive = responsiveScale();
  var base = TRAY_PC_SCALE * typeScale * responsive;
  return fitFactor(innerW, innerH, el.offsetWidth, el.offsetHeight, base);
}

/* ── Piece sync ───────────────────────────────────────────────────── */

export function syncPieces() {
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
        : state.textures.has({ rack: 'slide.webp', tubes: 'film.webp' }[item.zone]);
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
      var slotEl = slotEls[loc.box][loc.slot];
      var slotRect = rectRel(slotEl);
      x = slotRect.cx;
      y = slotRect.cy;
      rot = 0;
      // Scale the piece so it fits entirely inside its slot.
      var fit = slotFitScale(el, slotEl, item);
      el.style.setProperty('--slot-scale', String(fit));
      // Self-correcting pass: after the transform transition finishes,
      // measure the rendered box. If it still overflows by > 0.5 px
      // (e.g. due to sub-pixel rounding in the JS/CSS mirror), apply a
      // proportional correction on top of the initial scale.
      (function (capturedSlotEl, capturedEl) {
        capturedEl.addEventListener('transitionend', function (ev) {
          if (ev.propertyName !== 'transform') return;
          if (!capturedEl.classList.contains('in-tray')) return;
          var sr = capturedSlotEl.getBoundingClientRect();
          var er = capturedEl.getBoundingClientRect();
          var slotInnerW = sr.width - SLOT_PAD / 2;
          var slotInnerH = sr.height - SLOT_PAD / 2;
          if (er.width - slotInnerW > 0.5 || er.height - slotInnerH > 0.5) {
            var cur = parseFloat(capturedEl.style.getPropertyValue('--slot-scale')) || 1;
            var corr = Math.min(slotInnerW / er.width, slotInnerH / er.height);
            capturedEl.style.setProperty('--slot-scale', String(cur * corr));
          }
        }, { once: true });
      }(slotEl, el));
    } else if (loc.kind === 'scope') {
      el.style.removeProperty('--slot-scale');
      x = stageRect.cx;
      y = stageRect.cy - 4;
      rot = 0;
    } else if (loc.kind === 'wall') {
      el.style.removeProperty('--slot-scale');
      var wp = state.desk.pos[id];
      x = wallRect.left + wp.fx * wallRect.width;
      // The rail's top edge is the hanging line. Use the rendered film
      // height so this remains aligned after narrow-screen scaling too.
      y = wallRect.top + el.getBoundingClientRect().height / 2;
      rot = 0;
    } else {
      el.style.removeProperty('--slot-scale');
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

/* ── Label printer ───────────────────────────────────────────────── */

export function printLabel(id) {
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

/* ── Hints system ─────────────────────────────────────────────────── */

export function openSettingsPanel() {
  if (!els.settingsPanel || !els.btnSettings) return;
  closeHintsPanel(); // only one panel open at a time
  els.settingsPanel.hidden = false;
  els.btnSettings.setAttribute('aria-expanded', 'true');
}

export function closeSettingsPanel() {
  if (!els.settingsPanel) return;
  els.settingsPanel.hidden = true;
  if (els.btnSettings) els.btnSettings.setAttribute('aria-expanded', 'false');
}

export function toggleSettingsPanel() {
  if (!els.settingsPanel) return;
  if (els.settingsPanel.hidden) openSettingsPanel(); else closeSettingsPanel();
}

export function openHintsPanel() {
  if (!els.hintsPanel || !els.btnHints) return;
  closeSettingsPanel(); // only one panel open at a time
  buildHintsPanel();
  els.hintsPanel.hidden = false;
  els.btnHints.setAttribute('aria-expanded', 'true');
  // Focus first enabled row button.
  var first = els.hintsPanel.querySelector('.hint-row-btn:not([disabled])');
  if (first) first.focus();
}

export function closeHintsPanel() {
  if (!els.hintsPanel) return;
  els.hintsPanel.hidden = true;
  if (els.btnHints) els.btnHints.setAttribute('aria-expanded', 'false');
}

export function toggleHintsPanel() {
  if (!els.hintsPanel) return;
  if (els.hintsPanel.hidden) openHintsPanel(); else closeHintsPanel();
}

export function buildHintsPanel() {
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
  addHintRow(panel, 'Seed the Trays', 'Places one piece from each unsolved group into its correct tray and pins it.', h2Used, !!h2DisabledReason && !h2Used, h2DisabledReason || (h2Used ? 'Used' : ''), function () {
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

export function addHintRow(panel, name, desc, used, disabled, reason, onClick) {
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

export function applyH1LabelImages() {
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

export function applyH2SeedTrays() {
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

export function applyH3RevealCategory() {
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

export function syncRevealNote() {
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

/* ── Dragging ─────────────────────────────────────────────────────── */

/* ── Dragging (Pointer Events, handlers bound ONCE in init) ─────── */

export function forceEndStaleDrag() {
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

export function onPointerDown(ev) {
  // Dev layout mode: machines are draggable instead of pieces.
  if (state.layoutMode && state._layoutPointerDown && state._layoutPointerDown(ev)) return;

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
  // Restore full desk size immediately so the grabbed piece doesn't
  // animate at slot-scale while flying across the board.
  pieceEl.style.removeProperty('--slot-scale');
  pieceEl.style.setProperty('--rot', '0deg');
  pieceEl.style.zIndex = String(10 + state.desk.z[id]);
  pieceEl.style.left = cx + 'px';
  pieceEl.style.top = cy + 'px';

  // Pickup side effects AFTER the drag session exists, so the engine's
  // change → syncAll pass skips this piece instead of repositioning it.
  if (wasStaged) state.game.unstage(id);
  if (wasDocked) { state.desk.scope = null; renderScopeView(); }

}

export function dragPoint(ev) {
  var d = state.drag;
  return {
    x: ev.clientX - d.playRect.left - d.offX,
    y: ev.clientY - d.playRect.top - d.offY,
  };
}

export function onPointerMove(ev) {
  if (state.layoutDrag) { if (state._layoutPointerMove) state._layoutPointerMove(ev); return; }
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

export function updateDropHot(x, y) {
  var d = state.drag;
  var c = classifyDrop(classifyInput(d, x, y));
  var hot = null;
  if (c.kind === 'slot' || c.kind === 'tray-full') hot = trayEls[c.box];
  else if (c.kind === 'scope') hot = els.scopeStage;
  if (d.hotEl && d.hotEl !== hot) d.hotEl.classList.remove('drop-hot');
  if (hot && d.hotEl !== hot) hot.classList.add('drop-hot');
  d.hotEl = hot;
}

export function onPointerUp(ev) {
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

export function onPointerCancel(ev) {
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
export function classifyDrop(input) {
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
export function classifyInput(d, x, y) {
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
export function applyDrop(d, x, y) {
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
export function settleOnDesk(id, x, y, deskRect) {
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

export function settleOnWall(id, x, wallRect) {
  var rect = wallRect || rectRel(els.xrayRail);
  var p = state.desk.pos[id] || { fx: 0.2, fy: 0.5 };
  var nextX = x === null || x === undefined ? rect.left + p.fx * rect.width : x;
  state.desk.pos[id] = {
    fx: clamp((nextX - rect.left) / rect.width, 0.08, 0.92),
    fy: 0.5,
  };
  state.desk.rot[id] = 0;
}

/* ── Keyboard controls ────────────────────────────────────────────── */

/* ── Keyboard controls (bound ONCE on document) ─────────────────── */

export function onKeyDown(ev) {
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

export function sendToTray(id, b) {
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

export function returnToDesk(id) {
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

export function viewOnMachine(id, item) {
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

/* ── Peek overlay ─────────────────────────────────────────────────── */

var peekOverlay = null; // module-private peek overlay DOM element

/* ════════════════════════════════════════════════════════════════════
 * PEEK OVERLAY — read-only viewer for hint-pinned slides and films.
 * The piece stays in its tray; no engine state is touched.
 * ════════════════════════════════════════════════════════════════════ */

/** Build (once) and show the peek overlay for a pinned rack or tubes piece. */
export function openPinnedPeek(id, item) {
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
export function renderPeekScopeCanvas(item, canvas, scopeWrap) {
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
export function closePinnedPeek() {
  if (!peekOverlay) return;
  peekOverlay.hidden = true;
  var returnId = peekOverlay.dataset.returnFocusId;
  if (returnId && state.pieceEls && state.pieceEls[returnId]) {
    state.pieceEls[returnId].focus({ preventScroll: true });
  }
}

/** Spoken description of what a machine reveals for an item (aria only —
    the displays themselves stay text-free). */
export function revealText(item) {
  var parts = [item.label];
  var info = item.info || {};
  if (info.title && info.title !== item.label) parts.push(info.title);
  if (info.text) parts.push(info.text);
  if (item.analyzer && item.analyzer.lines && item.analyzer.lines.length) {
    parts.push(item.analyzer.lines.join(', '));
  }
  return parts.join('. ');
}

/* ── Lock In ──────────────────────────────────────────────────────── */

export function onTraysClick(ev) {
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
    var trayWrongEl = trayEls[b];
    trayWrongEl.classList.remove('is-wrong');
    void trayWrongEl.offsetWidth;
    trayWrongEl.classList.add('is-wrong');
    setTimeout(function () { trayWrongEl.classList.remove('is-wrong'); }, 400);
    var boxIds = game.staging[b].filter(function (c) { return c !== null; });
    boxIds.forEach(function (itemId) {
      var pieceEl = state.pieceEls[itemId];
      if (!pieceEl) return;
      pieceEl.classList.remove('is-shake');
      void pieceEl.offsetWidth;
      pieceEl.classList.add('is-shake');
      setTimeout(function () { pieceEl.classList.remove('is-shake'); }, 400);
    });
    var msg = state.settings.casual
      ? 'Not quite. Mistake ' + game.mistakes + '.'
      : 'Not quite. ' + Math.max(game.mistakesLeft, 0) + ' mistake' + (game.mistakesLeft === 1 ? '' : 's') + ' left.';
    if (result.oneAway) {
      msg += ' One away!';
      playSound('one-away');
      toast('One away!');
      var trayOneAwayEl = trayEls[b];
      trayOneAwayEl.classList.remove('is-one-away');
      void trayOneAwayEl.offsetWidth;
      trayOneAwayEl.classList.add('is-one-away');
      setTimeout(function () { trayOneAwayEl.classList.remove('is-one-away'); }, 1200);
    }
    announce(msg);
  }
}

/* ── Scatter ──────────────────────────────────────────────────────── */

export function onShuffle() {
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

/* ── Restricted-HTML sanitizer ───────────────────────────────────── */

export function sanitizeRichHtml(html) {
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
export function sanitizeChildrenInto(srcNode, outParent) {
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

/* ── Results overlay ──────────────────────────────────────────────── */

/** editCtx: optional { groupId, blockIndex } — when present, adds
    contenteditable + data attributes for inline preview-mode editing. */
export function renderArticleBlock(block, editCtx) {
  if (!block) return null;
  if (block.type === 'heading') {
    var h = document.createElement('h4');
    h.className = 'result-article-heading';
    h.innerHTML = sanitizeRichHtml(block.text || '');
    if (editCtx) {
      h.contentEditable = 'true';
      h.className += ' results-editable';
      h.dataset.editGroup = editCtx.groupId;
      h.dataset.editField = 'article:' + editCtx.blockIndex + ':text';
      h.dataset.editRich = '1';
      h.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); h.blur(); } });
    }
    return h;
  }
  if (block.type === 'text') {
    var p = document.createElement('p');
    p.className = 'result-article-text';
    p.innerHTML = sanitizeRichHtml(block.text || '');
    if (editCtx) {
      p.contentEditable = 'true';
      p.className += ' results-editable';
      p.dataset.editGroup = editCtx.groupId;
      p.dataset.editField = 'article:' + editCtx.blockIndex + ':text';
      p.dataset.editRich = '1';
    }
    return p;
  }
  if (block.type === 'image' && block.src) {
    var fig = document.createElement('figure');
    fig.className = 'result-article-figure';
    var img = document.createElement('img');
    img.src = block.src;
    img.alt = block.caption || '';
    fig.appendChild(img);
    if (block.caption || editCtx) {
      var cap = document.createElement('figcaption');
      cap.className = 'result-article-caption';
      cap.textContent = block.caption || '';
      if (editCtx) {
        cap.contentEditable = 'true';
        cap.className += ' results-editable';
        cap.dataset.editGroup = editCtx.groupId;
        cap.dataset.editField = 'article:' + editCtx.blockIndex + ':caption';
        cap.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); cap.blur(); } });
      }
      fig.appendChild(cap);
    }
    return fig;
  }
  return null;
}

/** One tier-colored placard: name, tier, items, lede (`explanation`), and
    — if the group has one — its full article body underneath. Groups
    without an article render exactly as before (placard + explanation).
    When state.previewMode is true, text nodes are contenteditable so the
    author can edit them inline; changes post dp2d-results-edit to parent. */
export function buildResultPlacard(puzzle, g, solvedGroupIds) {
  var isPreview = !!state.previewMode;
  var card = document.createElement('div');
  card.className = 'result-placard' + (solvedGroupIds.has(g.id) ? ' solved-by-player' : '');
  card.style.setProperty('--group-color', 'var(--tier-' + g.tier + ')');

  if (isPreview) {
    var hint = document.createElement('p');
    hint.className = 'results-preview-hint';
    hint.textContent = 'Preview mode: click any text to edit it — changes save to the draft.';
    card.appendChild(hint);
  }

  var nameEl = document.createElement('p');
  nameEl.className = 'result-placard-name';
  nameEl.textContent = 'Tier ' + g.tier;
  var h3 = document.createElement('h3');
  h3.textContent = g.name;
  if (isPreview) {
    h3.contentEditable = 'true';
    h3.className = 'results-editable';
    h3.dataset.editGroup = g.id;
    h3.dataset.editField = 'name';
    h3.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); h3.blur(); } });
  }
  var itemsEl = document.createElement('p');
  itemsEl.className = 'result-placard-items';
  itemsEl.textContent = g.itemIds.map(function (id) {
    var item = puzzle.items.find(function (i) { return i.id === id; });
    return item ? item.label : id;
  }).join(' · ');
  var explEl = document.createElement('p');
  explEl.className = 'result-placard-explanation';
  explEl.textContent = g.explanation;
  if (isPreview) {
    explEl.contentEditable = 'true';
    explEl.className += ' results-editable';
    explEl.dataset.editGroup = g.id;
    explEl.dataset.editField = 'explanation';
    explEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); explEl.blur(); } });
  }
  card.appendChild(nameEl);
  card.appendChild(h3);
  card.appendChild(itemsEl);
  card.appendChild(explEl);

  if (Array.isArray(g.article) && g.article.length) {
    var article = document.createElement('div');
    article.className = 'result-article';
    g.article.forEach(function (block, bi) {
      var editCtx = isPreview ? { groupId: g.id, blockIndex: bi } : null;
      var node = renderArticleBlock(block, editCtx);
      if (node) article.appendChild(node);
    });
    card.appendChild(article);
  }
  return card;
}

/** Renders the results overlay for any puzzle + solved-group set. Both the
    real end-of-game path (showResults) and the editor's "Preview results"
    button funnel through here, so what you author is exactly what plays. */
export function showResultsForPuzzle(puzzle, opts) {
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

export function showResults() {
  var game = state.game;
  var won = game.phase === 'won';
  var solvedGroupIds = new Set(game.solved.map(function (s) { return s.groupId; }));
  var casualSuffix = game.casual ? ' Casual mode.' : '';
  showResultsForPuzzle(game.puzzle, {
    title: won ? 'Solved!' : 'Out of mistakes',
    sub: won
      ? 'Solved with ' + game.mistakes + ' mistake' + (game.mistakes === 1 ? '' : 's') + '.' + casualSuffix
      : 'Here is how the groups fit together.' + casualSuffix,
    hints: state.desk.hints || {},
    legacyHintsUsed: state.desk.hintsUsed,
    solvedGroupIds: solvedGroupIds,
  });
}

/** ?preview boot, in response to the editor's "Preview results" button:
    load the current draft and show its results overlay as if every group
    had just been solved — the exact game-end view, without playing. */
export function showPreviewResultsFromDraft() {
  if (!state.game) return;
  var puzzle = state.game.puzzle;
  showResultsForPuzzle(puzzle, {
    title: 'Solved!',
    sub: 'Solved with 0 mistakes.',
    solvedGroupIds: new Set(puzzle.groups.map(function (g) { return g.id; })),
  });
}

/** Post a results-edit message to the parent editor.
    final=true signals the editor to push the preview refresh. */
function postResultsEdit(el, final) {
  var groupId = el.dataset.editGroup;
  var field = el.dataset.editField;
  if (!groupId || !field) return;
  var isRich = el.dataset.editRich === '1';
  var value = isRich ? sanitizeRichHtml(el.innerHTML) : el.textContent;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'dp2d-results-edit', groupId: groupId, field: field, value: value, final: !!final }, '*');
  }
}

/** Set up delegated input/blur listeners on the results overlay for
    inline preview-mode editing. Call once after preview mode is enabled. */
export function bindResultsEdit() {
  if (!els.overlayResults) return;
  els.overlayResults.addEventListener('input', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-edit-group][data-edit-field]') : null;
    if (!el) return;
    clearTimeout(resultsEditTimer);
    resultsEditTimer = setTimeout(function () { postResultsEdit(el, false); }, 250);
  });
  els.overlayResults.addEventListener('blur', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-edit-group][data-edit-field]') : null;
    if (!el) return;
    clearTimeout(resultsEditTimer);
    postResultsEdit(el, true); // final=true → editor will pushPreview
  }, true); // capture so blur (which doesn't bubble) is caught
}

/* ── Share + Anki ──────────────────────────────────────────────────── */

export function buildShareText() {
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

export function onShare() {
  var text = buildShareText();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast('Copied to clipboard!');
    }, function () { showShareFallback(text); });
  } else {
    showShareFallback(text);
  }
}

export function showShareFallback(text) {
  els.shareFallback.value = text;
  els.shareFallback.hidden = false;
  els.shareFallback.focus();
  els.shareFallback.select();
  toast('Select the text below to copy.');
}

export function buildAnkiSearch(puzzle) {
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

export function onCopyAnki() {
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
