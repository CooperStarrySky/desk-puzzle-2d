// Guess detail + "all published puzzles" class stats (2026-10-29), client side.
// Drives the real engine, state.js and stats-remote.js with stubbed browser
// globals (no network: fetch is a spy). Run: node tools/stats_attempts_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { status: 200, ok: true }; };
globalThis.window = { DESK_PUZZLE_CONFIG: { supabaseUrl: 'https://x.supabase.co', supabasePublishableKey: 'pk' }, AbortController };
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };

const { DeskPuzzleGame } = await import(new URL('../src/engine.js', import.meta.url));
const S = await import(new URL('../src/state.js', import.meta.url));
const core = await import(new URL('../src/stats-core.js', import.meta.url));
const remote = await import(new URL('../src/stats-remote.js', import.meta.url));
const { state, persistGame, setFirstFinishHook, resetLiveFinishTracking, getFirstResult, FIRST_NS } = S;

const read = (f) => JSON.parse(fs.readFileSync(new URL('../puzzles/' + f, import.meta.url), 'utf8'));
const OLD_FILE = 'holes-haze-and-old-paint-2026-10-08.json';
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

state.layout = state.layout || {};
state.layout.scatter = { lo: 0.1, hi: 0.9 };
state.settings.casual = false;
state.previewMode = false; state.editorMode = false;

function newGame(puzzle) {
  const game = new DeskPuzzleGame(puzzle, { casual: false });
  state.game = game;
  state.desk = S.freshDeskState(puzzle);
  game.events.on('change', () => persistGame());
  return game;
}
function guess(game, ids) {
  game.snapshot().staging.forEach((cells, bi) => { if (!game.isBoxLocked(bi)) cells.forEach((id) => { if (id) game.unstage(id); }); });
  const box = [0, 1, 2, 3].find((b) => !game.isBoxLocked(b));
  ids.forEach((id, slot) => game.stageToSlot(id, box, slot));
  return game.submitBox(box);
}
const hooked = [];
setFirstFinishHook((pid, rec) => hooked.push({ pid, rec }));

// A wrong guess that is one away: 3 from group 0 + 1 from group 1.
const p = read(OLD_FILE);
const [g0, g1, g2, g3] = p.groups;
const oneAway = g0.itemIds.slice(0, 3).concat(g1.itemIds[0]);
const twoTwo = g0.itemIds.slice(0, 2).concat(g1.itemIds.slice(0, 2));

await t('item ids are stable: they come from the puzzle file, same on every load', () => {
  const a = read(OLD_FILE), b = read(OLD_FILE);
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
  assert.ok(a.items.every((i) => /^[a-z0-9][a-z0-9-]{0,95}$/.test(i.id)));
  assert.ok(a.groups.every((g) => /^[a-z0-9][a-z0-9-]{0,95}$/.test(g.id)));
});

await t('live first finish on an OLD puzzle: hook fires with the guess detail', () => {
  store.clear(); resetLiveFinishTracking(); hooked.length = 0;
  const game = newGame(p);
  game.setPhase('playing');
  state.desk.hints.seeds = true; state.desk.hints.after = { seeds: 0 };
  guess(game, oneAway);
  guess(game, g0.itemIds); guess(game, g1.itemIds);
  state.desk.hints.category = true; state.desk.hints.revealedGroupId = g3.id; state.desk.hints.after.category = 2;
  guess(game, g2.itemIds); guess(game, g3.itemIds);
  assert.equal(game.phase, 'won');
  assert.equal(hooked.length, 1);
  const rec = hooked[0].rec;
  assert.equal(rec.v, 2); assert.equal(rec.guesses, 5); assert.equal(rec.mistakes, 1);
  assert.deepEqual(rec.attempts[0], { i: oneAway, ok: false, one_away: true });
  assert.deepEqual(rec.attempts[1], { i: g0.itemIds, ok: true, one_away: false });
  assert.deepEqual(rec.solveOrder, [g0.id, g1.id, g2.id, g3.id]);
  assert.equal(rec.revealedGroup, g3.id);
  assert.deepEqual(rec.hintAfter, { labels: null, seeds: 0, category: 2 });
  const body = core.finishPayload(p.id, 'anon', rec);
  assert.deepEqual(Object.keys(body).sort(), ['anonId', 'attempts', 'casual', 'event', 'guesses', 'hintAfter', 'hints', 'mistakes', 'outcome', 'puzzleId', 'revealedGroup', 'solveOrder']);
  assert.ok(JSON.stringify(body).length < 2000, 'payload stays small: ' + JSON.stringify(body).length);
  const ids = new Set(p.items.map((i) => i.id));
  assert.ok(body.attempts.every((a) => a.i.every((x) => ids.has(x))), 'sent ids are the puzzle file ids');
});

await t('wrong guess with 2+2 is not one away', () => {
  store.clear(); resetLiveFinishTracking(); hooked.length = 0;
  const game = newGame(p); game.setPhase('playing');
  guess(game, twoTwo);
  assert.equal(game.attempts[0].oneAway, false);
  const d = core.guessDetailFromSave(game.snapshot(), p);
  assert.equal(d.attempts[0].one_away, false);
  // old save without oneAway: worked out from the puzzle
  const snap = game.snapshot(); snap.attempts = [{ itemIds: oneAway, correct: false, boxIndex: 0 }];
  assert.equal(core.guessDetailFromSave(snap, p).attempts[0].one_away, true);
});

await t('browser that finished BEFORE stats (save already won, no first record) never sends', () => {
  store.clear(); resetLiveFinishTracking(); hooked.length = 0;
  const game = newGame(p);
  game.restore({ caseId: p.id, phase: 'won', staging: [[...g0.itemIds], [...g1.itemIds], [...g2.itemIds], [...g3.itemIds]], mistakes: 0,
    solved: [0, 1, 2, 3].map((k) => ({ groupId: p.groups[k].id, order: k, boxIndex: k })),
    attempts: [0, 1, 2, 3].map((k) => ({ itemIds: p.groups[k].itemIds.slice(), correct: true, boxIndex: k })) });
  persistGame(); // what openPuzzle does when it reopens a finished game
  assert.ok(getFirstResult(p.id), 'the local record is still written (My stats)');
  assert.equal(hooked.length, 0, 'but nothing is sent');
});

await t('browser with an existing first record from before never sends it again', () => {
  store.clear(); resetLiveFinishTracking(); hooked.length = 0;
  store.set(FIRST_NS + p.id, JSON.stringify({ v: 1, outcome: 'lost', mistakes: 4, guesses: 4, hints: {}, everCasual: false }));
  const game = newGame(p); game.setPhase('playing');
  guess(game, g0.itemIds); guess(game, g1.itemIds); guess(game, g2.itemIds); guess(game, g3.itemIds);
  assert.equal(game.phase, 'won');
  assert.equal(hooked.length, 0);
  assert.equal(getFirstResult(p.id).outcome, 'lost', 'first record unchanged');
});

await t('sendFirstFinish: old puzzle id is sent with the detail; opted out sends nothing', async () => {
  store.clear(); sent.length = 0;
  state.settings.shareStats = true;
  const rec = { v: 2, outcome: 'won', mistakes: 0, guesses: 4, hints: { labels: false, seeds: false, category: false }, everCasual: false,
    attempts: [0, 1, 2, 3].map((k) => ({ i: p.groups[k].itemIds.slice(), ok: true, one_away: false })), solveOrder: p.groups.map((g) => g.id), revealedGroup: null, hintAfter: null };
  await remote.sendFirstFinish(p.id, rec);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith('/functions/v1/record'));
  assert.equal(sent[0].body.puzzleId, p.id); assert.equal(sent[0].body.attempts.length, 4);
  assert.equal('revealedGroup' in sent[0].body, false); assert.equal('hintAfter' in sent[0].body, false);
  sent.length = 0;
  state.settings.shareStats = false;
  await remote.sendFirstFinish(p.id, rec);
  assert.equal(sent.length, 0);
  assert.equal(localStorage.getItem('dp2d:outbox'), null);
  state.previewMode = true; state.settings.shareStats = true;
  await remote.sendFirstFinish(p.id, rec);
  assert.equal(sent.length, 0, 'preview mode sends nothing');
  state.previewMode = false;
});

await t('old v1 record sends exactly the old fields', () => {
  const b = core.finishPayload('cases-2026-10-12', 'u', { v: 1, outcome: 'won', mistakes: 1, guesses: 5, hints: { category: true }, everCasual: false });
  assert.deepEqual(Object.keys(b).sort(), ['anonId', 'casual', 'event', 'guesses', 'hints', 'mistakes', 'outcome', 'puzzleId']);
});

await t('payload drops hintAfter/revealedGroup for hints not used, caps attempts at guesses', () => {
  const att = Array.from({ length: 45 }, () => ({ i: ['a', 'b', 'c', 'd'], ok: false, one_away: false }));
  const b = core.finishPayload('x-2026-10-12', 'u', { outcome: 'lost', mistakes: 45, guesses: 45, hints: { labels: true }, everCasual: true,
    attempts: att, revealedGroup: 'g', hintAfter: { labels: 9, seeds: 1, category: null } });
  assert.equal(b.attempts.length, 40); assert.equal(b.guesses, 40);
  assert.equal('revealedGroup' in b, false); assert.equal('hintAfter' in b, false);
});

await t('eligibility: every dated puzzle; legacy label only for <= 2026-10-11', () => {
  for (const id of ['starry-sky-society-2026-08-21', 'genetics-and-repair-2026-09-04', 'holes-haze-and-old-paint-2026-10-08', 'cases-2026-10-12']) assert.equal(core.isStatsEligible(id), true, id);
  for (const id of ['preview', null, 'Cases-2026-10-12', 'cases-2026-02-30']) assert.equal(core.isStatsEligible(id), false, String(id));
  assert.equal(core.isLegacyStatsPuzzle('holes-haze-and-old-paint-2026-10-08'), true);
  assert.equal(core.isLegacyStatsPuzzle('cases-2026-10-11'), true);
  assert.equal(core.isLegacyStatsPuzzle('cases-2026-10-12'), false);
  assert.ok(core.LEGACY_CLASS_LABEL.length < 40);
});

await t('old puzzle class stats: hidden below CLASS_MIN, shown at CLASS_MIN', () => {
  const row = (k) => ({ puzzle_id: 'holes-haze-and-old-paint-2026-10-08', plays: k, std_finishes: k, std_wins: k, mistakes_hist: [k, 0, 0, 0, 0],
    hint_any: 0, hint_labels: 0, hint_seeds: 0, hint_category: 0, rating_n: 0, rating_hist: [0, 0, 0, 0, 0] });
  assert.equal(core.CLASS_MIN, 10);
  assert.equal(core.classSummary(row(9)).enough, false);
  assert.equal(core.menuStatsLine(core.classSummary(row(9))), '');
  assert.equal(core.classSummary(row(10)).enough, true);
  assert.notEqual(core.menuStatsLine(core.classSummary(row(10))), '');
});

console.log(`\n${n} tests passed`);
