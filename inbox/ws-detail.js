/* Puzzle workspace: one suggestion opened in place. Review actions, tags,
   history and comments. Status changes send only status (+ reason / puzzle id);
   the database stamps who did it and writes the history line itself. */
import { S, $, $$, esc, busy, toast, plainError, openModal, when, ago, av, avs, person, creditText, fillImages,
  isPuzzle, nidsOf, TIER_WORDS } from './ws-core.js';
import { reload, redraw, votesOf, BLOCKS } from './ws-suggest.js';
import { downloadOne } from './ws-import.js';
import { contentHtml } from './ws-clues.js';
import { fetchComments, commentsHtml, wireComments } from './ws-comments.js';

let mountSeq = 0, lastMount = Promise.resolve();

/* Your own 👍: add it, or take it back. Reloads the counts afterwards. */
export async function toggleVote(id) {
  const mine = votesOf(id).includes(S.me);
  const { error } = mine ? await S.sb.from('votes').delete().eq('submission_id', id).eq('voter_email', S.me)
    : await S.sb.from('votes').insert({ submission_id: id });
  if (error) { toast('Could not save your 👍: ' + plainError(error), 5000); return false; }
  await reload(true);
  toast(mine ? 'Took back your 👍' : '👍 added');
  return true;
}

const SAID = { submitted: 'sent this in', shortlist: 'shortlisted it', decline: 'declined it', reopen: 'moved it back to New', used: 'marked it used',
  comment: 'commented', vote: 'gave it 👍', unvote: 'took back their 👍', add_to_draft: 'put it in a draft', remove_from_draft: 'took it out of a draft', publish: 'published it' };
const DOT = { shortlist: 'var(--ok)', decline: 'var(--danger)', used: 'var(--ink-soft)', vote: 'var(--tier-1)', unvote: 'var(--ink-faint)', comment: 'var(--tier-3)', submitted: 'var(--eosin)' };
function historyHtml(r, evs) {
  if (!evs) return '<p class="muted">Loading history…</p>';
  if (!evs.length) return '<p class="muted">No history yet.</p>';
  return '<ol class="timeline">' + evs.map((e) => '<li style="--dot:' + (DOT[e.action] || 'var(--accent)') + '"><b>' +
    esc(e.actor_email ? person(e.actor_email).name : (r.credit_mode === 'named' && r.credit_name ? r.credit_name : 'A student')) + '</b> ' + esc(SAID[e.action] || e.action) +
    (e.note && (e.action === 'decline' || e.action === 'comment') ? ': <q>' + esc(e.note) + '</q>' : '') +
    '<span class="when">' + esc(when(e.at)) + '</span></li>').join('') + '</ol>';
}
function tagsHtml(r) {
  const tags = r.tags || [], all = BLOCKS.concat(tags.filter((t) => !BLOCKS.includes(t)));
  return '<section class="tag-ed"><h4 class="sd-h">Block / system tags</h4><div class="chips" role="group" aria-label="Tags">' +
    all.map((t) => '<button type="button" class="chip" data-tag="' + esc(t) + '" aria-pressed="' + tags.includes(t) + '">' + esc(t) + '</button>').join('') + '</div>' +
    '<div class="row" style="--gap:6px"><label class="sr" for="tg-new-' + esc(r.id) + '">New tag</label><input class="input tag-new" id="tg-new-' + esc(r.id) + '" maxlength="30" placeholder="Another tag" style="flex:1 1 120px">' +
    '<button type="button" class="btn small" data-act="tag-add">Add tag</button></div></section>';
}
function detailHtml(r) {
  const vs = votesOf(r.id), btn = (k, label, cls) => '<button type="button" class="btn ' + (cls || '') + '" data-act="' + k + '">' + label + '</button>';
  const nids = isPuzzle(r) ? [] : nidsOf(r.payload);
  return '<div class="actions"><button type="button" class="btn vote-btn" data-act="vote" aria-pressed="' + vs.includes(S.me) + '">👍 ' + vs.length + '<span class="sr"> thumbs up</span></button>' + avs(vs) +
    (r.status !== 'shortlisted' ? btn('shortlisted', 'Shortlist', 'primary') : '') + (r.status !== 'declined' ? btn('declined', 'Decline…', 'danger') : '') +
    (r.status !== 'new' ? btn('new', 'Back to new') : '') + (r.status !== 'used' ? btn('used', 'Mark used…') : '') + btn('dl', 'Download for import') + '</div>' +
    '<div class="sd-meta"><dl class="kv"><dt>Submitted by</dt><dd>' + esc(creditText(r)) + '</dd>' +
    '<dt>Contact</dt><dd>' + (r.contact_email ? '<a href="mailto:' + esc(r.contact_email) + '">' + esc(r.contact_email) + '</a> <span class="hint">(private, never put it in a puzzle file)</span>' : 'None given') + '</dd>' +
    '<dt>Sent</dt><dd>' + esc(when(r.created_at)) + ' (' + esc(ago(r.created_at)) + ')</dd>' +
    '<dt>' + (isPuzzle(r) ? 'Kind' : 'Suggested') + '</dt><dd>' + (isPuzzle(r) ? 'Full puzzle, 4 groups' : esc(TIER_WORDS[r.suggested_tier] || '?')) + '</dd>' +
    '<dt>Receipt</dt><dd class="code">' + esc(r.receipt_code) + '</dd>' + (r.used_in ? '<dt>Used in</dt><dd class="code">' + esc(r.used_in) + '</dd>' : '') +
    (r.admin_note ? '<dt>Group note</dt><dd>' + esc(r.admin_note) + '</dd>' : '') + (nids.length ? '<dt>Anki</dt><dd class="code">' + nids.map(esc).join(', ') + '</dd>' : '') + '</dl>' +
    tagsHtml(r) + '</div>' + contentHtml(r) +
    '<div class="sd-cols"><section><h4 class="sd-h">History</h4><div class="sd-hist">' + historyHtml(r, null) + '</div></section><div class="sd-cmts"><p class="muted">Loading comments…</p></div></div>';
}

async function setStatus(r, status, extra) {
  const patch = Object.assign({ status }, status === 'shortlisted' || status === 'new' ? { admin_note: null } : {}, extra || {});
  const { data, error } = await S.sb.from('submissions').update(patch).eq('id', r.id).select('id');
  if (error || !data || !data.length) { toast('Could not save that: ' + plainError(error || 'no permission'), 5000); return false; }
  toast({ shortlisted: 'Shortlisted', used: 'Marked as used', declined: 'Declined', new: 'Moved back to New' }[status]);
  return true;
}
function statusDialog(r, status, done) {
  const used = status === 'used';
  openModal('<form class="stack" style="--gap:12px" id="m-form" novalidate><h2 id="modal-h">' + (used ? 'Mark as used' : 'Decline “' + esc(r.group_name) + '”') + '</h2>' +
    (used ? '<label class="field"><span>Which puzzle is it in? (puzzle id, e.g. holes-haze-and-old-paint-2026-10-08)</span><input class="input" id="m-val" required maxlength="120" value="' + esc(r.used_in || '') + '"></label>'
      : '<label class="field"><span>Why? (required; the group sees it, the student never does)</span><textarea class="input" id="m-val" required maxlength="2000" placeholder="e.g. Too close to last week’s category"></textarea></label>') +
    '<p class="err" id="m-err" role="alert" hidden></p><div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Cancel</button>' +
    '<button class="btn ' + (used ? 'primary' : 'danger') + '" type="submit" id="m-go">' + (used ? 'Mark used' : 'Decline') + '</button></div></form>',
  (m, close) => {
    $('#m-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('#m-val', m).value.trim(), err = $('#m-err', m);
      if (!v) { err.hidden = false; err.textContent = used ? 'Type the puzzle id.' : 'Write a short reason so the group knows why.'; $('#m-val', m).focus(); return; }
      await busy($('#m-go', m), 'Saving…', async () => {
        if (await setStatus(r, status, used ? { used_in: v } : { admin_note: v })) { close(); await done(); }
      });
    });
  });
}

async function saveTags(r, tags) {
  const { data, error } = await S.sb.from('submissions').update({ tags }).eq('id', r.id).select('id');
  if (error || !data || !data.length) { toast('Could not save the tags: ' + plainError(error || 'no permission'), 5000); return false; }
  return true;
}

/* Draws the open card's inside into box, then fills in history + comments. */
export function mountDetail(box, r) {
  const seq = ++mountSeq;
  box.innerHTML = '<div class="stack" style="--gap:16px">' + detailHtml(r) + '</div>';
  const root = box.firstElementChild;
  const again = async (sel) => {
    await reload(true); redraw(); await lastMount;
    const card = document.getElementById('sd-' + r.id), el = card && sel && $(sel, card);
    if (el) el.focus();
  };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], [data-tag]'); if (!b || !root.contains(b)) return;
    const k = b.dataset.act;
    if (b.dataset.tag != null) {
      const t = b.dataset.tag, cur = r.tags || [];
      const next = cur.includes(t) ? cur.filter((x) => x !== t) : cur.concat(t);
      await busy(b, '…', async () => { if (await saveTags(r, next)) { toast('Tags saved'); await again('[data-tag="' + CSS.escape(t) + '"]'); } });
    } else if (k === 'tag-add') {
      const inp = $('.tag-new', root), t = inp.value.trim().replace(/\s+/g, ' ');
      if (!t) { inp.focus(); return; }
      if ((r.tags || []).length >= 20) { toast('20 tags is the most one suggestion can have.', 4000); return; }
      if ((r.tags || []).some((x) => x.toLowerCase() === t.toLowerCase())) { toast('It already has that tag.'); return; }
      await busy(b, 'Adding…', async () => { if (await saveTags(r, (r.tags || []).concat(t))) { toast('Tag added'); await again('.tag-new'); } });
    } else if (k === 'vote') {
      await busy(b, '…', () => toggleVote(r.id)); redraw(); await lastMount;
      const v = document.getElementById('sd-' + r.id); if (v) $('[data-act="vote"]', v).focus();
    } else if (k === 'shortlisted' || k === 'new') {
      await busy(b, 'Saving…', async () => { if (await setStatus(r, k)) await again('[data-act="dl"]'); });
    } else if (k === 'declined' || k === 'used') statusDialog(r, k, () => again('[data-act="dl"]'));
    else if (k === 'dl') await busy(b, 'Preparing…', () => downloadOne(r));
  });
  fillImages(root);
  lastMount = (async () => {
    try {
      const [evs, cmts] = await Promise.all([
        S.sb.from('review_events').select('actor_email, action, note, at').eq('submission_id', r.id).order('at', { ascending: true }).limit(500),
        fetchComments(r.id)]);
      if (evs.error) throw evs.error;
      if (seq !== mountSeq || !root.isConnected) return;
      $('.sd-hist', root).innerHTML = historyHtml(r, evs.data || []);
      const c = $('.sd-cmts', root); c.innerHTML = commentsHtml(r, cmts);
      wireComments(c, r, cmts, again);
    } catch (e) {
      if (seq === mountSeq && root.isConnected) $$('.sd-hist, .sd-cmts', root).forEach((x) => { x.innerHTML = '<p class="err-box">' + esc(plainError(e)) + '</p>'; });
    }
  })();
  return lastMount;
}
