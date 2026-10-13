/* Puzzle workspace: Archive dialogs. A category (where it was used, its clues,
   "Use in a draft…"), the draft-and-slot picker, and "Reuse as starting
   point" (a new draft holding a published puzzle's four groups as copies). */
import { $, $$, esc, busy, toast, openModal, TIER_WORDS, STATUS_WORDS, ZONE_NAMES } from './ws-core.js';
import { PL, DSTATUS, slotsOf, filledCount } from './ws-plan-data.js';
import { BANK, loadBank, schoolName, useInDraft, newDraft, reusePuzzle } from './ws-arch-data.js';
import { dayLabel } from './ws-plan-time.js';

const fmt = (d) => (d ? dayLabel(String(d).slice(0, 10), true) : '');
function usedLi(r, p) {
  const gi = r.uses.get(p.id), g = gi != null ? p.full[gi] : null;
  return '<li><span><b>' + esc(p.title) + '</b><br><span class="muted">Released ' + esc(fmt(p.date)) + (g ? ' · ' + esc(TIER_WORDS[g.tier] || '') + ' group' + (g.name !== r.name ? ' “' + esc(g.name) + '”' : '') : '') +
    ' · ' + esc(schoolName(p.school)) + '</span></span><button type="button" class="btn small" data-reuse="' + esc(p.id) + '">Reuse as starting point</button></li>';
}
export function openCategory(key, onChange) {
  const r = BANK.byKey.get(key); if (!r) return;
  const cr = r.credit && r.credit.name ? r.credit.name + (r.credit.line ? ' · ' + r.credit.line : '') : 'Anonymous or not recorded';
  openModal('<div class="stack arch-dlg" style="--gap:12px"><div class="stack" style="--gap:6px"><p class="eyebrow">Category</p><h2 id="modal-h">' + esc(r.name) + '</h2>' +
    '<div class="row t' + (r.tier || 0) + '" style="--gap:6px"><span class="tierdot" aria-hidden="true"></span><span>' + esc(TIER_WORDS[r.tier] || 'No tier') + '</span>' +
    '<span class="badge school">' + esc(schoolName(r.school)) + '</span>' + r.tags.map((t) => '<span class="tagchip">' + esc(t) + '</span>').join('') +
    '<span class="st st-' + esc(r.status) + '">' + esc(r.it ? STATUS_WORDS[r.status] || r.status : 'Published') + '</span><span>👍 ' + r.votes + '<span class="sr"> votes</span></span></div></div>' +
    '<dl class="kv"><dt>Credit</dt><dd>' + esc(cr) + '</dd>' + (r.parent ? '<dt>Part of</dt><dd>Full-puzzle suggestion “' + esc(r.parent) + '”</dd>' : '') +
    (r.it ? '<dt>Sent in</dt><dd>' + esc(fmt(r.date)) + '</dd>' : '') + '<dt>Explanation</dt><dd>' + (r.explanation ? esc(r.explanation) : '<span class="faint">None yet</span>') + '</dd></dl>' +
    '<section class="stack" style="--gap:6px"><h3 class="dlg-h">Used in ' + (r.usedN ? r.usedN + (r.usedN === 1 ? ' puzzle' : ' puzzles') : 'no published puzzle yet') + '</h3>' +
    (r.same ? '<p class="same-hint" id="cat-same">Same name as a used category: <b>' + esc(r.same.name) + '</b> (used ' + r.same.n + '×). Check it isn’t a repeat.</p>' : '') +
    (r.usedN ? '<ul class="pick-list used-list" id="cat-used">' + r.usedIn.map((p) => usedLi(r, p)).join('') + '</ul>' : '') + '</section>' +
    '<section class="stack" style="--gap:6px"><h3 class="dlg-h">Clues (' + r.items.length + ')</h3><ul class="clue-list" id="cat-clues">' + r.items.map((c) =>
      '<li><b>' + esc(c.label) + '</b> <span class="faint">' + esc(ZONE_NAMES[c.zone] || c.zone || '') + '</span>' + (c.info && c.info.text ? '<br><span class="muted">' + esc(c.info.text) + '</span>' : '') + '</li>').join('') + '</ul></section>' +
    '<div class="modal-actions">' + (r.it ? '<a class="btn" href="#s=' + encodeURIComponent(r.it.sid) + '" data-dismiss>Open the suggestion</a>' : '') +
    '<button type="button" class="btn" data-dismiss>Close</button><button type="button" class="btn primary" id="cat-use">Use in a draft…</button></div></div>', (m, close) => {
    $('#cat-use', m).addEventListener('click', () => { close(); openUse(r, onChange); });
    $$('[data-reuse]', m).forEach((b) => b.addEventListener('click', () => { const p = BANK.puzzles.find((x) => x.id === b.dataset.reuse); close(); if (p) openReuse(p); }));
  });
}

/* ===== Use in a draft ===== */
function tierOptions(r, draftId) {
  const sl = draftId ? slotsOf(draftId) : [null, null, null, null, null];
  const free = [1, 2, 3, 4].filter((t) => !sl[t]);
  const pick = r.tier && !sl[r.tier] ? r.tier : free[0] || r.tier || 1;
  return [1, 2, 3, 4].map((t) => {
    const s = sl[t], mine = s && r.it && s.item.key === r.it.key;
    const label = TIER_WORDS[t] + (!s ? ' (empty)' : mine ? ' (already here)' : ' (replaces “' + s.item.name + '”)');
    return '<option value="' + t + '"' + (t === pick ? ' selected' : '') + '>' + esc(label) + '</option>';
  }).join('');
}
/* reload: what to re-fetch after adding (the Archive's bank by default; the Category database passes loadPlanner). */
export function openUse(r, onChange, reload = loadBank) {
  const open = PL.drafts.filter((d) => d.status !== 'published').sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const first = open[0] ? open[0].id : '';
  openModal('<form class="stack" style="--gap:12px" id="use-form"><h2 id="modal-h">Use “' + esc(r.name) + '” in a draft</h2>' +
    (r.it ? '' : '<p class="hint">This category was made by hand for a published puzzle, so a copy of it goes into the slot. You can edit it there.</p>') +
    '<fieldset class="fgroup"><legend class="eyebrow">Draft</legend><div class="pick-list use-drafts">' + open.map((d) =>
      '<label class="radio use-d"><input type="radio" name="ud" value="' + esc(d.id) + '"' + (d.id === first ? ' checked' : '') + '><span><b>' + esc(d.title) + '</b> <span class="muted">' +
      esc(DSTATUS[d.status] || d.status) + ' · ' + filledCount(d.id) + '/4</span></span></label>').join('') +
    '<label class="radio use-d"><input type="radio" name="ud" value=""' + (first ? '' : ' checked') + '><span><b>A new draft</b></span></label></div></fieldset>' +
    '<label class="field" id="ud-new"' + (first ? ' hidden' : '') + '><span>New draft title</span><input class="input" id="ud-title" maxlength="120" value="' + esc('Draft with ' + r.name).slice(0, 120) + '"></label>' +
    '<label class="field"><span>Slot</span><select class="input" id="ud-tier">' + tierOptions(r, first) + '</select></label>' +
    '<p class="err" id="ud-err" role="alert" hidden></p>' +
    '<div class="modal-actions"><button type="button" class="btn" data-dismiss>Cancel</button><button type="submit" class="btn primary" id="ud-go">Add to draft</button></div></form>', (m, close) => {
    const did = () => { const x = $('input[name="ud"]:checked', m); return x ? x.value : ''; };
    $$('input[name="ud"]', m).forEach((x) => x.addEventListener('change', () => { $('#ud-new', m).hidden = !!did(); $('#ud-tier', m).innerHTML = tierOptions(r, did()); }));
    $('#use-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('#ud-go', m), 'Adding…', async () => {
        let id = did(); const tier = Number($('#ud-tier', m).value), title = $('#ud-title', m).value.trim();
        if (!id && !title) { const er = $('#ud-err', m); er.textContent = 'Give the new draft a title.'; er.hidden = false; $('#ud-title', m).focus(); return; }
        if (!id) id = await newDraft(title, r.tags[0] || null, null);
        if (!id || !(await useInDraft(r, id, tier))) { await reload(); if (onChange) onChange(); return; }
        await reload(); if (onChange) onChange();
        const d = PL.drafts.find((x) => x.id === id);
        close(); done(r, d || { id, title: title || 'the draft' }, tier);
      });
    });
  });
}
function done(r, d, tier) {
  toast('Added to ' + d.title);
  openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Added</h2><p>“' + esc(r.name) + '” is now the ' + esc(TIER_WORDS[tier]) + ' category in <b>' + esc(d.title) + '</b>.</p>' +
    '<div class="modal-actions"><button type="button" class="btn" data-dismiss>Keep browsing</button><a class="btn primary" href="#/planner/' + encodeURIComponent(d.id) + '" data-dismiss id="ud-open">Open the draft</a></div></div>');
}

/* ===== Reuse as starting point ===== */
export function openReuse(p) {
  openModal('<form class="stack" style="--gap:12px" id="reuse-form"><h2 id="modal-h">Reuse “' + esc(p.title) + '”</h2>' +
    '<p>This starts a new draft with these four groups already in their slots, as copies you can edit or swap out one at a time.</p>' +
    '<ul class="clue-list">' + p.full.map((g) => '<li class="t' + g.tier + '"><span class="tierdot" aria-hidden="true"></span> ' + esc(TIER_WORDS[g.tier] || '') + ': <b>' + esc(g.name) + '</b></li>').join('') + '</ul>' +
    (p.full.some((g) => g.items.some((c) => /^data:/.test((c.info && c.info.image) || '') || /^data:/.test((c.scope && c.scope.image) || ''))) ? '<p class="hint">Some images live inside this older puzzle file and are not copied. Those clues say so in their notes.</p>' : '') +
    '<label class="field"><span>New draft title</span><input class="input" id="rp-title" maxlength="120" value="' + esc(('Remix of ' + p.title).slice(0, 120)) + '"></label>' +
    '<p class="err" id="rp-err" role="alert" hidden></p>' +
    '<div class="modal-actions"><button type="button" class="btn" data-dismiss>Cancel</button><button type="submit" class="btn primary" id="rp-go">Create draft</button></div></form>', (m, close) => {
    $('#reuse-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('#rp-go', m), 'Creating…', async () => {
        const title = $('#rp-title', m).value.trim();
        if (!title) { const er = $('#rp-err', m); er.textContent = 'Give the new draft a title.'; er.hidden = false; return; }
        const id = await reusePuzzle(p, title);
        if (!id) return;
        close(); toast('Draft started from ' + p.title);
        location.hash = '#/planner/' + encodeURIComponent(id);
      });
    });
  });
}
