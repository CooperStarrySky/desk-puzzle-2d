/* tools/thumb-render.js — draws one puzzle's menu thumbnail (see thumb-render.html).
 *
 * Picks ~9 clues deterministically (seeded by puzzle id) with a mix of kinds,
 * scatters them in a loose 3 x 3 like the menu's generated mini desk, and sets
 * window.__thumbReady = true once fonts and every image have loaded (or
 * window.__thumbError = "<message>" if something failed).
 * Shows only what a new player already sees on the desk: note/slip/sheet
 * labels and clue pictures. Slide and film labels stay hidden (the game hides
 * them too), and nothing hints at groups.
 */
(function () {
  'use strict';
  var W = 800, H = 500, TILES = 9;
  var params = new URLSearchParams(location.search);
  var id = params.get('id') || '';
  var stage = document.getElementById('thumb');
  if (params.get('bg') === '1') stage.classList.add('bg');

  function fail(msg) { window.__thumbError = String(msg); }

  // Same hash + PRNG family the game uses for its starting scatter.
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
  var rng = mulberry32(hashString('thumb:' + id));
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function asset(p) { return !p ? '' : /^(data:|https?:)/.test(p) ? p : '../' + p.replace(/^\/+/, ''); }

  /** Tile kind for an item, or null when it has nothing safe to show. */
  function kindOf(item) {
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

  // Tile sizes (px on the 800 x 500 stage).
  var SIZE = {
    note: [168, 148], rx: [168, 160], sheet: [160, 176],
    photo: [176, 160], slide: [228, 92], film: [148, 172],
  };

  /** Round-robin over kinds (kind order and items within a kind are seeded)
      so every thumbnail shows a mix, e.g. notes, photos, slides and films. */
  function pick(items) {
    var byKind = {};
    items.forEach(function (it) {
      var k = kindOf(it);
      if (k) (byKind[k] = byKind[k] || []).push(it);
    });
    var kinds = shuffle(Object.keys(byKind).sort());
    kinds.forEach(function (k) { shuffle(byKind[k]); });
    var out = [];
    while (out.length < TILES) {
      var added = false;
      for (var i = 0; i < kinds.length && out.length < TILES; i++) {
        var it = byKind[kinds[i]].shift();
        if (it) { out.push({ item: it, kind: kinds[i] }); added = true; }
      }
      if (!added) break;
    }
    return shuffle(out);
  }

  function labelText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /** Shrink the label until it fits its tile. Past the floor, drop words
      from the end and add an ellipsis (whole words only, so a long word is
      never split mid-word unless it alone is wider than the tile). */
  function fitLabel(lbl, span, start, floor) {
    var cs = getComputedStyle(lbl);
    var room = lbl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var fits = function () { return span.scrollWidth <= span.clientWidth && span.scrollHeight <= room; };
    for (var fs = start; fs >= floor; fs--) {
      span.style.fontSize = fs + 'px';
      if (fits()) return;
    }
    // A single word that is too wide: shrink a little further before giving up.
    if (span.textContent.indexOf(' ') < 0) {
      for (var f2 = floor - 1; f2 >= 16 && !fits(); f2--) span.style.fontSize = f2 + 'px';
    }
    var words = span.textContent.split(' ');
    var SMALL = /^(a|an|the|in|of|on|and|or|to|with|for|by|at)$/i;
    while (words.length > 1 && !fits()) {
      words.pop();
      while (words.length > 1 && SMALL.test(words[words.length - 1])) words.pop();
      span.textContent = words.join(' ').replace(/[,;:]$/, '') + '\u2026';
    }
    if (!fits()) span.style.overflowWrap = 'anywhere';
  }

  function makeTile(entry, idx) {
    var it = entry.item, kind = entry.kind, sz = SIZE[kind];
    var col = idx % 3, row = Math.floor(idx / 3);
    var cx = (col + 0.5) * (W / 3) + (rng() - 0.5) * 44;
    var cy = (row + 0.5) * (H / 3) + (rng() - 0.5) * 26;
    var left = Math.min(Math.max(cx - sz[0] / 2, 8), W - sz[0] - 8);
    var top = Math.min(Math.max(cy - sz[1] / 2, 8), H - sz[1] - 8);
    var el = document.createElement('div');
    el.className = 't t-' + kind;
    el.style.left = left.toFixed(1) + 'px';
    el.style.top = top.toFixed(1) + 'px';
    el.style.width = sz[0] + 'px';
    el.style.height = sz[1] + 'px';
    el.style.transform = 'rotate(' + ((rng() - 0.5) * 16).toFixed(1) + 'deg)';
    var imgs = [];
    function img(src, parent) {
      var im = document.createElement('img');
      im.alt = '';
      im.decoding = 'sync';
      im.src = asset(src);
      (parent || el).appendChild(im);
      imgs.push(im);
    }
    if (kind === 'photo') img(it.info.image);
    else if (kind === 'film') img(it.info.image);
    else if (kind === 'slide') {
      var smear = document.createElement('div');
      smear.className = 'smear';
      el.appendChild(smear);
      img(it.scope.image, smear);
    } else {
      var lbl = document.createElement('div');
      lbl.className = 'lbl';
      var span = document.createElement('span');
      span.textContent = labelText(it.label);
      lbl.appendChild(span);
      el.appendChild(lbl);
      el._fit = function () { fitLabel(lbl, span, kind === 'note' ? 36 : 30, 22); };
    }
    stage.appendChild(el);
    return { el: el, imgs: imgs };
  }

  function loaded(im) {
    if (im.complete && im.naturalWidth > 0) return Promise.resolve();
    return new Promise(function (res, rej) {
      im.addEventListener('load', res, { once: true });
      im.addEventListener('error', function () { rej(new Error('image failed to load: ' + im.getAttribute('src'))); }, { once: true });
    }).then(function () { return im.decode ? im.decode().catch(function () {}) : null; });
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  getJson('../puzzles/index.json').then(function (reg) {
    var entry = (reg.puzzles || []).find(function (p) { return p.id === id; });
    if (!entry) throw new Error('no puzzle with id "' + id + '" in puzzles/index.json');
    return getJson('../puzzles/' + entry.file);
  }).then(function (puzzle) {
    var chosen = pick(puzzle.items || []);
    if (!chosen.length) throw new Error('puzzle has no clues that can be drawn');
    var tiles = chosen.map(makeTile);
    var imgs = [].concat.apply([], tiles.map(function (t) { return t.imgs; }));
    return (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      tiles.forEach(function (t) { if (t.el._fit) t.el._fit(); });
      return Promise.all(imgs.map(loaded));
    }).then(function () {
      window.__thumbTiles = chosen.map(function (c) { return c.kind + ':' + c.item.id; });
      requestAnimationFrame(function () { requestAnimationFrame(function () { window.__thumbReady = true; }); });
    });
  }).catch(fail);
})();
