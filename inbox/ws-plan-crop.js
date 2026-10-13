/* Puzzle workspace: crop a picture to the shape the game draws it in (the same
   crop window as the Puzzle Studio: drag to move, scroll/pinch/slider to zoom,
   arrow keys, "Fit whole image" / "Fill the frame"). Resolves with a WebP blob
   (JPEG where the browser can't make WebP), at most 1200 px on the long side,
   or null when cancelled. */
import { $, esc, openModal } from './ws-core.js';

export const ZONE_ASPECT = { photo: 86 / 102, tubes: 118 / 148, rack: 430 / 300 };
const WHERE = { photo: 'Photograph on the bench', rack: 'Microscope view', tubes: 'X-ray on the light box' };
const MAX_SIDE = 1200, CROP_W = 600;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Signed links are on another site: ask for CORS so the crop can be saved.
    if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });
}
function toBlob(c, q) {
  return new Promise((res) => c.toBlob((b) => {
    if (b && b.type === 'image/webp') res(b); else c.toBlob((j) => res(j), 'image/jpeg', q);
  }, 'image/webp', q));
}

export function cropImage(src, zone, title) {
  return new Promise((resolve) => {
    loadImage(src).then((img) => {
      const ar = ZONE_ASPECT[zone] || 1, cw = CROP_W, ch = Math.round(CROP_W / ar);
      const cover = Math.max(cw / img.naturalWidth, ch / img.naturalHeight), contain = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
      const k = { zoom: 1, minZoom: Math.min(1, contain / cover), offX: 0, offY: 0, bg: zone === 'photo' ? '#fdfcf6' : '#111318' };
      const scale = () => cover * k.zoom;
      const clamp = () => {
        const s = scale(), w = img.naturalWidth * s, h = img.naturalHeight * s;
        k.offX = w >= cw ? Math.min(0, Math.max(cw - w, k.offX)) : (cw - w) / 2;
        k.offY = h >= ch ? Math.min(0, Math.max(ch - h, k.offY)) : (ch - h) / 2;
      };
      const paint = (ctx, f) => {
        ctx.fillStyle = k.bg; ctx.fillRect(0, 0, cw * f, ch * f);
        const s = scale() * f; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, k.offX * f, k.offY * f, img.naturalWidth * s, img.naturalHeight * s);
      };
      let done = false, m = null;
      const draw = () => { const c = $('#cr-canvas', m); if (!c) return; paint(c.getContext('2d'), 1); $('#cr-zoom', m).value = String(k.zoom); $('#cr-pct', m).textContent = Math.round(k.zoom * 100) + '%'; };
      const zoomTo = (z, cx, cy) => {
        const before = scale(); k.zoom = Math.min(5, Math.max(k.minZoom, z)); const after = scale();
        if (cx === undefined) { cx = cw / 2; cy = ch / 2; }
        k.offX = cx - (cx - k.offX) * (after / before); k.offY = cy - (cy - k.offY) * (after / before); clamp(); draw();
      };
      const fill = () => { k.zoom = 1; k.offX = (cw - img.naturalWidth * cover) / 2; k.offY = (ch - img.naturalHeight * cover) / 2; clamp(); draw(); };
      const close = openModal('<div class="stack crop-modal" style="--gap:12px"><h2 id="modal-h">' + esc(title || 'Crop the image') + '</h2>' +
        '<p class="eyebrow">In the game: ' + esc(WHERE[zone] || 'Picture') + '</p>' +
        '<div class="crop-stage" style="aspect-ratio:' + cw + ' / ' + ch + '"><canvas id="cr-canvas" tabindex="0" width="' + cw + '" height="' + ch + '" aria-label="Crop area. Drag or use the arrow keys to move the image."></canvas></div>' +
        '<label class="row" style="--gap:10px"><span class="hint" style="flex:none">Zoom</span><input type="range" id="cr-zoom" class="grow" min="' + k.minZoom.toFixed(3) + '" max="5" step="0.01" value="1"><span id="cr-pct" class="hint">100%</span></label>' +
        '<div class="row" style="--gap:6px"><button class="btn small" type="button" id="cr-fit">Fit whole image</button><button class="btn small" type="button" id="cr-fill">Fill the frame</button></div>' +
        '<p class="hint">Drag to move the image. Scroll, pinch, or use the slider to zoom.</p>' +
        '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button><button class="btn primary" type="button" id="cr-ok">Use this crop</button></div></div>',
      (mm, closeIt) => {
        m = mm; m.classList.add('wide');
        const c = $('#cr-canvas', m), ptrs = new Map(); let pinch = 0;
        const at = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * cw / r.width, (e.clientY - r.top) * ch / r.height]; };
        c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, at(e)); pinch = 0; });
        c.addEventListener('pointermove', (e) => {
          if (!ptrs.has(e.pointerId)) return;
          const p = at(e), prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, p);
          if (ptrs.size === 2) { const [a, b] = Array.from(ptrs.values()), d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomTo(k.zoom * d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); pinch = d; return; }
          k.offX += p[0] - prev[0]; k.offY += p[1] - prev[1]; clamp(); draw();
        });
        const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; };
        c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
        c.addEventListener('wheel', (e) => { e.preventDefault(); const p = at(e); zoomTo(k.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p[0], p[1]); }, { passive: false });
        c.addEventListener('keydown', (e) => {
          const d = { ArrowLeft: [12, 0], ArrowRight: [-12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] }[e.key]; if (!d) return;
          e.preventDefault(); k.offX += d[0]; k.offY += d[1]; clamp(); draw();
        });
        $('#cr-zoom', m).addEventListener('input', (e) => zoomTo(Number(e.target.value)));
        $('#cr-fit', m).addEventListener('click', () => zoomTo(k.minZoom));
        $('#cr-fill', m).addEventListener('click', fill);
        $('#cr-ok', m).addEventListener('click', async () => {
          const f = Math.max(0.2, Math.min(MAX_SIDE / Math.max(cw, ch), 1 / scale()));
          const out = document.createElement('canvas'); out.width = Math.round(cw * f); out.height = Math.round(ch * f);
          paint(out.getContext('2d'), f);
          const blob = await toBlob(out, 0.85);
          done = true; closeIt(); resolve(blob);
        });
        // Closing any other way (Cancel, Escape, outside click) means no crop.
        const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); if (!done) resolve(null); } });
        obs.observe($('#modal-root'), { childList: true });
        fill();
      });
      if (!close) resolve(null);
    }, () => resolve(null));
  });
}
