// Unit tests for src/stats-core.js (pure "My stats" math). Run: node tools/stats_test.mjs
import assert from 'node:assert/strict';
const core = await import(new URL('../src/stats-core.js', import.meta.url));
const { computeStats, saveEverCasual, firstResultFromSave, classifyFirst } = core;
const E = (id, date) => ({ id, date, title: id, file: id + '.json' });
// index.json style: newest first
const entries = [E('p6','2026-10-08'), E('p5','2026-09-30'), E('p4','2026-09-20'), E('p3','2026-09-10'), E('p2','2026-09-01'), E('p1','2026-08-20')];
const win = (m, extra = {}) => ({ phase: 'won', mistakes: m, casual: false, desk: { everCasual: false, hints: { labels: false, seeds: false, category: false }, hintsUsed: 0 }, ...extra });
const lost = () => ({ phase: 'lost', mistakes: 4, casual: false, desk: { everCasual: false, hints: {} } });
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('empty', () => { const s = computeStats(entries, {}); assert.equal(s.played, 0); assert.equal(s.solvedPct, 0); assert.equal(s.currentStreak, 0); assert.equal(s.bestStreak, 0); });
t('all wins, chart, perfect', () => {
  const s = computeStats(entries, { p1: win(0), p2: win(1), p3: win(3), p4: win(0), p5: win(2), p6: win(0) });
  assert.equal(s.played, 6); assert.equal(s.solvedPct, 100); assert.equal(s.currentStreak, 6); assert.equal(s.bestStreak, 6);
  assert.equal(s.perfect, 3); assert.deepEqual(s.chart, [3, 1, 1, 1]); assert.equal(s.notSolved, 0); assert.equal(s.hintFree, 6);
});
t('loss breaks streak', () => {
  const s = computeStats(entries, { p1: win(0), p2: win(0), p3: lost(), p4: win(1), p5: win(0), p6: win(2) });
  assert.equal(s.bestStreak, 3); assert.equal(s.currentStreak, 3); assert.equal(s.solvedPct, 83); assert.equal(s.notSolved, 1);
});
t('casual mid-game (sticky flag) counts as played only and breaks streak', () => {
  const c = win(0, { casual: false, desk: { everCasual: true, hints: {} } });
  assert.equal(saveEverCasual(c), true);
  const s = computeStats(entries, { p1: win(0), p2: win(0), p3: c, p4: win(0), p5: win(0), p6: win(0) });
  assert.equal(s.played, 6); assert.equal(s.casualPlayed, 1); assert.equal(s.standardPlayed, 5);
  assert.equal(s.solved, 5); assert.equal(s.solvedPct, 100); assert.equal(s.perfect, 5); assert.deepEqual(s.chart, [5, 0, 0, 0]);
  assert.equal(s.bestStreak, 3); assert.equal(s.currentStreak, 3);
});
t('old save without everCasual falls back to casual flag', () => {
  const old = { phase: 'won', mistakes: 6, casual: true, desk: { hints: {} } };
  assert.equal(saveEverCasual(old), true);
  assert.equal(saveEverCasual({ phase: 'won', mistakes: 0, casual: false, desk: {} }), false);
  const s = computeStats(entries, { p6: old }); assert.equal(s.casualPlayed, 1); assert.equal(s.solved, 0); assert.deepEqual(s.chart, [0,0,0,0]);
});
t('hints: any flag or legacy hintsUsed blocks hint-free', () => {
  const h1 = win(0, { desk: { everCasual: false, hints: { seeds: true } } });
  const h2 = win(1, { desk: { everCasual: false, hints: {}, hintsUsed: 2 } });
  const h3 = win(0, { desk: { everCasual: false, hints: { category: true } } });
  const s = computeStats(entries, { p1: h1, p2: h2, p3: h3, p4: win(0) });
  assert.equal(s.solved, 4); assert.equal(s.hintFree, 1); assert.equal(s.perfect, 3);
});
t('gap (unplayed older puzzle) breaks streak', () => {
  const s = computeStats(entries, { p1: win(0), p2: win(0), p4: win(0), p5: win(0), p6: win(0) });
  assert.equal(s.bestStreak, 3); assert.equal(s.currentStreak, 3); assert.equal(s.played, 5);
});
t('newest unplayed or in progress does not break current streak', () => {
  let s = computeStats(entries, { p4: win(0), p5: win(1) });
  assert.equal(s.currentStreak, 2);
  s = computeStats(entries, { p4: win(0), p5: win(1), p6: { phase: 'playing', mistakes: 2, desk: {} } });
  assert.equal(s.currentStreak, 2); assert.equal(s.played, 2);
  s = computeStats(entries, { p4: win(0), p5: { phase: 'playing', mistakes: 1, desk: {} }, p6: win(0) });
  assert.equal(s.currentStreak, 1); assert.equal(s.bestStreak, 1);
});
t('newest lost resets current streak', () => {
  const s = computeStats(entries, { p4: win(0), p5: win(0), p6: lost() });
  assert.equal(s.currentStreak, 0); assert.equal(s.bestStreak, 2);
});
t('saves for puzzles not in the registry are ignored; garbage tolerated', () => {
  const s = computeStats(entries, { zz: win(0), p6: null, p5: 'junk', p4: win(0) });
  assert.equal(s.played, 1);
});
t('same-date tie keeps index order (later in list = older)', () => {
  const es = [E('b','2026-09-01'), E('a','2026-09-01')];
  const s = computeStats(es, { a: lost(), b: win(0) });
  assert.equal(s.currentStreak, 1);
});

/* First finish is permanent (dp2d:first:<id>): the first record wins over the current save. */
const rec = (save) => firstResultFromSave(save, '2026-10-11T00:00:00.000Z');
t('first-result record shape', () => {
  const r = rec(win(2, { attempts: [{}, {}, {}, {}, {}, {}], desk: { everCasual: false, hints: { seeds: true } } }));
  assert.deepEqual(r, { v: 2, outcome: 'won', mistakes: 2, guesses: 6, hints: { labels: false, seeds: true, category: false },
    hintUsed: true, everCasual: false, finishedAt: '2026-10-11T00:00:00.000Z',
    attempts: null, solveOrder: null, revealedGroup: null, hintAfter: null }); // malformed attempts -> no detail
  assert.equal(rec({ phase: 'playing', mistakes: 1, desk: {} }), null);
  assert.equal(classifyFirst({ outcome: 'maybe' }), null);
});
t('loss, then Play again and win: still counted as a loss', () => {
  const firsts = { p6: rec(lost()) };
  const s = computeStats(entries, { p4: win(0), p5: win(0), p6: win(0) }, firsts);
  assert.equal(s.solved, 2); assert.equal(s.notSolved, 1); assert.equal(s.solvedPct, 67);
  assert.equal(s.currentStreak, 0); assert.equal(s.bestStreak, 2); assert.deepEqual(s.chart, [2, 0, 0, 0]);
});
t('loss, then Reset (save wiped, replay in progress): still a loss', () => {
  const s = computeStats(entries, { p6: { phase: 'playing', mistakes: 0, desk: {} } }, { p6: rec(lost()) });
  assert.equal(s.played, 1); assert.equal(s.notSolved, 1);
});
t('casual first finish, then a standard replay win: counted as casual', () => {
  const casualWin = win(5, { casual: true, desk: { everCasual: true, hints: {} } });
  const firsts = { p6: rec(casualWin) };
  assert.equal(firsts.p6.everCasual, true);
  const s = computeStats(entries, { p5: win(0), p6: win(0) }, firsts);
  assert.equal(s.casualPlayed, 1); assert.equal(s.standardPlayed, 1); assert.equal(s.solved, 1);
  assert.equal(s.currentStreak, 0); assert.deepEqual(s.chart, [1, 0, 0, 0]);
});
t('hinted first win, hint-free replay: not hint-free', () => {
  const s = computeStats(entries, { p6: win(0) }, { p6: rec(win(1, { desk: { everCasual: false, hints: { labels: true } } })) });
  assert.equal(s.hintFree, 0); assert.equal(s.perfect, 0); assert.deepEqual(s.chart, [0, 1, 0, 0]);
});
t('older games without a first record fall back to the save; bad records too', () => {
  const s = computeStats(entries, { p5: win(0), p6: lost() }, { p5: { junk: 1 }, p4: null });
  assert.equal(s.played, 2); assert.equal(s.solved, 1); assert.equal(s.notSolved, 1);
});

// ── Class stats helpers ──
const { isStatsEligible, finishPayload, classSlot, classSummary, fewerMistakesPct, menuStatsLine } = core;
t('eligibility: every dated puzzle (since 2026-10-29)', () => {
  assert.equal(isStatsEligible('cases-2026-10-12'), true);
  assert.equal(isStatsEligible('cases-2026-10-11'), true);
  assert.equal(isStatsEligible('holes-haze-and-old-paint-2026-10-08'), true);
  assert.equal(isStatsEligible('Cases-2026-10-12'), false);
  assert.equal(isStatsEligible('preview'), false);
  assert.equal(isStatsEligible(null), false);
});
t('finishPayload: only approved fields, capped', () => {
  const rec = { v: 1, outcome: 'won', mistakes: 2, guesses: 6, hints: { labels: true, seeds: false, category: true, extra: 1 }, hintUsed: true, everCasual: false, finishedAt: '2026-10-20T00:00:00Z' };
  const b = finishPayload('cases-2026-10-12', 'u', rec);
  assert.deepEqual(Object.keys(b).sort(), ['anonId', 'casual', 'event', 'guesses', 'hints', 'mistakes', 'outcome', 'puzzleId']);
  assert.deepEqual(b.hints, { labels: true, seeds: false, category: true });
  assert.equal(b.casual, false); assert.equal(b.mistakes, 2); assert.equal(b.guesses, 6);
  const c = finishPayload('x-2026-10-12', 'u', { outcome: 'won', mistakes: 33, guesses: 60, hints: {}, everCasual: true });
  assert.equal(c.mistakes, 20); assert.equal(c.guesses, 40); assert.equal(c.casual, true);
  assert.equal(finishPayload('x', 'u', { outcome: 'playing' }), null);
});
const ROW = { puzzle_id: 'x-2026-10-12', plays: 14, std_finishes: 12, std_wins: 9, mistakes_hist: [3, 3, 2, 1, 3], hint_any: 5, hint_labels: 4, hint_seeds: 1, hint_category: 2, rating_n: 10, rating_hist: [0, 1, 2, 5, 2] };
t('classSummary numbers', () => {
  const s = classSummary(ROW);
  assert.equal(s.enough, true); assert.equal(s.plays, 14); assert.equal(s.solvedPct, 75);
  assert.equal(s.avgMistakes, (3 + 4 + 3 + 12) / 12); assert.equal(s.hintPct, 42); assert.equal(s.topHint, 'Label Images');
  assert.equal(s.ratingEnough, true); assert.equal(s.ratingLabel, 'Hard'); // mean 3.8
  assert.equal(classSummary({ ...ROW, std_finishes: 9 }).enough, false);
  assert.equal(classSummary(null), null);
});
t('classSlot + fewerMistakesPct (losses worst, strictly more)', () => {
  assert.equal(classSlot({ outcome: 'won', mistakes: 0, everCasual: false }), 0);
  assert.equal(classSlot({ outcome: 'lost', mistakes: 4 }), 4);
  assert.equal(classSlot({ outcome: 'won', mistakes: 1, everCasual: true }), null);
  const s = classSummary(ROW);
  assert.equal(fewerMistakesPct(s, 0), Math.round(9 / 12 * 100));
  assert.equal(fewerMistakesPct(s, 3), 25);
  assert.equal(fewerMistakesPct(s, 4), null);
  assert.equal(fewerMistakesPct(s, null), null);
  assert.equal(fewerMistakesPct(classSummary({ ...ROW, mistakes_hist: [12, 0, 0, 0, 0] }), 0), null); // nobody worse -> omit
  assert.equal(fewerMistakesPct(classSummary({ ...ROW, std_finishes: 5 }), 0), null);
});
t('menuStatsLine thresholds', () => {
  assert.equal(menuStatsLine(classSummary(ROW)), '14 plays · 75% solved · Rated Hard');
  assert.equal(menuStatsLine(classSummary({ ...ROW, rating_hist: [0, 1, 2, 3, 2] })), '14 plays · 75% solved');
  assert.equal(menuStatsLine(classSummary({ ...ROW, std_finishes: 9 })), 'Rated Hard');
  assert.equal(menuStatsLine(null), '');
});
console.log(n, 'tests passed');
