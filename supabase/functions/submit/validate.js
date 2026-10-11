// Checks one category submission before it is stored.
//
// Plain JavaScript (ES module) so the same file runs in the Supabase "submit"
// function (Deno), in node tests, and could be loaded by a browser. It mirrors
// the per-group and per-item rules of tools/import_submission.py
// check_submission() and Studio's categoryChecks(), word for word where it can,
// plus server-only limits (image count and size, text lengths, body size).
//
// Differences from import_submission.py, on purpose:
//   * kind "puzzle" gets a friendly "not open yet" message.
//   * Only WebP, JPEG, and PNG images (the Studio never makes GIFs).
//   * Size limits below. The Python tool reads files the admins already have,
//     so it does not need them.

export const LIMITS = Object.freeze({
  maxBodyBytes: 7 * 1024 * 1024, // whole request
  maxImages: 8,
  maxImageBytes: 700 * 1024,     // each image after decoding
  name: 120,                     // category name
  explanation: 400,
  label: 80,
  title: 120,
  text: 1500,                    // clue text when opened
  source: 300,                   // image source note
  article: 6000,                 // whole teaching note
  creditName: 60,
  creditLine: 40,
  email: 254,
  nids: 50,
});

export const VALID_ZONES = ['corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx'];
export const TITLE_ZONES = ['photo', 'rack', 'tubes'];
const ZONE_WORDS = { corkboard: 'sticky note', folder: 'paper sheet', rack: 'microscope slide',
  tubes: 'X-ray film', photo: 'photograph', rx: 'prescription' };
export const IMAGE_EXT = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };
const DATA_URI_RE = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
// Values in messages are written the way Python prints them, so the messages
// match tools/import_submission.py exactly.
const show = (v) => (v === undefined || v === null ? 'None' : typeof v === 'boolean' ? (v ? 'True' : 'False')
  : typeof v === 'string' ? "'" + v + "'" : JSON.stringify(v));

/** Same slug rule as build_puzzle.py / import_submission.py. */
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when the first bytes match the claimed image type. */
function looksLike(mime, b) {
  if (mime === 'image/png') return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/webp') {
    return b.length > 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
      String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP';
  }
  return false;
}

/**
 * data URI -> { mime, ext, bytes }. Throws Error with a plain message that
 * reads after "clue N image ...", like import_submission.py decode_image().
 */
export function decodeImage(uri) {
  const m = DATA_URI_RE.exec(typeof uri === 'string' ? uri : '');
  if (!m) throw new Error('is not an embedded image (expected a data:image/...;base64 value)');
  const mime = m[1];
  if (!IMAGE_EXT[mime]) throw new Error(`is a ${mime} image; only WebP, PNG, and JPEG are accepted`);
  const b64 = m[2].replace(/\s+/g, '');
  // Each 4 base64 characters hold 3 bytes; refuse oversize images before decoding.
  const approx = Math.floor((b64.length * 3) / 4);
  if (approx > LIMITS.maxImageBytes + 3) {
    throw new Error(`is too big (${Math.round(approx / 1024)} KB; ${Math.round(LIMITS.maxImageBytes / 1024)} KB max)`);
  }
  let bytes;
  try {
    if (b64.length % 4 !== 0) throw new Error('bad length');
    bytes = base64ToBytes(b64);
  } catch (e) {
    throw new Error('is damaged (the base64 data does not decode)');
  }
  if (bytes.length > LIMITS.maxImageBytes) {
    throw new Error(`is too big (${Math.round(bytes.length / 1024)} KB; ${Math.round(LIMITS.maxImageBytes / 1024)} KB max)`);
  }
  if (!looksLike(mime, bytes)) throw new Error('cannot be opened as an image');
  return { mime, ext: IMAGE_EXT[mime], bytes };
}

function tooLong(p, what, v, max) {
  if (typeof v === 'string' && v.trim().length > max) p.push(`${what} is ${v.trim().length} characters (max ${max})`);
}

/**
 * Check one submission object.
 * Returns { problems: string[], images: [{ item, field, mime, ext, bytes }] }.
 * problems is empty when the submission is good. Messages match
 * import_submission.py check_submission() wherever the rule is the same.
 */
export function validateSubmission(sub) {
  const p = [];
  const images = [];
  if (!isObj(sub)) return { problems: ['the file is not a submission (expected a JSON object)'], images };
  if (sub.format !== 'desk-puzzle-submission') {
    return { problems: ['the file is not a Desk Puzzle submission (format is not "desk-puzzle-submission")'], images };
  }
  if (sub.version !== 1) p.push(`version is ${show(sub.version)}; this tool reads version 1`);
  if (sub.kind === 'puzzle') {
    return { problems: p.concat(['whole-puzzle submissions are not open yet; please send one category at a time']), images };
  }
  if (sub.kind !== 'category') {
    return { problems: p.concat([`kind is ${show(sub.kind)}; this tool imports single categories only`]), images };
  }
  if (sub.consent !== true) p.push('the consent box was not ticked, so it cannot be used');
  const tier = sub.suggestedTier;
  if (![1, 2, 3, 4].includes(tier)) p.push(`suggested difficulty should be 1-4, got ${show(tier)}`);

  const credit = sub.credit;
  if (!isObj(credit) || !['named', 'anonymous'].includes(credit.mode)) {
    p.push('credit should say "named" or "anonymous"');
  } else if (credit.mode === 'named') {
    const name = text(credit.name);
    const line = credit.line;
    if (!name) p.push('asked for credit but gave no name');
    else if (name.length > LIMITS.creditName) p.push(`credit name is ${name.length} characters (max ${LIMITS.creditName})`);
    if (line !== undefined && line !== null && typeof line !== 'string') p.push('credit year/role should be text');
    else if (text(line).length > LIMITS.creditLine) p.push(`credit year/role is ${text(line).length} characters (max ${LIMITS.creditLine})`);
  }

  const contact = sub.contact;
  if (contact !== undefined && contact !== null) {
    const email = isObj(contact) ? text(contact.email) : '';
    if (!isObj(contact) || (email && !EMAIL_RE.test(email))) p.push('contact email does not look like an email address');
    else if (email.length > LIMITS.email) p.push('contact email is too long');
  }

  const g = sub.group;
  if (!isObj(g)) return { problems: p.concat(['the file has no category (group) in it']), images };
  if (!text(g.name)) p.push('the category has no name');
  if (!text(g.explanation)) p.push('the category has no one-line explanation');
  tooLong(p, 'the category name', g.name, LIMITS.name);
  tooLong(p, 'the explanation', g.explanation, LIMITS.explanation);

  const article = g.article;
  if (article !== undefined && article !== null) {
    if (!Array.isArray(article)) p.push('the teaching note should be a list of blocks');
    else {
      let total = 0;
      article.forEach((b, i) => {
        const bt = isObj(b) ? b.type : undefined;
        if (!['heading', 'text', 'image'].includes(bt)) p.push(`teaching note block ${i + 1} has an unknown type ${show(bt)}`);
        else if (bt === 'image') p.push(`teaching note block ${i + 1} is an image; move it to a clue or drop it`);
        else total += typeof b.text === 'string' ? b.text.length : 0;
      });
      if (total > LIMITS.article) p.push(`the teaching note is ${total} characters (max ${LIMITS.article})`);
    }
  }
  const anki = g.anki;
  if (anki !== undefined && anki !== null) {
    const raw = isObj(anki) ? anki.nids : undefined;
    if (!Array.isArray(raw)) p.push('Anki note IDs should be a list');
    else {
      raw.forEach((n) => { if (!Number.isInteger(n) || n <= 0) p.push(`Anki note ID ${show(n)} is not a positive whole number`); });
      if (raw.length > LIMITS.nids) p.push(`too many Anki note IDs (${raw.length}; max ${LIMITS.nids})`);
    }
  }

  const items = g.items;
  if (!Array.isArray(items) || items.length !== 4) {
    return { problems: p.concat([`expected 4 clues, found ${Array.isArray(items) ? items.length : 0}`]), images };
  }
  items.forEach((it, idx) => {
    const c = `clue ${idx + 1}`;
    if (!isObj(it)) { p.push(`${c} is not a clue`); return; }
    const zone = it.zone;
    const info = isObj(it.info) ? it.info : {};
    const scope = isObj(it.scope) ? it.scope : {};
    const label = text(it.label);
    if (!VALID_ZONES.includes(zone)) p.push(`${c} has an unknown kind of piece ${show(zone)}`);
    if (!label) p.push(`${c} has an empty label`);
    if (TITLE_ZONES.includes(zone) && !text(info.title)) p.push(`${c} is a ${ZONE_WORDS[zone]} and needs a title`);
    tooLong(p, `${c} label`, it.label, LIMITS.label);
    tooLong(p, `${c} title`, info.title, LIMITS.title);
    tooLong(p, `${c} text`, info.text, LIMITS.text);
    tooLong(p, `${c} image source`, it.source, LIMITS.source);
    let has = false;
    for (const [field, val] of [['info', info.image], ['scope', scope.image]]) {
      if (!val) continue;
      if (!TITLE_ZONES.includes(zone)) { p.push(`${c} is a ${ZONE_WORDS[zone] || 'piece'} (text only) but has an image`); continue; }
      try {
        images.push(Object.assign({ item: idx, field }, decodeImage(val)));
        has = true;
      } catch (e) {
        p.push(`${c} ${field === 'scope' ? 'microscope image' : 'image'} ${e.message}`);
      }
    }
    if (has && !text(it.source)) p.push(`${c} has an image but no source note`);
  });
  if (images.length > LIMITS.maxImages) p.push(`too many images (${images.length}; max ${LIMITS.maxImages})`);
  return { problems: p, images };
}

/** Item ids for storage paths: same rule as import_submission.py (slug, then -2, -3 ...). */
export function itemIds(items) {
  const used = new Set();
  return items.map((it) => {
    const base = slugify(it && it.label) || 'clue';
    let out = base;
    for (let n = 2; used.has(out); n++) out = `${base}-${n}`;
    used.add(out);
    return out;
  });
}

/** A receipt like DP-7KQM-2XRF (no 0/O/1/I so it reads cleanly aloud). */
export function receiptCode(randomBytes) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[b[i] % abc.length];
  return `DP-${s.slice(0, 4)}-${s.slice(4)}`;
}
