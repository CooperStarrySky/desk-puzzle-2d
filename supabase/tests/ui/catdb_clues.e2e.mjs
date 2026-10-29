// node supabase/tests/ui/catdb_clues.e2e.mjs  (needs pg_server.mjs running)
// Category database, opened card: a non-image clue (sticky note, paper sheet,
// prescription) is drawn the way the game draws it, with its text, instead of
// the old empty dotted "Text clue" box; picture thumbnails wait on a neutral
// backdrop, not black. Light and dark. SHOTS=<dir> saves db-sticky-clue.png.
import fs from 'node:fs';
import { page, check, summary, resetDb, sql, U, C } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
await resetDb();
// Make one seeded clue a prescription and one a paper sheet, so every text kind shows.
await sql(`update public.submissions set payload = jsonb_set(jsonb_set(payload, '{items,2,zone}', '"rx"'), '{items,3,zone}', '"folder"') where id = $1`, [C.hemoptysis]);
const sd = '#sd-' + C.hemoptysis;

for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const P = await page({ width: 1366, height: 900, dark });
  check(`T0 ${tag}: signs in`, await P.signInAs(U.ADMIN)); await P.settle();
  await P.click('#tg-' + C.hemoptysis);
  await P.waitFor('!!document.querySelector("' + sd + ' .clue-row")');
  check(`T1 ${tag}: no "Text clue" placeholder left`, !/Text clue/.test(await P.text(sd + ' .clue-row .thumbs') || '') &&
    !(await P.js(`[...document.querySelectorAll('${sd} .thumbs .none')].some((n) => /Text clue/.test(n.textContent))`)));
  const note = await P.js(`(() => { const n = document.querySelector('${sd} .thumbs .text-piece.mp-corkboard'); if (!n) return null;
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n); return { text: n.textContent.trim(), w: r.width, h: r.height, bg: cs.backgroundImage, label: n.getAttribute('aria-label') }; })()`);
  check(`T2 ${tag}: sticky-note clue drawn as a note with its text`, !!note && note.text.length > 0 && /sticky\.webp/.test(note.bg) && note.w >= 90 && note.h >= 90, note);
  check(`T2 ${tag}: note is named for screen readers`, !!note && /^Sticky note: /.test(note.label), note);
  check(`T3 ${tag}: prescription drawn on the ℞ pad with its text`, (await P.text(sd + ' .thumbs .text-piece.mp-rx') || '').length > 0 && /rx\.webp/.test(await P.js(`getComputedStyle(document.querySelector('${sd} .thumbs .text-piece.mp-rx')).backgroundImage`)));
  check(`T3 ${tag}: paper sheet drawn on paper`, /paper\.webp/.test(await P.js(`(() => { const n = document.querySelector('${sd} .thumbs .text-piece.mp-folder'); return n ? getComputedStyle(n).backgroundImage : ''; })()`)));
  check(`T4 ${tag}: picture thumbnails load on a neutral backdrop (not black)`, await P.js(`(() => { const i = document.createElement('img'); const t = document.querySelector('${sd} .thumbs'); t.appendChild(i);
    const c = getComputedStyle(i).backgroundColor; i.remove(); return c !== 'rgb(0, 0, 0)' && c !== 'rgba(0, 0, 0, 0)'; })()`));
  if (SHOTS && !dark) {
    await P.js(`document.querySelector('${sd} .clue-row:nth-of-type(2), ${sd} .clue-row').scrollIntoView({ block: 'start' }); window.scrollBy(0, -120)`); await P.sleep(400);
    await P.shot(SHOTS + '/db-sticky-clue.png');
  }
  check(`T5 ${tag}: no console errors`, P.errors.length === 0, P.errors);
  P.close();
}
process.exit(summary());
