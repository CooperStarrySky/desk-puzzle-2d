// supabase/tests/ui/live_sync.e2e.mjs — live syncing + presence (B6), part 1: the Planner.
// Two signed-in pages (John D. = CMSRU lead, Marcus T. = CMSRU admin) on one
// draft, joined through pg_server.mjs's Realtime stand-in (real row rules on
// realtime.messages decide who may join). Part 2 (live_sync_b.mjs): Categories,
// Activity, other schools, Realtime down, phone width.
import { page, check, summary, resetDb, sql, U, C, D } from './lib.mjs';

const SHOTS = process.env.SHOTS || '';
const ADAPT = `update public.draft_slots d set adapted = jsonb_set(s.payload, '{name}', to_jsonb($2::text))
  from public.submissions s where d.draft_id = $1 and d.tier = 3 and s.id = d.submission_id returning d.tier`;

await resetDb();
const a = await page(), b = await page();
try {
  await a.signInAs(U.LEAD, '#/planner/' + D.cmsru);
  await b.signInAs(U.ADMIN, '#/planner/' + D.cmsru);
  check('P0 both pages open the draft', await a.waitFor('!!document.getElementById("editor")') && await b.waitFor('!!document.getElementById("editor")'));
  check('P0 live channels: bank + own school only', await a.waitFor('(() => { const s = window.__wsLive.state(); return s.ok && s.topics.join() === "ws:bank,ws:school:cmsru"; })()', 8000),
    await a.js('window.__wsLive.state()'));

  // Presence in the draft header
  check('P1 John sees "Marcus T. is viewing"', await a.waitFor('(document.getElementById("ed-pres").textContent || "").includes("Marcus T. is viewing")', 8000), await a.text('#ed-pres'));
  check('P1 Marcus sees "John D. is viewing"', await b.waitFor('(document.getElementById("ed-pres").textContent || "").includes("John D. is viewing")', 8000), await b.text('#ed-pres'));
  check('P1 one avatar, with initials', await a.count('#ed-pres .pres-av .av') === 1 && await a.text('#ed-pres .av') === 'MT');
  if (SHOTS) await a.shot(SHOTS + '/15-presence-draft-header.png');

  // A rename from the other page, while John types notes
  await a.js(`(() => { const n = document.getElementById('ed-notes'); n.focus(); n.value = 'My unsaved note'; })()`);
  await b.js(`(() => { const t = document.getElementById('ed-title'); t.value = 'Renamed by Marcus'; t.dispatchEvent(new Event('change')); })()`);
  check('P2 the new title shows up live (no reload)', await a.waitFor('document.getElementById("ed-h").textContent === "Renamed by Marcus"', 8000), await a.text('#ed-h'));
  check('P2 "Updated by Marcus T." flash on the header', await a.waitFor('(document.querySelector(".ed-head .live-by") || {}).textContent === "Updated by Marcus T."', 3000));
  check('P2 my unsaved notes and focus are untouched', await a.js('document.getElementById("ed-notes").value === "My unsaved note" && document.activeElement.id === "ed-notes"'));
  check('P2 the title field took the new title', await a.js('document.getElementById("ed-title").value') === 'Renamed by Marcus');
  check('P2 no self-flash on the page that made the change', await b.count('.ed-head .live-by') === 0);
  await a.js(`(() => { const n = document.getElementById('ed-notes'); n.value = ''; n.blur(); })()`);

  // A slot change (swap tiers 3 and 1)
  let r = await sql(`select public.swap_draft_slots($1, 3, 1)`, [D.cmsru], U.ADMIN);
  check('P3 Marcus swaps tiers 3 and 1', !r.error, r.error);
  check('P3 John sees the category move to tier 1', await a.waitFor('/Lead poisoning|lead/i.test(document.querySelector(\'.slot[data-t="1"]\').textContent) && !!document.querySelector(\'.slot[data-t="3"] .slot-empty\')', 8000),
    await a.text('.slot[data-t="1"]'));
  check('P3 "Changed by Marcus T." on the slot', await a.waitFor('[...document.querySelectorAll(".slot .live-by")].some((x) => x.textContent === "Changed by Marcus T.")', 3000));
  if (SHOTS) { await a.js('window.scrollTo(0, document.getElementById("slots").getBoundingClientRect().top + scrollY - 140)'); await a.shot(SHOTS + '/16-live-update-flash.png'); }
  r = await sql(`select public.swap_draft_slots($1, 1, 3)`, [D.cmsru], U.ADMIN);
  await a.waitFor('!!document.querySelector(\'.slot[data-t="3"] [data-adapt]\')', 8000);

  // Conflict while editing a slot
  await a.click('.slot[data-t="3"] [data-adapt]');
  check('P4 John opens the slot editor', await a.waitFor('!!document.querySelector(\'.slot.editing[data-t="3"] [data-ad="name"]\')'));
  await a.js(`(() => { const i = document.querySelector('[data-ad="name"]'); i.focus(); i.value = 'John typing here'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('P4 Marcus sees "John D. is editing Tier 3"', await b.waitFor('(document.getElementById("ed-pres").textContent || "").includes("John D. is editing Tier 3")', 8000), await b.text('#ed-pres'));
  r = await sql(ADAPT, [D.cmsru, 'Remote copy one'], U.ADMIN);
  check('P4 Marcus saves a copy of the same slot', !r.error && r.data !== null, r.error);
  check('P4 John gets "Marcus T. changed this slot" with two choices',
    await a.waitFor('(document.querySelector(".live-conflict") || {}).textContent && document.querySelector(".live-conflict").textContent.includes("Marcus T. changed this slot")', 8000) &&
    await a.count('.live-conflict [data-lc="reload"]') === 1 && await a.count('.live-conflict [data-lc="keep"]') === 1);
  check('P4 John\'s typing is kept, focus too', await a.js('document.querySelector(\'[data-ad="name"]\').value === "John typing here" && document.activeElement.dataset.ad === "name"'));
  if (SHOTS) await a.shot(SHOTS + '/17-slot-conflict-notice.png');
  await a.click('.live-conflict [data-lc="keep"]');
  check('P4 Keep mine: notice goes, my text stays', await a.waitFor('!document.querySelector(".live-conflict")') && await a.js('document.querySelector(\'[data-ad="name"]\').value') === 'John typing here');
  r = await sql(ADAPT, [D.cmsru, 'Remote copy two'], U.ADMIN);
  await a.waitFor('!!document.querySelector(".live-conflict")', 8000);
  await a.click('.live-conflict [data-lc="reload"]');
  check('P4 Reload slot: editor reopens with Marcus\'s version', await a.waitFor('(document.querySelector(\'.slot.editing[data-t="3"] [data-ad="name"]\') || {}).value === "Remote copy two"', 5000),
    await a.js('(document.querySelector(\'[data-ad="name"]\') || {}).value'));
  await a.click('[data-adcancel="3"]');
  check('P4 cancelling the edit tells Marcus John is only viewing again', await b.waitFor('(document.getElementById("ed-pres").textContent || "").includes("John D. is viewing")', 8000));

  // Draft comments: arrive live, never clobber a comment being written
  await b.type('#ed-cm .cm-in', 'Marcus says tier 2 needs an image'); await b.click('#ed-cm [data-cact="post"]');
  check('P5 Marcus\'s draft comment appears for John', await a.waitFor('document.getElementById("ed-cm").textContent.includes("tier 2 needs an image")', 8000));
  check('P5 "New comment by Marcus T." flash', await a.waitFor('(document.querySelector("#ed-cm > .live-by") || {}).textContent === "New comment by Marcus T."', 3000));
  await a.type('#ed-cm .cm-in', 'John half-written reply');
  await b.type('#ed-cm .cm-in', 'Second note from Marcus'); await b.click('#ed-cm [data-cact="post"]');
  await a.sleep(2500);
  check('P5 John\'s half-written reply survives', await a.js('document.querySelector("#ed-cm .cm-in").value') === 'John half-written reply');
  await a.js(`(() => { const t = document.querySelector('#ed-cm .cm-in'); t.value = ''; t.blur(); })()`);
  check('P5 ...and the new comment arrives once John is done', await a.waitFor('document.getElementById("ed-cm").textContent.includes("Second note from Marcus")', 8000));

  // Leaving
  await b.go((await b.js('location.href')).replace(/#.*$/, '#/planner'));
  check('P6 Marcus leaves: John\'s header empties', await a.waitFor('document.getElementById("ed-pres").hidden', 10000), await a.text('#ed-pres'));
  check('P6 Marcus\'s draft list shows the new title', await b.waitFor('document.body.textContent.includes("Renamed by Marcus")', 8000));
  check('P7 no console errors (John)', a.errors.length === 0, a.errors);
  check('P7 no console errors (Marcus)', b.errors.length === 0, b.errors);
} finally { a.close(); b.close(); }
await (await import('./live_sync_b.mjs')).runPart2();
await (await import('./live_sync_c.mjs')).runPart3();
process.exit(summary() ? 1 : 0);
