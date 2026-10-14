/* Puzzle workspace: faculty approval on an open draft. Faculty of the draft's
   school (or the site owner) press "Approve puzzle"; the seal then shows here,
   on the draft list, the Calendar and the Archive. If the puzzle changes after
   that, the seal says "Edited since approval" and faculty can re-approve.
   Optional: it never blocks Ready, Schedule or Publish. Hidden entirely when
   the school turned the badge off. */
import { S, $, esc, busy, toast, person, when, roleIn } from './ws-core.js';
import { setApproval, editedSinceApproval } from './ws-plan-data.js';
import { addPart, refresh, current } from './ws-plan-editor.js';
import { badgeOn, sealHtml } from './ws-plan-seal.js';

const canApprove = (d) => ['owner', 'faculty'].includes(roleIn(d.school));
function render(d) {
  const el = $('#appr'); if (!el) return;
  if (!badgeOn(d.school)) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const on = !!d.faculty_approved_at, edited = on && editedSinceApproval(d), can = canApprove(d) && d.status !== 'published';
  const head = on ? 'Faculty approved ✓ ' + person(d.faculty_approved_by).name : 'No faculty approval yet';
  const btns = !can ? '' : !on ? '<button type="button" class="btn primary" id="appr-go">Approve puzzle</button>'
    : (edited ? '<button type="button" class="btn primary" id="appr-go">Re-approve</button>' : '') +
      (d.faculty_approved_by === S.me || S.owner ? '<button type="button" class="btn small ghost" id="appr-x">' + (d.faculty_approved_by === S.me ? 'Remove my approval' : 'Remove approval') + '</button>' : '');
  el.innerHTML = '<div class="appr-row">' + (on ? sealHtml(d, 'lg') : '<span class="seal seal-empty" aria-hidden="true"><span class="seal-top">Faculty</span><span class="seal-ck">?</span><span class="seal-bot">approval</span></span>') +
    '<div class="stack" style="--gap:6px"><b id="appr-h">' + esc(head) + '</b>' +
    (edited ? '<p class="appr-edited" id="appr-edited">Edited since approval. The puzzle changed after ' + esc(person(d.faculty_approved_by).name) + ' approved it.</p>' : '') +
    '<p class="muted appr-note">' + (on ? 'Approved ' + esc(when(d.faculty_approved_at)) + '. ' : '') + 'Optional. Scheduling and publishing never wait on it.</p>' +
    (btns ? '<div class="row" style="--gap:8px">' + btns + '</div>' : '') + '</div></div>';
}
function mount() {
  const el = $('#appr'); if (!el) return;
  el.addEventListener('click', (e) => {
    const d = current(), b = e.target.closest('button'); if (!d || !b) return;
    const on = b.id === 'appr-go'; if (!on && b.id !== 'appr-x') return;
    const again = on && !!d.faculty_approved_at;
    busy(b, on ? 'Approving…' : 'Removing…', async () => {
      if (!(await setApproval(d.id, on))) return;
      toast(on ? (again ? 'Re-approved. The seal is up to date.' : 'Approved. The seal now shows on the draft, the Calendar and the Archive.') : 'Approval removed');
      await refresh();
      const f = $('#appr-x') || $('#appr-go'); if (f) f.focus();
    });
  });
}
addPart({ mount, update: render });
