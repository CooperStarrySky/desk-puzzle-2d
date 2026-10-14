/* Puzzle workspace: "Download for import". Rebuilds the Studio's own file format
   so tools/import_submission.py reads it unchanged. Moved unchanged from the old
   single-file inbox (only sb -> S.sb). */
import { S, toast, plainError, slug, isPuzzle, isStoragePath, BUCKET } from './ws-core.js';
const MIME_BY_EXT = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

function bytesToBase64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function toDataUri(path) {
  const { data, error } = await S.sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error('could not fetch image ' + path);
  const ext = (path.split('.').pop() || '').toLowerCase();
  const mime = MIME_BY_EXT[ext] || data.type || 'image/webp';
  return 'data:' + mime + ';base64,' + bytesToBase64(await data.arrayBuffer());
}
async function rebuildSubmission(r) {
  // payload.submissionVersion says which version was sent (rows from before
  // full puzzles have none: version 1). It is not part of the file itself.
  const payload = JSON.parse(JSON.stringify(r.payload || {}));
  const version = payload.submissionVersion === 2 ? 2 : 1;
  delete payload.submissionVersion;
  const groups = isPuzzle(r) ? (payload.groups || []) : [payload];
  for (const g of groups) {
    for (const it of g.items || []) {
      for (const f of ['info', 'scope']) {
        if (it[f] && isStoragePath(it[f].image)) it[f].image = await toDataUri(it[f].image);
      }
    }
  }
  const credit = r.credit_mode === 'named'
    ? Object.assign({ mode: 'named', name: r.credit_name || '' }, r.credit_line ? { line: r.credit_line } : {})
    : { mode: 'anonymous' };
  const head = { format: 'desk-puzzle-submission', version: isPuzzle(r) ? 2 : version, kind: isPuzzle(r) ? 'puzzle' : 'category',
    submittedAt: r.created_at, credit, contact: r.contact_email ? { email: r.contact_email } : null, consent: r.consent === true };
  return isPuzzle(r) ? Object.assign(head, { puzzle: { title: payload.title, groups: payload.groups } })
    : Object.assign(head, { suggestedTier: r.suggested_tier, group: payload });
}
function fileNameFor(r) {
  return 'desk-puzzle-submission-' + (isPuzzle(r) ? 'puzzle-' : '') + (slug(r.group_name) || 'category') + '-' + String(r.created_at || '').slice(0, 10) + '-' + slug(r.receipt_code) + '.json';
}
export async function downloadOne(r, quiet) {
  try {
    const sub = await rebuildSubmission(r);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(sub, null, 2) + '\n'], { type: 'application/json' }));
    a.download = fileNameFor(r);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (!quiet) toast('Downloaded ' + a.download, 3500);
    return true;
  } catch (e) { toast('Download failed: ' + plainError(e), 5000); return false; }
}
export async function downloadShortlisted(list, b) {
  if (!list.length) return;
  const label = b.textContent; b.disabled = true;
  let n = 0;
  for (const r of list) {
    b.textContent = 'Downloading ' + (n + 1) + ' of ' + list.length + '…';
    if (await downloadOne(r, true)) n++;
    await new Promise((res) => setTimeout(res, 500)); // browsers drop downloads fired too close together
  }
  b.textContent = label; b.disabled = false;
  toast(n + ' file' + (n === 1 ? '' : 's') + ' downloaded. Next: python3 tools/import_submission.py ~/Downloads/desk-puzzle-submission-*.json', 7000);
}
