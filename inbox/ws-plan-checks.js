/* Puzzle workspace: a draft's checks. Blocking ones (an empty slot, a missing
   explanation, two clues with the same label) stop Mark ready, Schedule and
   Publish. Warnings (too like a category already published, more than 10
   image pieces) are advice: each can be dismissed for this draft (saved in
   drafts.dismissed_warnings) and brought back. The panel collapses. */
import { $, esc, busy, toast, lc } from './ws-core.js';
import { slotsOf, imageCount, patchDraft } from './ws-plan-data.js';
import { addPart, refresh, current, readOnly } from './ws-plan-editor.js';
import { dayLabel } from './ws-plan-time.js';

/* Published puzzles, from the site's own files (puzzles/index.json + each puzzle). */
export const ARCH = { current: '', list: [], loaded: false, err: '', p: null };
export function loadArchive() {
  if (ARCH.p) return ARCH.p;
  ARCH.p = (async () => {
    try {
      const idx = await (await fetch('../puzzles/index.json', { cache: 'no-cache' })).json();
      ARCH.current = idx.current || '';
      ARCH.list = await Promise.all((idx.puzzles || []).map(async (p) => {
        let groups = [];
        try { const j = await (await fetch('../puzzles/' + encodeURIComponent(p.file), { cache: 'no-cache' })).json(); groups = (j.groups || []).map((g) => String(g.name || '')); } catch (e) { /* one bad file: skip its names */ }
        return { id: p.id, title: p.title, date: p.date, groups };
      }));
      ARCH.loaded = true;
    } catch (e) { ARCH.err = 'Could not read the published puzzles list.'; ARCH.p = null; }
    return ARCH;
  })();
  return ARCH.p;
}

const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'in', 'to', 'that', 'with', 'for', 'causes', 'cause', 'findings', 'signs', 'features', 'things', 'manifestations', 'syndrome', 'symptoms', 'disorders', 'types']);
const sig = (t) => lc(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
/* Same name words (2+, or all of the old name's), or a clue named like an old category. */
function similar(it) {
  const mine = sig(it.name), labels = it.items.map((c) => lc(c.label)), hits = [];
  ARCH.list.forEach((p) => p.groups.forEach((name) => {
    const theirs = sig(name), shared = mine.filter((w) => theirs.includes(w));
    if ((shared.length && (shared.length >= 2 || shared.length === theirs.length)) || labels.includes(lc(name))) hits.push({ name, p });
  }));
  return hits;
}
/* [{ k, lvl: 'block'|'warn', msg }] */
export function draftChecks(d) {
  const out = [], seen = new Map(), sl = slotsOf(d.id);
  let imgs = 0, filled = 0;
  [1, 2, 3, 4].forEach((t) => {
    const it = sl[t] && sl[t].item, tw = ['', 'Easy', 'Medium', 'Hard', 'Hardest'][t];
    if (!it) { out.push({ k: 'empty-' + t, lvl: 'block', msg: 'The ' + tw + ' slot is empty.' }); return; }
    filled++;
    if (!it.explanation.trim()) out.push({ k: 'noex-' + it.key, lvl: 'block', msg: '“' + it.name + '” has no explanation for the results screen.' });
    it.items.forEach((c) => { const k = lc(c.label); if (!k) return; if (!seen.has(k)) seen.set(k, { label: c.label, in: [] }); seen.get(k).in.push(it.name); });
    imgs += imageCount(it);
    if (it.status !== 'used') similar(it).forEach((h) => out.push({ k: 'sim:' + it.key + ':' + lc(h.name), lvl: 'warn',
      msg: '“' + it.name + '” is similar to ‘' + h.name + '’ (' + h.p.title + ', ' + (h.p.date ? dayLabel(h.p.date, true) : 'published') + ').' }));
  });
  seen.forEach((v, k) => { if (v.in.length > 1) out.push({ k: 'dup-' + k, lvl: 'block', msg: 'Duplicate clue label “' + v.label + '” in ' + v.in.join(' and ') + '. Players can’t tell the two pieces apart.' }); });
  if (imgs > 10) out.push({ k: 'imgs', lvl: 'warn', msg: imgs + ' of ' + filled * 4 + ' pieces need images (aim for 10 or fewer). That’s a lot to find and makes the desk busy.' });
  return out;
}
export const blockers = (d) => draftChecks(d).filter((c) => c.lvl === 'block');

const UI = { open: true, showDis: false };
function li(c, i, restore, ro) {
  return '<li class="' + (c.lvl === 'block' ? 'block' : 'warn') + (restore ? ' dim' : '') + '"><span>' + esc(c.msg) + '</span>' +
    (c.lvl === 'block' ? '<span class="tag">Blocks publishing</span>' : ro ? '' : '<button type="button" class="btn small ghost" data-ck="' + i + '" data-on="' + (restore ? 0 : 1) + '">' + (restore ? 'Restore' : 'Dismiss') + '</button>') + '</li>';
}
function render(d) {
  const el = $('#ck-panel'); if (!el) return;
  el.hidden = false;
  const all = draftChecks(d), dis = Array.isArray(d.dismissed_warnings) ? d.dismissed_warnings : [], ro = readOnly(d);
  const act = all.filter((c) => !(c.lvl === 'warn' && dis.includes(c.k))).sort((a, b) => (a.lvl === 'block' ? 0 : 1) - (b.lvl === 'block' ? 0 : 1)), gone = all.filter((c) => c.lvl === 'warn' && dis.includes(c.k));
  const nb = act.filter((c) => c.lvl === 'block').length;
  el.innerHTML = '<div class="ck-head"><button type="button" class="ck-toggle" id="ck-toggle" aria-expanded="' + UI.open + '" aria-controls="ck-body">Checks <span class="chev" aria-hidden="true"></span></button>' +
    '<span class="ck-n' + (nb ? ' block' : act.length ? '' : ' ok') + '" id="ck-n">' + (act.length ? act.length + (act.length === 1 ? ' issue' : ' issues') + (nb ? ' · ' + nb + ' blocking' : '') : 'All clear') + '</span></div>' +
    '<div class="stack" id="ck-body" style="--gap:8px"' + (UI.open ? '' : ' hidden') + '><ul class="checks" id="checks" aria-live="polite">' +
    (act.length ? act.map((c) => li(c, all.indexOf(c), false, ro)).join('') : '<li class="ok"><span>No problems found. All four slots are filled and nothing clashes.</span></li>') + '</ul>' +
    (gone.length ? '<div class="stack" style="--gap:6px"><div><button type="button" class="btn small ghost" id="ck-dis" aria-expanded="' + UI.showDis + '">' + (UI.showDis ? 'Hide dismissed' : 'Show ' + gone.length + ' dismissed') + '</button></div>' +
      (UI.showDis ? '<ul class="checks">' + gone.map((c) => li(c, all.indexOf(c), true, ro)).join('') + '</ul>' : '') + '</div>' : '') +
    (ARCH.err ? '<p class="hint">' + esc(ARCH.err) + ' The “similar to” check is off for now.</p>' : '') + '</div>';
}
function mount() {
  const el = $('#ck-panel'); if (!el) return;
  el.addEventListener('click', async (e) => {
    const d = current(); if (!d) return;
    if (e.target.closest('#ck-toggle')) { UI.open = !UI.open; render(d); $('#ck-toggle').focus(); return; }
    if (e.target.id === 'ck-dis') { UI.showDis = !UI.showDis; render(d); $('#ck-dis').focus(); return; }
    const b = e.target.closest('[data-ck]'); if (!b) return;
    const c = draftChecks(d)[Number(b.dataset.ck)]; if (!c) return;
    const cur = Array.isArray(d.dismissed_warnings) ? d.dismissed_warnings : [];
    const next = b.dataset.on === '1' ? cur.concat(c.k) : cur.filter((k) => k !== c.k);
    await busy(b, 'Saving…', async () => {
      if (!(await patchDraft(d.id, { dismissed_warnings: next }, 'Could not save that'))) return;
      toast(b.dataset.on === '1' ? 'Warning dismissed for this draft' : 'Warning restored');
      await refresh();
      const f = $('#ck-panel [data-ck]') || $('#ck-dis') || $('#ck-toggle'); if (f) f.focus();
    });
  });
  loadArchive().then(() => { const d = current(); if (d && $('#ck-panel')) render(d); });
}
addPart({ mount, update: render });
