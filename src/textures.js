/* ════════════════════════════════════════════════════════════════════
 * textures.js — skeuomorphic texture loading, alpha-trim, skin picking.
 *
 * Imports: state.js (state, els, versioned, hashString, mulberry32).
 *
 * loadTextures(onLoaded) accepts an optional callback fired after each
 * texture loads — lets ui-play.js re-sync pieces without creating a
 * circular import (textures.js does NOT import ui-play.js).
 * ════════════════════════════════════════════════════════════════════ */

import { state, els, versioned, hashString, mulberry32 } from './state.js';

export var TEXTURE_VARS = {
  'desk.webp': '--tex-desk',
  'sticky.webp': '--tex-sticky',
  'sticky-pink.webp': '--tex-sticky-pink',
  'sticky-green.webp': '--tex-sticky-green',
  'sticky-orange.webp': '--tex-sticky-orange',
  'sticky-2.webp': '--tex-sticky-2',
  'sticky-3.webp': '--tex-sticky-3',
  'paper.webp': '--tex-paper',
  'paper-2.webp': '--tex-paper-2',
  'slide.webp': '--tex-slide',
  'film.webp': '--tex-film',
  'photo.webp': '--tex-photo',
  'photo-2.webp': '--tex-photo-2',
  'rx.webp': '--tex-rx',
  'rx-2.webp': '--tex-rx-2',
};

export var TEXTURE_VARIANTS = {
  corkboard: ['sticky.webp', 'sticky-2.webp', 'sticky-3.webp'],
  folder: ['paper.webp', 'paper-2.webp'],
  photo: ['photo.webp', 'photo-2.webp'],
  rx: ['rx.webp', 'rx-2.webp'],
};

/**
 * Runtime alpha-trim: only the non-transparent bounding box of a texture
 * becomes the effective texture. Returns { url, w, h } or null.
 */
export function alphaTrimInfo(img) {
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
    if (maxX < 0) return null;
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
    return null;
  }
}

/**
 * Load textures from assets/textures/. Calls onLoaded() after each
 * successful texture load so the caller (main.js) can re-sync pieces.
 * onLoaded is optional — omit when no sync is needed.
 */
export function loadTextures(onLoaded) {
  var root = document.documentElement;
  state.textureAspect = state.textureAspect || {};
  fetch(versioned('assets/textures/manifest.json'))
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (m) {
      var present = (m && Array.isArray(m.present) && m.present.length)
        ? new Set(m.present)
        : null;
      Object.keys(TEXTURE_VARS).forEach(function (f) {
        if (present && !present.has(f)) return;
        var img = new Image();
        img.onload = function () {
          if (!state.textures) state.textures = new Set();
          state.textures.add(f);
          var url = 'url("assets/textures/' + f + '")';
          if (f !== 'desk.webp') {
            var info = alphaTrimInfo(img);
            if (info) {
              if (info.url) url = 'url("' + info.url + '")';
              state.textureAspect[f] = info.w / info.h;
            }
          }
          root.style.setProperty(TEXTURE_VARS[f], url);
          document.body.classList.add('has-textures');
          if (f === 'desk.webp') els.deskSurface.classList.add('textured');
          if (onLoaded) onLoaded();
        };
        img.onerror = function () { /* not present — CSS look stands */ };
        img.src = 'assets/textures/' + f;
      });
    });
}

/** Sticky color variant for an authored color (hue-matched). */
export function stickyColorVariant(color) {
  var pick = 'sticky.webp';
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
      if (hue >= 15 && hue < 45) pick = 'sticky-orange.webp';
      else if (hue >= 90 && hue < 200) pick = 'sticky-green.webp';
      else if (hue >= 260 || hue < 15) pick = 'sticky-pink.webp';
    }
  }
  return pick;
}

/**
 * The seeded skin texture for a paper-family piece. Null when no texture applies.
 */
export function pickSkinTexVar(item, rng) {
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
