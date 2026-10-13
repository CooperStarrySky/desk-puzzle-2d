/* Puzzle workspace: one category opened in place in the Category database.
   👍, Add to draft / ⋯ (or Restore when trashed), facts, block tags, the full
   usage table and the drafts it sits in, the clues (or the "Fix the original"
   editor), edit history with Undo, history and comments. The database stamps
   who did what and writes the history lines itself. */
import { S, $, $$, esc, busy, toast, plainError, when, ago, avs, person, creditText, fillImages, isPuzzle, nidsOf, itemsOf,
  TIER_WORDS, ZONE_NAMES, schName, schFull, isCurator, canPlan, canFix, fmtDay } from './ws-core.js';
import { reload, redraw, votesOf, votesMine, voteSchools, BLOCKS } from './ws-suggest.js';
import { catMenu, addToDraft, restore, reasonDialog, trashNow } from './ws-cat-actions.js';
import { downloadOne } from './ws-import.js';
import { contentHtml } from './ws-clues.js';
import { fetchComments, commentsHtml, wireComments } from './ws-comments.js';

/* fixing = the id whose "Fix the original" editor is open. */
export const DS = { fixing: null };
let mountSeq = 0, lastMount = Promise.resolve();

/* Your own 👍: add it, or take it back. Reloads the counts afterwards. */
export async function toggleVote(id) {
  const mine = votesOf(id).includes(S.me);
  const { error } = mine ? await S.sb.from('votes').delete().eq('submission_id', id).eq('voter_email', S.me)
    : await S.sb.from('votes').insert({ submission_id: id });
  if (error) { toast('Could not save your 👍: ' + plainError(error), 5000); return false; }
  await reload();
  toast(mine ? 'Took back your 👍' : '👍 added');
  return true;
}

const SAID = { submitted: 'sent this in', shortlist: 'shortlisted it', decline: 'declined it', reopen: 'moved it back to New', used: 'marked it used',
  comment: 'commented', vote: 'gave it 👍', unvote: 'took back their 👍', add_to_draft: 'put it in a draft', remove_from_draft: 'took it out of a draft',
  publish: 'published it', trash: 'moved it to Trash', restore: 'restored it from Trash', edit: 'fixed the original', undo_edit: 'undid a fix', adapt: 'adapted a copy' };
const DOT = { trash: 'var(--danger)', decline: 'var(--danger)', restore: 'var(--ok)', used: 'var(--ink-soft)', vote: 'var(--tier-1)', unvote: 'var(--ink-faint)',
  comment: 'var(--tier-3)', submitted: 'var(--eosin)', edit: 'var(--warn)', undo_edit: 'var(--warn)' };
function historyHtml(r, evs) {
  if (!evs.length) return '<p class="muted">No history yet.</p>';
  return '<ol class="timeline">' + evs.map((e) => '<li style="--dot:' + (DOT[e.action] || 'var(--accent)') + '"><b>' +
    esc(e.actor_email ? person(e.actor_email).name : (r.credit_mode === 'named' && r.credit_name ? r.credit_name : 'A student')) + '</b> ' + esc(SAID[e.action] || e.action.replace(/_/g, ' ')) +
    (e.note && ['decline', 'comment', 'trash', 'edit', 'undo_edit', 'adapt'].includes(e.action) ? ': <q>' + esc(e.note) + '</q>' : '') +
    '<span class="when">' + esc(when(e.at)) + '</span></li>').join('') + '</ol>';
}
function tagsHtml(r) {
  const tags = r.tags || [], all = BLOCKS.concat(tags.filter((t) => !BLOCKS.includes(t)));
  if (!isCurator()) return '<section class="tag-ed"><h4 class="sd-h">Block / system tags</h4><p>' + (tags.length ? tags.map((t) => '<span class="tagchip">' + esc(t) + '</span>').join(' ') : '<span class="muted">None</span>') + '</p></section>';
  return '<section class="tag-ed"><h4 class="sd-h">Block / system tags</h4><div class="chips" role="group" aria-label="Tags">' +
    all.map((t) => '<button type="button" class="chip" data-tag="' + esc(t) + '" aria-pressed="' + tags.includes(t) + '">' + esc(t) + '</button>').join('') + '</div>' +
    '<div class="row" style="--gap:6px"><label class="sr" for="tg-new-' + esc(r.id) + '">New tag</label><input class="input tag-new" id="tg-new-' + esc(r.id) + '" maxlength="30" placeholder="Another tag" style="flex:1 1 120px">' +
    '<button type="button" class="btn small" data-act="tag-add">Add tag</button></div></section>';
}
function actionsHtml(r) {
  const vs = votesOf(r.id), mine = vs.includes(S.me), n = vs.length, sc = voteSchools(r.id);
  const meta = '<span class="vote-x" title="👍 from admins at every school, then just yours">' + n + ' admin' + (n === 1 ? '' : 's') + ' · ' + sc + ' school' + (sc === 1 ? '' : 's') +
    (S.school ? ' / ' + votesMine(r.id) + ' at ' + esc(schName(S.school)) : '') + '</span>';
  const vote = '<button type="button" class="btn vote-btn" data-act="vote" aria-pressed="' + mine + '"' + (r.status === 'trashed' ? ' disabled' : '') + '>👍 ' + n + '<span class="sr"> thumbs up</span></button>' + avs(vs) + meta;
  if (r.status === 'trashed') {
    const off = isCurator() ? '' : ' disabled title="Faculty can’t restore from Trash"';
    return '<div class="actions">' + vote + '<button type="button" class="btn primary" data-act="restore"' + off + '>Restore from Trash</button>' +
      '<button type="button" class="btn" data-act="why"' + off + '>' + (r.trash_reason ? 'Edit reason' : 'Add reason') + '</button></div>';
  }
  return '<div class="actions">' + vote + '<button type="button" class="btn primary" data-act="draft"' + (canPlan() ? '' : ' aria-disabled="true" title="Faculty can comment and approve drafts, but can’t add to them"') + '>Add to draft…</button>' + catMenu(r) + '</div>';
}
function factsHtml(r) {
  const nids = isPuzzle(r) ? [] : nidsOf(r.payload);
  return '<div class="sd-meta"><dl class="kv"><dt>Submitted by</dt><dd>' + esc(creditText(r)) + '</dd>' +
    '<dt>Contact</dt><dd>' + (r.contact_email ? '<a href="mailto:' + esc(r.contact_email) + '">' + esc(r.contact_email) + '</a> <span class="hint">(private, never put it in a puzzle file)</span>' : 'None given') + '</dd>' +
    '<dt>Sent</dt><dd>' + esc(when(r.created_at)) + ' (' + esc(ago(r.created_at)) + ')</dd>' +
    '<dt>Received by</dt><dd>' + esc(schFull(r.school)) + ' (' + esc(schName(r.school)) + ')</dd>' +
    '<dt>' + (isPuzzle(r) ? 'Kind' : 'Suggested') + '</dt><dd>' + (isPuzzle(r) ? 'Old full puzzle (before categories only)' : esc(TIER_WORDS[r.suggested_tier] || '?')) + '</dd>' +
    '<dt>Receipt</dt><dd class="code">' + esc(r.receipt_code) + '</dd>' +
    (r.source === 'published' ? '<dt>Source</dt><dd>From published puzzle <span class="code">' + esc(r.source_ref || '') + '</span></dd>' : '') +
    (r.used_in ? '<dt>Used in</dt><dd class="code">' + esc(r.used_in) + '</dd>' : '') +
    (r.status === 'trashed' ? '<dt>In Trash</dt><dd>Trashed by ' + esc(person(r.trashed_by).name) + (r.trashed_at ? ', ' + esc(when(r.trashed_at)) : '') + (r.trash_reason ? ' — <q>' + esc(r.trash_reason) + '</q>' : '') + '</dd>' : '') +
    (nids.length ? '<dt>Anki</dt><dd class="code">' + nids.map(esc).join(', ') + '</dd>' : '') + '</dl>' +
    tagsHtml(r) + '<p><button type="button" class="btn small ghost" data-act="dl">Download for import</button></p></div>';
}

/* ===== Usage: every published use, plus the drafts (that you may see) holding it ===== */
function usageHtml(uses, drafts) {
  const ad = uses.filter((u) => u.adapted).length, n = uses.length, schools = [...new Set(uses.map((u) => schName(u.school)))];
  const split = n - ad && ad ? (n - ad) + ' as-is, ' + ad + ' adapted' : ad ? 'adapted' : 'as-is';
  return '<p>' + (n ? 'Used ' + n + '× in published puzzles (' + split + ') · ' + esc(schools.join(', ')) : 'Never used in a published puzzle.') + '</p>' +
    (n ? '<div class="tbl-wrap"><table class="tbl use-tbl"><caption class="sr">Where this category was used</caption><thead><tr><th>Puzzle</th><th>Date</th><th>School</th><th>Version</th></tr></thead><tbody>' +
      uses.map((u) => '<tr><td class="code">' + esc(u.puzzle_id) + '</td><td>' + esc(u.puzzle_date ? fmtDay(u.puzzle_date + 'T12:00') : '') + '</td><td>' + esc(schName(u.school)) + '</td><td>' +
        (u.adapted ? '<span class="kind-tag adapted-tag">Adapted</span>' : 'As-is') + '</td></tr>').join('') + '</tbody></table></div>' : '') +
    '<p>' + (drafts.length ? 'In ' + drafts.length + ' draft' + (drafts.length > 1 ? 's' : '') + ': ' + drafts.map((d) => '<a href="#/planner/' + encodeURIComponent(d.id) + '">' + esc(d.title) + '</a> (' +
      esc(schName(d.school)) + (d.status === 'published' ? ', published' : '') + ')').join('; ')
      : '<span class="faint">Not in any draft' + (S.school && !S.owner ? ' at ' + esc(schName(S.school)) : '') + '.</span>') + '</p>';
}
async function fetchUsage(id) {
  const [uses, slots] = await Promise.all([
    S.sb.from('category_uses').select('puzzle_id, puzzle_date, school, adapted, published_at').eq('submission_id', id).order('published_at', { ascending: false }).limit(200),
    S.sb.from('draft_slots').select('draft_id').eq('submission_id', id).limit(200)]);
  if (uses.error || slots.error) throw uses.error || slots.error;
  const ids = [...new Set((slots.data || []).map((s) => s.draft_id))];
  let drafts = [];
  if (ids.length) {
    const d = await S.sb.from('drafts').select('id, title, status, school').in('id', ids);
    if (d.error) throw d.error;
    drafts = (d.data || []).filter((x) => x.status !== 'published');
  }
  return usageHtml(uses.data || [], drafts);
}

/* ===== Fix the original (logged, undoable) ===== */
const getPath = (p, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), p);
function pathLabel(path) {
  if (path === 'name') return 'the name';
  if (path === 'explanation') return 'the explanation';
  const m = /^items\.(\d)\.(.+)$/.exec(path);
  return m ? 'clue ' + (Number(m[1]) + 1) + ({ label: '', note: ' results note', source: ' image source', 'info.text': ' text' }[m[2]] || ' ' + m[2]) : path;
}
const snip = (v) => { const t = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return t.length > 70 ? t.slice(0, 67) + '…' : t; };
function fixHtml(r) {
  const g = r.payload || {};
  return '<section class="fix-ed" aria-label="Fix the original"><p class="fix-warn"><b>Editing the original in the Category database.</b> Every school sees this fix, and each change can be undone. ' +
    'To change it for one puzzle only, edit a copy in a draft.</p>' +
    '<label class="field"><span>Name</span><input class="input" data-fx="name" maxlength="120" value="' + esc(g.name || r.group_name) + '"></label>' +
    '<label class="field"><span>Explanation</span><textarea class="input" data-fx="explanation" maxlength="400" rows="3">' + esc(g.explanation || '') + '</textarea></label>' +
    itemsOf(g).map((it, i) => '<label class="field"><span>Clue ' + (i + 1) + ' · ' + esc(ZONE_NAMES[it.zone] || it.zone) + '</span><input class="input" data-fx="items.' + i + '.label" maxlength="80" value="' + esc(it.label) + '"></label>').join('') +
    '<div class="row" style="--gap:8px"><button type="button" class="btn primary" data-act="fxsave">Save fix</button><button type="button" class="btn" data-act="fxcancel">Cancel</button></div></section>';
}
function editsHtml(r, edits) {
  if (!edits.length) return '';
  return '<section><h4 class="sd-h">Edit history</h4><ol class="timeline edits">' + edits.map((e) => {
    const live = !e.undone_at && JSON.stringify(getPath(r.payload, e.path)) === JSON.stringify(e.new_value);
    return '<li' + (e.undone_at ? ' class="undone"' : '') + '><b>' + esc(person(e.editor_email).name) + '</b> changed ' + esc(pathLabel(e.path)) +
      ' ‘<del>' + esc(snip(e.old_value)) + '</del>’ → ‘<ins>' + esc(snip(e.new_value)) + '</ins>’' +
      (e.undone_at ? ' <span class="faint">· undone by ' + esc(person(e.undone_by).name) + '</span>' : canFix(r) && live ? ' · <button type="button" class="linkish" data-undo="' + esc(e.id) + '">Undo</button>' : '') +
      '<span class="when">' + esc(when(e.at)) + '</span></li>';
  }).join('') + '</ol></section>';
}
async function saveFix(root, r) {
  const patch = {};
  for (const el of $$('[data-fx]', root)) {
    const k = el.dataset.fx, v = el.value.trim(), old = getPath(r.payload, k) == null ? (k === 'name' ? r.group_name : '') : String(getPath(r.payload, k));
    if (!v && (k === 'name' || /label$/.test(k))) { toast('The name and clue labels can’t be empty.', 4500); el.focus(); return false; }
    if (v !== old) patch[k] = v;
  }
  if (!Object.keys(patch).length) { DS.fixing = null; toast('No changes to save'); return true; }
  const { data, error } = await S.sb.rpc('edit_submission', { p_id: r.id, p_patch: patch });
  if (error) { toast('Could not save the fix: ' + plainError(error), 6000); return false; }
  DS.fixing = null;
  toast('Saved ' + data + ' fix' + (data === 1 ? '' : 'es') + ' to the original. Undo is in Edit history.');
  return true;
}

function detailHtml(r) {
  const fixing = DS.fixing === r.id && canFix(r) && !isPuzzle(r);
  return actionsHtml(r) + factsHtml(r) + '<section class="usage-full" aria-label="Usage"><h4 class="sd-h">Usage</h4><div class="sd-use"><p class="muted">Loading usage…</p></div></section>' +
    (fixing ? fixHtml(r) : contentHtml(r)) + '<div class="sd-edits"></div>' +
    '<div class="sd-cols"><section><h4 class="sd-h">History</h4><div class="sd-hist"><p class="muted">Loading history…</p></div></section><div class="sd-cmts"><p class="muted">Loading comments…</p></div></div>';
}
async function saveTags(r, tags) {
  const { data, error } = await S.sb.from('submissions').update({ tags }).eq('id', r.id).select('id');
  if (error || !data || !data.length) { toast('Could not save the tags: ' + plainError(error || 'no permission'), 5000); return false; }
  return true;
}

/* Draws the open card's inside into box, then fills in usage, edits, history and comments. */
export function mountDetail(box, r) {
  const seq = ++mountSeq;
  if (DS.fixing && DS.fixing !== r.id) DS.fixing = null;
  box.innerHTML = '<div class="stack" style="--gap:16px">' + detailHtml(r) + '</div>';
  const root = box.firstElementChild;
  const again = async (sel) => {
    await reload(); redraw(); await lastMount;
    const card = document.getElementById('sd-' + r.id), el = card && sel && $(sel, card);
    if (el) el.focus(); else if (sel) { const t = document.getElementById('tg-' + r.id); if (t) t.focus(); }
  };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], [data-tag], [data-undo]'); if (!b || !root.contains(b) || b.closest('.sd-cmts')) return;
    const k = b.dataset.act;
    if (b.dataset.undo) {
      await busy(b, 'Undoing…', async () => {
        const { error } = await S.sb.rpc('undo_submission_edit', { p_edit_id: b.dataset.undo });
        if (error) { toast('Could not undo that: ' + plainError(error), 6000); return; }
        toast('Undone. The old text is back.'); await again('.sd-edits button, [data-act="vote"]');
      });
    } else if (b.dataset.tag != null) {
      const t = b.dataset.tag, cur = r.tags || [];
      const next = cur.includes(t) ? cur.filter((x) => x !== t) : cur.concat(t);
      await busy(b, '…', async () => { if (await saveTags(r, next)) { toast('Tags saved'); await again('[data-tag="' + CSS.escape(t) + '"]'); } });
    } else if (k === 'tag-add') {
      const inp = $('.tag-new', root), t = inp.value.trim().replace(/\s+/g, ' ');
      if (!t) { inp.focus(); return; }
      if ((r.tags || []).length >= 20) { toast('20 tags is the most one category can have.', 4000); return; }
      if ((r.tags || []).some((x) => x.toLowerCase() === t.toLowerCase())) { toast('It already has that tag.'); return; }
      await busy(b, 'Adding…', async () => { if (await saveTags(r, (r.tags || []).concat(t))) { toast('Tag added'); await again('.tag-new'); } });
    } else if (k === 'vote') {
      await busy(b, '…', () => toggleVote(r.id)); redraw(); await lastMount;
      const v = document.getElementById('sd-' + r.id); if (v) $('[data-act="vote"]', v).focus();
    } else if (k === 'draft') addToDraft(r);
    else if (k === 'restore') await busy(b, 'Restoring…', () => restore(r));
    else if (k === 'why') reasonDialog(r.id);
    else if (k === 'trash') trashNow(r);
    else if (k === 'fxcancel') { DS.fixing = null; redraw(); await lastMount; const m = document.querySelector('#sd-' + CSS.escape(r.id) + ' .mnu-btn'); if (m) m.focus(); }
    else if (k === 'fxsave') await busy(b, 'Saving…', async () => { if (await saveFix(root, r)) await again('.sd-edits button, [data-act="vote"]'); });
    else if (k === 'dl') await busy(b, 'Preparing…', () => downloadOne(r));
  });
  fillImages(root);
  lastMount = (async () => {
    const [evs, cmts, use, edits] = await Promise.allSettled([
      S.sb.from('review_events').select('actor_email, action, note, at').eq('submission_id', r.id).order('at', { ascending: true }).limit(500)
        .then((x) => { if (x.error) throw x.error; return x.data || []; }),
      fetchComments(r.id), fetchUsage(r.id),
      S.sb.from('submission_edits').select('id, editor_email, path, old_value, new_value, at, undone_by, undone_at').eq('submission_id', r.id).order('at', { ascending: false }).limit(200)
        .then((x) => { if (x.error) throw x.error; return x.data || []; })]);
    if (seq !== mountSeq || !root.isConnected) return;
    const fail = (x) => '<p class="err-box">' + esc(plainError(x.reason)) + '</p>';
    $('.sd-hist', root).innerHTML = evs.status === 'fulfilled' ? historyHtml(r, evs.value) : fail(evs);
    $('.sd-use', root).innerHTML = use.status === 'fulfilled' ? use.value : fail(use);
    $('.sd-edits', root).innerHTML = edits.status === 'fulfilled' ? editsHtml(r, edits.value) : fail(edits);
    const c = $('.sd-cmts', root);
    if (cmts.status !== 'fulfilled') { c.innerHTML = fail(cmts); return; }
    c.innerHTML = commentsHtml(r, cmts.value, { vis: true });
    wireComments(c, r, cmts.value, again);
  })();
  return lastMount;
}
