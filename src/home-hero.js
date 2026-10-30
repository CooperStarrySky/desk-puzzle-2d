/* ════════════════════════════════════════════════════════════════════
 * home-hero.js: the top of the home page (approved mockup "H4").
 *
 * - The h1 is this week's puzzle name; the meta line gives its number, date
 *   and piece count. The live line ("N players so far · X% found all four")
 *   only appears once the public class totals pass CLASS_MIN.
 * - The featured card's mini desk is drawn live from the puzzle (same pick
 *   and scatter as tools/thumb-render.js), so pieces near a mouse pointer can
 *   lift and turn toward straight. The saved thumbnail stays as the fallback.
 * - One page-load moment: the title words rise, meta / live line / Play
 *   follow, the numbers count up and the pieces drop onto the desk.
 * - Reduced motion: everything is in its final state at once, no hover.
 *
 * Motion comes from the small spring helper below (no animation library).
 * ════════════════════════════════════════════════════════════════════ */

import { state, els } from './state.js';
import { CLASS_MIN, classSummary, isStatsEligible, isLegacyStatsPuzzle } from './stats-core.js';
import { fetchClassStats } from './stats-remote.js';
import { wireCreditLabels } from './ui-play.js';

var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function reduced() { return !!(reduceQuery && reduceQuery.matches); }
function finePointer() {
  return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
}

/* ── Springs: one shared rAF loop, damped harmonic motion per value ── */

var live = new Set(), loopRaf = 0, loopLast = 0;
function loop(now) {
  var dt = Math.min(0.05, Math.max(0, (now - loopLast) / 1000));
  loopLast = now;
  live.forEach(function (s) { s._step(dt); });
  loopRaf = live.size ? requestAnimationFrame(loop) : 0;
}
function wake() {
  if (loopRaf) return;
  loopLast = performance.now();
  loopRaf = requestAnimationFrame(loop);
}

/** A value that springs toward its target and calls onChange(x) each frame.
    stiffness / damping as in most spring libraries (mass 1). */
export function Spring(x, onChange, stiffness, damping) {
  this.x = x; this.v = 0; this.to = x;
  this.k = stiffness || 170; this.c = damping || 24;
  this.cb = onChange; this.timer = 0;
}
Spring.prototype._step = function (dt) {
  var n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
  for (var i = 0; i < n; i++) {
    this.v += (-this.k * (this.x - this.to) - this.c * this.v) * h;
    this.x += this.v * h;
  }
  if (Math.abs(this.x - this.to) < 0.0005 && Math.abs(this.v) < 0.005) {
    this.x = this.to; this.v = 0; live.delete(this);
    this.cb(this.x);
    if (this.onDone) this.onDone();
    return;
  }
  this.cb(this.x);
};
/** Jump straight to x (no motion). */
Spring.prototype.set = function (x) {
  clearTimeout(this.timer); live.delete(this);
  this.x = this.to = x; this.v = 0; this.cb(x);
};
/** Spring to `to`, optionally after `delay` seconds. */
Spring.prototype.go = function (to, delay) {
  var self = this;
  clearTimeout(this.timer);
  var start = function () { self.to = to; live.add(self); wake(); };
  if (delay > 0) this.timer = setTimeout(start, delay * 1000); else start();
};

/* ── Small helpers ───────────────────────────────────────────────── */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Fade + rise an element in with a spring after `delay` s; clears its
    inline styles at the end so hover and focus styles take over again. */
function riseIn(el, delay, dy, stiffness, damping) {
  if (!el) return;
  el.style.opacity = '0';
  el.style.transform = 'translateY(' + dy + 'px)';
  var s = new Spring(0, function (p) {
    el.style.opacity = String(clamp01(p * 1.4));
    el.style.transform = 'translateY(' + ((1 - p) * dy).toFixed(2) + 'px)';
  }, stiffness || 170, damping || 24);
  s.onDone = function () { el.style.opacity = ''; el.style.transform = ''; };
  s.go(1, delay);
}

/** Count a number up from 0 (ease-out, `dur` s) and write it with `suffix`. */
function countUp(node, to, suffix, delay, dur) {
  if (!node) return;
  node.textContent = '0' + suffix;
  var t0 = 0;
  var tick = function (now) {
    if (!t0) t0 = now;
    var p = Math.min(1, (now - t0) / (dur * 1000));
    var e = 1 - Math.pow(1 - p, 4);
    node.textContent = Math.round(to * e) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  setTimeout(function () { requestAnimationFrame(tick); }, delay * 1000);
}

/* ── Desk layout: mirrors tools/thumb-render.js exactly (same hash, PRNG,
      kinds, sizes and scatter) so the live desk matches the saved thumbnail.
      Keep the two in step if either changes. ──────────────────────── */

var DESK_W = 800, DESK_H = 500, DESK_TILES = 9;
var TILE_SIZE = {
  note: [168, 148], rx: [168, 160], sheet: [160, 176],
  photo: [176, 160], slide: [228, 92], film: [148, 172],
};
function hashString(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function tileKind(item) {
  var info = item.info || {}, scope = item.scope || {};
  switch (item.zone) {
    case 'corkboard': return item.label ? 'note' : null;
    case 'rx': return item.label ? 'rx' : null;
    case 'folder': return item.label ? 'sheet' : null;
    case 'photo': return info.image ? 'photo' : (item.label ? 'note' : null);
    case 'rack': return scope.image ? 'slide' : null;
    case 'tubes': return info.image ? 'film' : null;
    default: return null;
  }
}

/** The 9 tiles (kind, item, box, angle) for a puzzle, as thumb-render.js picks them. */
export function deskTiles(puzzle) {
  var rng = mulberry32(hashString('thumb:' + puzzle.id));
  var shuffle = function (a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };
  var byKind = {};
  (puzzle.items || []).forEach(function (it) {
    var k = tileKind(it);
    if (k) (byKind[k] = byKind[k] || []).push(it);
  });
  var kinds = shuffle(Object.keys(byKind).sort());
  kinds.forEach(function (k) { shuffle(byKind[k]); });
  var out = [];
  while (out.length < DESK_TILES) {
    var added = false;
    for (var i = 0; i < kinds.length && out.length < DESK_TILES; i++) {
      var it = byKind[kinds[i]].shift();
      if (it) { out.push({ item: it, kind: kinds[i] }); added = true; }
    }
    if (!added) break;
  }
  return shuffle(out).map(function (c, idx) {
    var sz = TILE_SIZE[c.kind], col = idx % 3, row = Math.floor(idx / 3);
    var cx = (col + 0.5) * (DESK_W / 3) + (rng() - 0.5) * 44;
    var cy = (row + 0.5) * (DESK_H / 3) + (rng() - 0.5) * 26;
    return {
      kind: c.kind, item: c.item,
      x: Math.min(Math.max(cx - sz[0] / 2, 8), DESK_W - sz[0] - 8),
      y: Math.min(Math.max(cy - sz[1] / 2, 8), DESK_H - sz[1] - 8),
      w: sz[0], h: sz[1],
      r: Number(((rng() - 0.5) * 16).toFixed(1)),
    };
  });
}

/** Shrink a note label until it fits (thumb-render.js fitLabel). */
function fitLabel(lbl, span, start, floor) {
  var cs = getComputedStyle(lbl);
  var room = lbl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  var fits = function () { return span.scrollWidth <= span.clientWidth && span.scrollHeight <= room; };
  for (var fs = start; fs >= floor; fs--) { span.style.fontSize = fs + 'px'; if (fits()) return; }
  if (span.textContent.indexOf(' ') < 0) {
    for (var f2 = floor - 1; f2 >= 16 && !fits(); f2--) span.style.fontSize = f2 + 'px';
  }
  var words = span.textContent.split(' ');
  var SMALL = /^(a|an|the|in|of|on|and|or|to|with|for|by|at)$/i;
  while (words.length > 1 && !fits()) {
    words.pop();
    while (words.length > 1 && SMALL.test(words[words.length - 1])) words.pop();
    span.textContent = words.join(' ').replace(/[,;:]$/, '') + '…';
  }
  if (!fits()) span.style.overflowWrap = 'anywhere';
}

function imageLoaded(im) {
  if (im.complete && im.naturalWidth > 0) return Promise.resolve();
  return new Promise(function (res, rej) {
    im.addEventListener('load', res, { once: true });
    im.addEventListener('error', rej, { once: true });
  });
}

/* ── Live desk inside the featured .mini ─────────────────────────── */

var desk = null; // { id, mini, layer, tiles: [{el, r, cx, cy, lift, drop}], ready }

function paintTile(t) {
  var f = t.f, d = t.d;
  t.el.style.transform = 'translateY(' + (-10 * f - 26 * (1 - d)).toFixed(2) + 'px) rotate(' + (t.r * (1 - 0.75 * f)).toFixed(2) + 'deg) scale(' + (1 + 0.035 * f).toFixed(4) + ')';
  t.el.style.opacity = clamp01(d * 1.6).toFixed(3);
  t.el.style.boxShadow = '0 ' + (6 + 10 * f).toFixed(1) + 'px ' + (12 + 16 * f).toFixed(1) + 'px rgba(0,0,0,' + (0.32 - 0.06 * f).toFixed(3) + '), 0 1px 2px rgba(0,0,0,0.25)';
  t.el.style.zIndex = f > 0.05 ? String(2 + Math.round(f * 10)) : '1';
}

/** Builds the tiles for `puzzle` into a hidden layer; resolves once every
    picture has loaded (rejects if any fails, so the thumbnail stays). */
function buildDesk(mini, puzzle) {
  var layer = document.createElement('span');
  layer.className = 'desk-live';
  layer.setAttribute('aria-hidden', 'true');
  var waits = [], tiles = [];
  deskTiles(puzzle).forEach(function (d) {
    var el = document.createElement('span');
    el.className = 't t-' + d.kind;
    el.style.left = d.x.toFixed(1) + 'px';
    el.style.top = d.y.toFixed(1) + 'px';
    el.style.width = d.w + 'px';
    el.style.height = d.h + 'px';
    var src = d.kind === 'slide' ? d.item.scope.image : (d.kind === 'photo' || d.kind === 'film') ? d.item.info.image : '';
    if (src) {
      var im = new Image();
      im.alt = ''; im.decoding = 'async'; im.src = src;
      if (d.kind === 'slide') {
        var smear = document.createElement('span');
        smear.className = 'smear';
        smear.appendChild(im);
        el.appendChild(smear);
      } else el.appendChild(im);
      waits.push(imageLoaded(im));
    } else {
      var lbl = document.createElement('span'), span = document.createElement('span');
      lbl.className = 'lbl';
      span.textContent = String(d.item.label || '').replace(/\s+/g, ' ').trim();
      lbl.appendChild(span);
      el.appendChild(lbl);
      el._fit = function () { fitLabel(lbl, span, d.kind === 'note' ? 36 : 30, 22); };
    }
    layer.appendChild(el);
    var t = { el: el, r: d.r, cx: d.x + d.w / 2, cy: d.y + d.h / 2, f: 0, d: 1 };
    t.lift = new Spring(0, function (v) { t.f = v; paintTile(t); }, 260, 24);
    t.drop = new Spring(1, function (v) { t.d = v; paintTile(t); }, 140, 17);
    paintTile(t);
    tiles.push(t);
  });
  mini.appendChild(layer);
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  return Promise.all(waits.concat([fonts])).then(function () {
    tiles.forEach(function (t) { if (t.el._fit) t.el._fit(); });
    return { id: puzzle.id, mini: mini, layer: layer, tiles: tiles };
  }, function (err) {
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    throw err;
  });
}

function scaleDesk() {
  if (!desk || !desk.mini.clientWidth) return;
  desk.layer.style.transform = 'scale(' + (desk.mini.clientWidth / DESK_W) + ')';
}
var deskResize = 'ResizeObserver' in window ? new ResizeObserver(scaleDesk) : null;
if (!deskResize) window.addEventListener('resize', scaleDesk);

/* Pieces near a mouse pointer lift a little, turn toward straight and cast a
   softer, deeper shadow; they spring back when the pointer moves away. */
var hoverWired = null, hoverEv = null;
function wireDeskHover(mini) {
  if (hoverWired === mini) return;
  hoverWired = mini;
  mini.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || reduced() || !desk || desk.mini !== mini) return;
    var queued = hoverEv; hoverEv = e;
    if (queued) return;
    requestAnimationFrame(function () {
      var ev = hoverEv; hoverEv = null;
      if (!ev || !desk) return;
      var r = mini.getBoundingClientRect(), k = r.width / DESK_W;
      if (!k) return;
      var px = (ev.clientX - r.left) / k, py = (ev.clientY - r.top) / k;
      desk.tiles.forEach(function (t) {
        var dist = Math.hypot(t.cx - px, (t.cy - py) * 1.15);
        var to = clamp01(1 - Math.max(0, dist - 40) / 150);
        if (Math.abs(to - t.lift.to) > 0.01) t.lift.go(to);
      });
    });
  });
  mini.addEventListener('pointerleave', function () {
    hoverEv = null;
    if (desk) desk.tiles.forEach(function (t) { t.lift.go(0); });
  });
}

/* ── Hero text ───────────────────────────────────────────────────── */

var FALLBACK_TITLE = 'This week’s puzzle';
var PIECES = 16;

/** Writes the h1 as one clipped span per word (for the rise), keeping the
    plain title as its accessible name and textContent. */
function setTitle(text) {
  var h1 = document.getElementById('menu-headline');
  if (!h1 || h1.getAttribute('data-title') === text) return;
  h1.setAttribute('data-title', text);
  h1.textContent = '';
  text.split(/\s+/).forEach(function (w, i) {
    if (i) h1.appendChild(document.createTextNode(' '));
    var outer = document.createElement('span'), inner = document.createElement('span');
    outer.className = 'w';
    inner.textContent = w;
    outer.appendChild(inner);
    h1.appendChild(outer);
  });
}

function setMeta(number, dateText, pieces) {
  var meta = document.getElementById('hero-meta');
  if (!meta) return;
  var parts = [];
  if (number) parts.push('Puzzle ' + number);
  if (dateText) parts.push(dateText);
  parts.push(pieces + ' clues');
  meta.textContent = parts.join(' · ');
}

/* ── Live line: real class totals only, never below CLASS_MIN ─────── */

var liveFor = null;
function showLive(puzzleId, animate) {
  var line = document.getElementById('hero-live');
  if (!line) return;
  if (liveFor !== puzzleId) { line.hidden = true; liveFor = puzzleId; }
  if (!isStatsEligible(puzzleId) || state.previewMode || state.editorMode) return;
  fetchClassStats([puzzleId]).then(function (map) {
    if (liveFor !== puzzleId) return;
    var sum = classSummary(map[puzzleId]);
    if (!sum || !sum.enough || sum.stdFinishes < CLASS_MIN) { line.hidden = true; return; }
    var players = document.getElementById('hero-players'), solved = document.getElementById('hero-solved');
    var when = document.getElementById('hero-live-when');
    if (when) when.textContent = isLegacyStatsPuzzle(puzzleId) ? 'since Oct 2026' : 'so far';
    var wasHidden = line.hidden;
    line.hidden = false;
    if (animate && wasHidden && !reduced()) {
      var wait = Math.max(0, 0.55 - (performance.now() - introAt) / 1000);
      riseIn(line, wait, 14);
      countUp(players, sum.plays, '', wait + 0.1, 1.3);
      countUp(solved, sum.solvedPct, '%', wait + 0.1, 1.3);
    } else {
      players.textContent = String(sum.plays);
      solved.textContent = sum.solvedPct + '%';
    }
  });
}

/* ── Page-load moment ────────────────────────────────────────────── */

var introDone = false, introAt = 0;

/** Runs once, the first time the menu is drawn while it is on screen. */
function intro() {
  var root = document.documentElement;
  if (introDone) return false;
  introDone = true;
  introAt = performance.now();
  var onMenu = els.screenMenu && !els.screenMenu.hidden;
  if (reduced() || !onMenu) { root.classList.remove('home-intro'); return false; }
  var meta = document.getElementById('hero-meta');
  var words = Array.prototype.slice.call(document.querySelectorAll('#menu-headline .w > span'));
  var feature = els.btnPlayFeatured;
  [meta, els.btnPlayToday, feature].forEach(function (el) { if (el) el.style.opacity = '0'; });
  words.forEach(function (w) { w.style.transform = 'translateY(110%)'; });
  root.classList.remove('home-intro');
  riseIn(meta, 0.05, 10, 200, 26);
  words.forEach(function (w, i) {
    var s = new Spring(0, function (p) { w.style.transform = 'translateY(' + ((1 - p) * 110).toFixed(2) + '%)'; }, 120, 22);
    s.onDone = function () { w.style.transform = ''; };
    s.go(1, 0.15 + i * 0.08);
  });
  riseIn(feature, 0.3, 36, 120, 18);
  riseIn(els.btnPlayToday, 0.8, 14);
  return true;
}

/** Pieces drop onto the desk one after another. */
function dropTiles(delay) {
  if (!desk || reduced()) return;
  desk.tiles.forEach(function (t, i) { t.drop.set(0); t.drop.go(1, delay + i * 0.045); });
}

/* ── Magnetic Play: leans toward a nearby mouse, springs home ────── */

var magnetWired = false;
function wireMagnet() {
  var play = els.btnPlayToday, zone = play && play.parentNode;
  if (magnetWired || !zone) return;
  magnetWired = true;
  var mx = 0, my = 0;
  var paint = function () { play.style.translate = mx || my ? mx.toFixed(2) + 'px ' + my.toFixed(2) + 'px' : ''; };
  var sx = new Spring(0, function (v) { mx = v; paint(); }, 260, 18);
  var sy = new Spring(0, function (v) { my = v; paint(); }, 260, 18);
  zone.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || reduced() || !finePointer()) return;
    var r = play.getBoundingClientRect();
    var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    var near = Math.abs(dx) < r.width && Math.abs(dy) < r.height * 1.6;
    sx.go(near ? dx * 0.22 : 0); sy.go(near ? dy * 0.3 : 0);
  });
  zone.addEventListener('pointerleave', function () { sx.go(0); sy.go(0); });
}

/* ── Entry point (called from renderMenu) ────────────────────────── */

/**
 * @param entry       this week's registry entry (or undefined)
 * @param number      its 1-based number in release order (0 if unknown)
 * @param dateText    its formatted date ('' if unknown)
 * @param loadPuzzle  entry -> Promise<puzzle JSON>
 */
export function renderHero(entry, number, dateText, loadPuzzle) {
  setTitle(entry && entry.title ? entry.title : FALLBACK_TITLE);
  setMeta(number, dateText, PIECES);
  if (els.btnPlayFeatured) {
    els.btnPlayFeatured.setAttribute('aria-label', 'Play this week’s puzzle' + (entry && entry.title ? ', ' + entry.title : ''));
  }
  var invite = document.getElementById('home-invite');
  if (invite) wireCreditLabels(invite);
  wireMagnet();

  var mini = els.featuredMini;
  var firstTime = !introDone;
  var wantDesk = !!(entry && mini && loadPuzzle && !reduced());
  // While the pieces load during the intro, keep the saved thumbnail hidden so
  // it does not flash in and then get swapped for the live desk.
  var waiting = false;
  if (firstTime && wantDesk) { mini.classList.add('desk-wait'); waiting = true; }
  var started = intro();
  if (!started) { mini && mini.classList.remove('desk-wait'); waiting = false; }
  showLive(entry ? entry.id : '', started);

  if (!wantDesk) return;
  if (desk && desk.id === entry.id && desk.mini === mini) {
    // renderMenu refills the mini (saved thumbnail first); put the pieces back on top.
    if (!mini.contains(desk.layer)) mini.appendChild(desk.layer);
    mini.classList.add('is-live');
    scaleDesk();
    return;
  }
  var giveUp = waiting ? setTimeout(function () { mini.classList.remove('desk-wait'); }, 1600) : 0;
  loadPuzzle(entry).then(function (puzzle) {
    if (!puzzle || puzzle.id !== entry.id) throw new Error('puzzle mismatch');
    return buildDesk(mini, puzzle);
  }).then(function (d) {
    if (desk && desk.layer !== d.layer && desk.layer.parentNode) desk.layer.parentNode.removeChild(desk.layer);
    desk = d;
    if (deskResize) deskResize.observe(mini);
    scaleDesk();
    mini.classList.add('is-live');
    wireDeskHover(mini);
    clearTimeout(giveUp);
    var late = (performance.now() - introAt) / 1000;
    if (waiting && mini.classList.contains('desk-wait')) dropTiles(Math.max(0, 0.5 - late));
    mini.classList.remove('desk-wait');
  }).catch(function () {
    clearTimeout(giveUp);
    mini.classList.remove('desk-wait', 'is-live');
  });
}
