/* Puzzle workspace: the "Faculty approved" seal. Optional and never blocks
   anything. Three sizes: the big rubber stamp on the draft, a small stamp on
   draft cards and in the Archive, and a ✓ chip (with a tooltip) on the
   Calendar. Hidden everywhere when the school turned the badge off
   (school_settings.faculty_badge). "Edited since approval" shows when the
   puzzle changed after the stamp. */
import { S, esc, person, fmtDay } from './ws-core.js';
import { editedSinceApproval } from './ws-plan-data.js';

/* Is the seal shown for this school? (On unless the school turned it off.) */
export function badgeOn(school) {
  const s = S.settings && S.settings[school];
  return !s || s.faculty_badge !== false;
}
export const approved = (d) => !!(d && d.faculty_approved_at && d.faculty_approved_by) && badgeOn(d.school);

/* size: 'lg' (draft), 'sm' (cards, archive), 'xs' (calendar chip). */
export function sealHtml(d, size) {
  if (!approved(d)) return '';
  const who = person(d.faculty_approved_by).name, edited = editedSinceApproval(d);
  const t = 'Faculty approved by ' + who + ' on ' + fmtDay(d.faculty_approved_at) + (edited ? '. Edited since approval.' : '');
  if (size === 'xs') return '<span class="seal-xs' + (edited ? ' edited' : '') + '" role="img" tabindex="0" aria-label="' + esc(t) + '" title="' + esc(t) + '">✓</span>';
  if (size === 'sm') return '<span class="seal-sm' + (edited ? ' edited' : '') + '" title="' + esc(t) + '"><span aria-hidden="true">✓</span> Faculty approved · ' + esc(who) + (edited ? ' · edited since' : '') + '</span>';
  return '<span class="seal' + (edited ? ' edited' : '') + '" role="img" aria-label="' + esc(t) + '" title="' + esc(t) + '"><span class="seal-top">Faculty</span>' +
    '<span class="seal-ck" aria-hidden="true">✓</span><span class="seal-bot">approved</span><span class="seal-who">' + esc(who) + '</span></span>';
}
