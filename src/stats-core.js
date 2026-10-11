/* ════════════════════════════════════════════════════════════════════
 * stats-core.js — pure "My stats" math. No DOM, no localStorage, so it
 * runs unchanged under node for unit tests.
 *
 * Input: the puzzle registry entries (puzzles/index.json), a map of
 * puzzleId -> parsed save object (the dp2d:save3:<id> values), and a map
 * of puzzleId -> first-result record (the dp2d:first:<id> values).
 *
 * Definitions (owner decisions 2026-10-11, docs/08-stats-plan.md §7):
 * - Finished game: saved phase is 'won' or 'lost'. In-progress games
 *   are not counted anywhere.
 * - Casual game: casual mode was switched on at ANY point during the
 *   game (desk.everCasual). Old saves without that flag fall back to the
 *   save's last casual value.
 * - Played: every finished game, casual included.
 * - Solved %, Perfect, Hint-free, and the mistakes chart: standard
 *   (non-casual) finished games only.
 * - Streak: walk the puzzles in release order (date ascending). A puzzle
 *   extends the streak only if it was solved in standard mode. A lost
 *   game, a casual game, an unfinished game, or a puzzle never played all
 *   break it. Exception: the newest puzzle is skipped while it is still
 *   unplayed or in progress, so this week's puzzle can't break a streak
 *   before you've had the chance to finish it.
 * - Only puzzles listed in the registry count (stale saves for removed
 *   puzzles are ignored).
 * - First finish is permanent (owner decision 2026-10-11): the first win
 *   or loss of each puzzle is kept in its own record (dp2d:first:<id>),
 *   written once and never overwritten, so "Play again" or Reset after a
 *   loss can't turn it into a win. computeStats uses that record when it
 *   exists and falls back to the save for games finished before it.
 * ════════════════════════════════════════════════════════════════════ */

export var CHART_MAX_MISTAKES = 3; // standard wins have 0..3 mistakes (4 = lost)

/** Was casual mode ever on during this saved game? */
export function saveEverCasual(save) {
  if (!save || typeof save !== 'object') return false;
  var d = save.desk;
  if (d && typeof d === 'object' && typeof d.everCasual === 'boolean') return d.everCasual || save.casual === true;
  return save.casual === true;
}

/** Did this saved game use any of the three hints? */
export function saveUsedHint(save) {
  var d = save && save.desk;
  if (!d || typeof d !== 'object') return false;
  var h = d.hints || {};
  return h.labels === true || h.seeds === true || h.category === true ||
    (typeof d.hintsUsed === 'number' && d.hintsUsed > 0);
}

/** Classify one save: null (no save), 'playing', or a finished outcome. */
export function classifySave(save) {
  if (!save || typeof save !== 'object') return null;
  if (save.phase !== 'won' && save.phase !== 'lost') return { finished: false };
  var mistakes = (typeof save.mistakes === 'number' && save.mistakes >= 0) ? Math.floor(save.mistakes) : 0;
  return {
    finished: true,
    won: save.phase === 'won',
    casual: saveEverCasual(save),
    mistakes: mistakes,
    hinted: saveUsedHint(save),
  };
}

/** The permanent first-result record for a save that has just finished
    (phase 'won' or 'lost'), or null while the game is still going. This
    is also what the server stats step will send. */
export function firstResultFromSave(save, finishedAt) {
  if (!save || typeof save !== 'object' || (save.phase !== 'won' && save.phase !== 'lost')) return null;
  var h = (save.desk && save.desk.hints) || {};
  return {
    v: 1,
    outcome: save.phase,
    mistakes: (typeof save.mistakes === 'number' && save.mistakes >= 0) ? Math.floor(save.mistakes) : 0,
    guesses: Array.isArray(save.attempts) ? save.attempts.length : 0,
    hints: { labels: h.labels === true, seeds: h.seeds === true, category: h.category === true },
    hintUsed: saveUsedHint(save),
    everCasual: saveEverCasual(save),
    finishedAt: finishedAt || null,
  };
}

/** Classify a first-result record like classifySave; null if malformed. */
export function classifyFirst(rec) {
  if (!rec || typeof rec !== 'object' || (rec.outcome !== 'won' && rec.outcome !== 'lost')) return null;
  var h = rec.hints || {};
  return {
    finished: true,
    won: rec.outcome === 'won',
    casual: rec.everCasual === true,
    mistakes: (typeof rec.mistakes === 'number' && rec.mistakes >= 0) ? Math.floor(rec.mistakes) : 0,
    hinted: rec.hintUsed === true || h.labels === true || h.seeds === true || h.category === true,
  };
}

/** Registry entries in release order (oldest first). Stable on ties. */
export function releaseOrder(entries) {
  return (entries || []).map(function (e, i) { return { e: e, i: i }; })
    .sort(function (a, b) {
      var c = (a.e.date || '').localeCompare(b.e.date || '');
      return c !== 0 ? c : b.i - a.i; // index.json lists newest first
    })
    .map(function (x) { return x.e; });
}

/** firsts: optional map puzzleId -> first-result record; it wins over the save. */
export function computeStats(entries, saves, firsts) {
  saves = saves || {};
  firsts = firsts || {};
  var ordered = releaseOrder(entries);
  var out = {
    played: 0, casualPlayed: 0, standardPlayed: 0, solved: 0, solvedPct: 0,
    currentStreak: 0, bestStreak: 0, perfect: 0, hintFree: 0,
    chart: [0, 0, 0, 0], notSolved: 0,
  };
  var seq = []; // per puzzle in release order: 'win' | 'break' | 'open'
  ordered.forEach(function (entry) {
    var c = classifyFirst(firsts[entry.id]) || classifySave(saves[entry.id]);
    if (!c || !c.finished) { seq.push('open'); return; }
    out.played++;
    if (c.casual) { out.casualPlayed++; seq.push('break'); return; }
    out.standardPlayed++;
    if (c.won) {
      out.solved++;
      if (c.mistakes === 0) out.perfect++;
      if (!c.hinted) out.hintFree++;
      out.chart[Math.min(c.mistakes, CHART_MAX_MISTAKES)]++;
      seq.push('win');
    } else {
      out.notSolved++;
      seq.push('break');
    }
  });
  out.solvedPct = out.standardPlayed ? Math.round((out.solved / out.standardPlayed) * 100) : 0;

  var run = 0;
  seq.forEach(function (s) {
    run = s === 'win' ? run + 1 : 0;
    if (run > out.bestStreak) out.bestStreak = run;
  });
  var end = seq.length - 1;
  if (end >= 0 && seq[end] === 'open') end--; // newest puzzle not finished yet
  for (var k = end; k >= 0 && seq[k] === 'win'; k--) out.currentStreak++;
  return out;
}
