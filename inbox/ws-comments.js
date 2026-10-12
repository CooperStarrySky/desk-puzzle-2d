/* Puzzle workspace: comments on a suggestion. Everyone in the group reads them;
   you can edit or delete only your own (the database enforces it too). The
   author and time come from your sign-in, never from the page. */
import { S, $, esc, lc, busy, toast, plainError, openModal, when, ago, av, person } from './ws-core.js';

export async function fetchComments(id) {
  const { data, error } = await S.sb.from('comments').select('id, author_email, body, at, edited_at')
    .eq('target_type', 'submission').eq('target_id', id).order('at', { ascending: true }).limit(500);
  if (error) throw error;
  return data || [];
}
function oneHtml(c) {
  const mine = lc(c.author_email) === S.me;
  return '<div class="cmt" data-cid="' + esc(c.id) + '">' + av(c.author_email, 1) + '<div class="cmt-body"><span class="who-n">' + esc(person(c.author_email).name) + '</span>' +
    '<span class="when" title="' + esc(when(c.at)) + '">' + esc(ago(c.at)) + (c.edited_at ? ' · edited' : '') + '</span><p>' + esc(c.body) + '</p>' +
    (mine ? '<div class="cmt-tools"><button type="button" class="btn small ghost" data-cact="edit" data-cid="' + esc(c.id) + '">Edit</button>' +
      '<button type="button" class="btn small ghost" data-cact="del" data-cid="' + esc(c.id) + '">Delete</button></div>' : '') + '</div></div>';
}
export function commentsHtml(r, list) {
  return '<section><h4 class="sd-h">Comments (' + list.length + ')</h4><div class="comments">' + list.map(oneHtml).join('') +
    '<div class="cmt">' + av(S.me, 1) + '<div class="stack" style="--gap:6px"><label class="sr" for="cm-' + esc(r.id) + '">Add a comment</label>' +
    '<textarea class="input cm-in" id="cm-' + esc(r.id) + '" maxlength="2000" rows="2" placeholder="Comment as ' + esc(person(S.me).name) + '…"></textarea>' +
    '<div><button type="button" class="btn primary small" data-cact="post">Post comment</button></div></div></div></div></section>';
}
/* again(focusSelector) re-draws the open card after a change. */
export function wireComments(root, r, list, again) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cact]'); if (!b || !root.contains(b)) return;
    const c = list.find((x) => x.id === b.dataset.cid);
    if (b.dataset.cact === 'post') {
      const t = $('.cm-in', root), body = t.value.trim();
      if (!body) { t.focus(); toast('Type a comment first.'); return; }
      await busy(b, 'Posting…', async () => {
        const { error } = await S.sb.from('comments').insert({ target_type: 'submission', target_id: r.id, body });
        if (error) { toast('Could not post that: ' + plainError(error), 5000); return; }
        t.value = ''; toast('Comment posted as ' + person(S.me).name);
        await again('.cm-in');
      });
    } else if (b.dataset.cact === 'edit' && c) {
      const box = b.closest('.cmt-body');
      box.querySelector('p').outerHTML = '<label class="sr" for="ce-' + esc(c.id) + '">Edit your comment</label><textarea class="input ce-in" id="ce-' + esc(c.id) + '" maxlength="2000" rows="3">' + esc(c.body) + '</textarea>';
      $('.cmt-tools', box).innerHTML = '<button type="button" class="btn small primary" data-cact="save" data-cid="' + esc(c.id) + '">Save</button>' +
        '<button type="button" class="btn small ghost" data-cact="cancel" data-cid="' + esc(c.id) + '">Cancel</button>';
      const ta = $('.ce-in', box); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    } else if (b.dataset.cact === 'cancel') {
      await again('[data-cact="edit"][data-cid="' + b.dataset.cid + '"]');
    } else if (b.dataset.cact === 'save' && c) {
      const body = $('.ce-in', b.closest('.cmt-body')).value.trim();
      if (!body) { toast('A comment can’t be empty. Use Delete to remove it.', 4000); return; }
      await busy(b, 'Saving…', async () => {
        const { data, error } = await S.sb.from('comments').update({ body }).eq('id', c.id).select('id');
        if (error || !data || !data.length) { toast('Could not save that: ' + plainError(error || 'no permission'), 5000); return; }
        toast('Comment updated');
        await again('[data-cact="edit"][data-cid="' + c.id + '"]');
      });
    } else if (b.dataset.cact === 'del' && c) {
      openModal('<div class="stack" style="--gap:12px"><h2 id="modal-h">Delete your comment?</h2><p class="muted">“' + esc(c.body.slice(0, 160)) + (c.body.length > 160 ? '…' : '') + '”</p>' +
        '<div class="modal-actions"><button class="btn ghost" type="button" data-dismiss>Keep it</button><button class="btn danger" type="button" id="cd-yes">Delete</button></div></div>',
      (m, close) => {
        $('#cd-yes', m).addEventListener('click', (ev) => busy(ev.currentTarget, 'Deleting…', async () => {
          const { data, error } = await S.sb.from('comments').delete().eq('id', c.id).select('id');
          if (error || !data || !data.length) { toast('Could not delete that: ' + plainError(error || 'no permission'), 5000); return; }
          close(); toast('Comment deleted');
          await again('.cm-in');
        }));
      });
    }
  });
}
