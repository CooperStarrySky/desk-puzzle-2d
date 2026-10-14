/* Puzzle workspace: the "Edit for this puzzle" pickers and wiring. Replace
   image (upload a file or re-crop the current one, cropped to the piece's
   shape, saved in the private bucket under drafts/<draft id>/) and "Swap in a
   clue" (search the Category database, take one clue from another category).
   wireAdapt() handles every click and keystroke of the editor and the
   "Adapted · N changes" panel inside #slots. */
import { S, $, esc, busy, toast, openModal, slug, signedUrl, isStoragePath, plainError, lc, BUCKET, ZONES } from './ws-core.js';
import { slotsOf, libraryPool } from './ws-plan-data.js';
import { refresh, current, readOnly } from './ws-plan-editor.js';
import { AD, isImg, picOf, setPic, origOf, clone, changes, revertPart, tidy, editing, startEdit, stopEdit, commit } from './ws-plan-adapt.js';
import { cropImage } from './ws-plan-crop.js';

async function upload(d, label, blob) {
  const session = AD.edit;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = 'drafts/' + d.id + '/' + (slug(label).slice(0, 40) || 'clue') + '-' + Date.now().toString(36) + '.' + ext;
  const { error } = await S.sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) { toast('Could not upload the image: ' + plainError(error), 6000); return ''; }
  if (AD.w && AD.edit === session) { AD.up.push(path); return path; } // removed again if this edit is cancelled
  // The edit ended while the picture was uploading: tidy it away at once.
  S.sb.storage.from(BUCKET).remove([path]).catch(() => {});
  return '';
}
async function cropAndUse(d, i, src, again) {
  const c = AD.w && AD.w.items[i]; if (!c) return;
  const blob = await cropImage(src, c.zone, 'Crop the image for ‘' + c.label + '’');
  if (!blob) { again('[data-adimg="' + i + '"]'); return; }
  toast('Uploading…', 8000);
  const path = await upload(d, c.label, blob);
  if (!path || !AD.w) { again('[data-adimg="' + i + '"]'); return; }
  setPic(AD.w.items[i], path); delete AD.w.items[i].swap;
  toast('New image ready. Save to keep it.');
  again('[data-adimg="' + i + '"]');
}
function imagePicker(d, i, again) {
  const c = AD.w.items[i], cur = picOf(c);
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Replace the image for ‘' + esc(c.label) + '’</h2>' +
    '<p class="muted">The new image is only for this puzzle. You’ll crop it to the shape of the ' + esc((ZONES[c.zone] || ['piece'])[0].toLowerCase()) + ' next.</p>' +
    '<label class="field"><span>Upload a picture</span><input class="input" type="file" id="ip-file" accept="image/*"></label>' +
    (cur ? '<p><button type="button" class="btn" id="ip-recrop">Crop the current image again</button></p>' : '') +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button></div></div>', (m) => {
    $('#ip-file', m).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) { toast('That file is not an image.'); return; }
      cropAndUse(d, i, URL.createObjectURL(f), again);
    });
    const rc = $('#ip-recrop', m);
    if (rc) rc.addEventListener('click', async () => { const src = isStoragePath(cur) ? await signedUrl(cur) : cur; if (!src) { toast('Could not open that image.'); return; } cropAndUse(d, i, src, again); });
  });
}
const hayOf = (it) => lc([it.name, it.explanation].concat(it.items.map((c) => c.label)).join(' \n '));
function swapPicker(d, i, again) {
  const s = slotsOf(d.id)[Number(AD.edit.split(':')[1])], own = s && origOf(s.item).sid;
  const pool = libraryPool().filter((it) => it.status !== 'trashed' && it.status !== 'declined' && it.sid !== own && it.items.length);
  openModal('<div class="stack" style="--gap:10px"><h2 id="modal-h">Swap clue ' + (i + 1) + ' (‘' + esc(AD.w.items[i].label) + '’)</h2>' +
    '<p class="muted">Pick any clue from another category in the database. It replaces clue ' + (i + 1) + ' in this draft’s copy only.</p>' +
    '<label class="sr" for="sw-q">Search categories and clues</label><input class="input" id="sw-q" type="search" autocomplete="off" placeholder="Search categories and clues…">' +
    '<p class="result-n" id="sw-n" aria-live="polite"></p><ul class="sw-list" id="sw-list"></ul>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button></div></div>', (m, close) => {
    m.classList.add('wide');
    let q = '';
    const paint = () => {
      const l = pool.filter((it) => !q || q.split(/\s+/).every((w) => hayOf(it).includes(w)));
      $('#sw-n', m).textContent = 'Showing ' + Math.min(l.length, 15) + ' of ' + l.length + (l.length === 1 ? ' category' : ' categories');
      $('#sw-list', m).innerHTML = l.slice(0, 15).map((it) => '<li><b><span class="tierdot t' + (it.tier || 0) + '"></span> ' + esc(it.name) + '</b><div class="chips">' +
        it.items.map((c, j) => '<button type="button" class="chip" data-pk="' + esc(it.key) + '|' + j + '"><span aria-hidden="true">' + ((ZONES[c.zone] || [])[1] || '•') + '</span> ' + esc(c.label) + '</button>').join('') + '</div></li>').join('') ||
        '<li class="faint">Nothing matches.</li>';
    };
    $('#sw-q', m).addEventListener('input', (e) => { q = lc(e.target.value); paint(); });
    $('#sw-list', m).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pk]'); if (!b || !AD.w) return;
      const [key, j] = b.dataset.pk.split('|'), it = pool.find((x) => x.key === key), c = it && it.items[Number(j)]; if (!c) return;
      AD.w.items[i] = Object.assign(clone(c), { swap: { sid: it.sid, name: it.name } });
      close(); toast('Clue ' + (i + 1) + ' swapped. Save to keep it.'); again('[data-adsw="' + i + '"]');
    });
    paint();
  });
}
/* rerender(focusSelector): redraws the slots. */
export function wireAdapt(el, rerender) {
  const again = (sel) => { rerender(); const f = sel && $(sel); if (f) f.focus(); };
  const tierOf = () => Number(String(AD.edit || ':0').split(':')[1]);
  const orig = () => { const d = current(), s = d && slotsOf(d.id)[tierOf()]; return s ? origOf(s.item) : null; };
  el.addEventListener('input', (e) => {
    const x = e.target; if (!AD.w || !x.closest('.adapt-ed')) return;
    if (x.dataset.ad) AD.w[x.dataset.ad] = x.value;
    else if (x.dataset.adl) { const c = AD.w.items[Number(x.dataset.adl)]; c.label = x.value; c.info = Object.assign({}, c.info, { title: x.value }); }
  });
  el.addEventListener('change', (e) => {
    const x = e.target; if (!AD.w || !x.dataset.adz) return;
    const i = Number(x.dataset.adz), c = AD.w.items[i], o = orig(), had = picOf(Object.assign({}, c));
    c.zone = x.value;
    setPic(c, isImg(c.zone) ? had || (o && picOf(o.items[i])) || null : null);
    again('[data-adz="' + i + '"]');
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const d = current(); if (!d) return;
    const ds = b.dataset;
    if (ds.diff) { const k = d.id + ':' + ds.diff; AD.diff = AD.diff === k ? null : k; again('[data-diff="' + ds.diff + '"]'); return; }
    if (readOnly(d)) return;
    if (ds.adapt) { if (startEdit(d, Number(ds.adapt))) again('.adapt-ed [data-ad="name"]'); return; }
    if (ds.adcancel) { stopEdit(); again('[data-adapt="' + ds.adcancel + '"]'); return; }
    if (ds.adimg) { imagePicker(d, Number(ds.adimg), again); return; }
    if (ds.adsw) { swapPicker(d, Number(ds.adsw), again); return; }
    if (ds.adrv) { const o = orig(); if (o) { revertPart(AD.w, o, 'c' + ds.adrv); toast('Clue ' + (Number(ds.adrv) + 1) + ' is back to the original'); again('[data-adl="' + ds.adrv + '"]'); } return; }
    if (ds.adsave) {
      const t = Number(ds.adsave), o = orig(); if (!o || !editing(d, t)) return;
      busy(b, 'Saving…', async () => {
        const a = tidy(AD.w, o), msg = await commit(d, t, a); if (!msg) return;
        stopEdit(changes(o, a).length ? a : null); toast(msg, 4000); await refresh(); const f = $('[data-diff="' + t + '"]') || $('[data-adapt="' + t + '"]'); if (f) f.focus();
      });
      return;
    }
    if (ds.rv || ds.revert) {
      const [ts, key] = (ds.rv || ds.revert).split('|'), t = Number(ts), s = slotsOf(d.id)[t]; if (!s || !s.item.adapted) return;
      const o = origOf(s.item), a = clone(s.item.adapted);
      if (key) revertPart(a, o, key);
      const left = key ? changes(o, a).length : 0, label = key ? (changes(o, s.item.adapted).find((c) => c.key === key) || { label: 'That' }).label : '';
      busy(b, 'Resetting…', async () => {
        const msg = await commit(d, t, left ? a : null); if (!msg) return;
        if (!left) AD.diff = null;
        toast(key ? label + ' is back to the original' + (left ? '' : '. No changes left, so this is the original again.') : 'Back to the original “' + o.name + '”', 4000);
        await refresh(); const f = $('[data-diff="' + t + '"]') || $('[data-adapt="' + t + '"]'); if (f) f.focus();
      });
    }
  });
}
