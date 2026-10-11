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

/* ── Class-wide stats (server totals) ─────────────────────────────────
 * Only puzzles released AFTER STATS_SINCE send or show class stats; the
 * server's record function checks the same rule. The privacy wording in
 * Settings (docs/08-stats-plan.md §8) promises exactly the fields that
 * finishPayload builds, nothing more.
 *
 * puzzle_stats row (supabase/migrations/20261011120000_play_stats.sql):
 *   plays (all finishes, casual too), std_finishes, std_wins,
 *   mistakes_hist [won0, won1, won2, won3, lost] over standard finishes,
 *   hint_any/hint_labels/hint_seeds/hint_category over standard finishes,
 *   rating_n, rating_hist [1..5].
 * Definitions used on screen:
 *   % solved      std_wins / std_finishes
 *   avg mistakes  over standard finishes; a loss counts as 4 (it ends on
 *                 the 4th mistake), a win as its mistakes (0-3)
 *   % used a hint hint_any / std_finishes
 *   "Rated X"     the mean rating, rounded to the nearest label
 *   "Fewer mistakes than X% of players"  standard finishes in a strictly
 *                 worse slot than yours (more mistakes; losses are worst)
 * ──────────────────────────────────────────────────────────────────── */

export var STATS_SINCE = '2026-10-11';
export var CLASS_MIN = 10; // show nothing below 10 standard finishes / 10 ratings
export var RATING_LABELS = ['Easy', 'Fair', 'Tricky', 'Hard', 'Brutal'];
var STATS_ID_RE = /^[a-z0-9-]+-(\d{4}-\d{2}-\d{2})$/;

/** Does this puzzle id take part in class stats (released after STATS_SINCE)? */
export function isStatsEligible(puzzleId) {
  var m = typeof puzzleId === 'string' ? STATS_ID_RE.exec(puzzleId) : null;
  return !!m && m[1] > STATS_SINCE;
}

/** The exact body sent to the record function for a first finish. Only the
    approved fields; casual games can run past the server caps, so mistakes
    and guesses are capped at 20 / 40 (casual games never reach the charts). */
export function finishPayload(puzzleId, anonId, rec) {
  if (!rec || (rec.outcome !== 'won' && rec.outcome !== 'lost')) return null;
  var h = rec.hints || {};
  var mistakes = Math.min(20, Math.max(0, Math.floor(rec.mistakes) || 0));
  var guesses = Math.min(40, Math.max(mistakes, Math.floor(rec.guesses) || 0));
  return {
    event: 'finish', puzzleId: puzzleId, anonId: anonId,
    outcome: rec.outcome, mistakes: mistakes, guesses: guesses,
    hints: { labels: h.labels === true, seeds: h.seeds === true, category: h.category === true },
    casual: rec.everCasual === true,
  };
}

/** Which class-chart slot a first-result record falls in: 0-3 (solved with
    that many mistakes), 4 (not solved), or null (casual or missing). */
export function classSlot(rec) {
  var c = classifyFirst(rec);
  if (!c || c.casual) return null;
  return c.won ? Math.min(c.mistakes, CHART_MAX_MISTAKES) : 4;
}

function hist5(a) {
  var out = [0, 0, 0, 0, 0];
  if (Array.isArray(a)) for (var i = 0; i < 5; i++) out[i] = Math.max(0, Math.floor(Number(a[i]) || 0));
  return out;
}

/** Display numbers from a puzzle_stats row (null if the row is unusable). */
export function classSummary(row) {
  if (!row || typeof row !== 'object') return null;
  var n = Math.max(0, Math.floor(Number(row.std_finishes) || 0));
  var hist = hist5(row.mistakes_hist);
  var rh = hist5(row.rating_hist);
  var rn = rh.reduce(function (a, b) { return a + b; }, 0);
  var hints = [['labels', 'Label Images', row.hint_labels], ['seeds', 'Seed the Trays', row.hint_seeds], ['category', 'Reveal a Category', row.hint_category]]
    .map(function (h) { return { key: h[0], name: h[1], n: Math.max(0, Math.floor(Number(h[2]) || 0)) }; })
    .sort(function (a, b) { return b.n - a.n; });
  var mean = rn ? (rh[0] + 2 * rh[1] + 3 * rh[2] + 4 * rh[3] + 5 * rh[4]) / rn : 0;
  return {
    plays: Math.max(n, Math.floor(Number(row.plays) || 0)),
    stdFinishes: n,
    enough: n >= CLASS_MIN,
    solvedPct: n ? Math.round((Math.floor(Number(row.std_wins) || 0) / n) * 100) : 0,
    avgMistakes: n ? (hist[1] + 2 * hist[2] + 3 * hist[3] + 4 * hist[4]) / n : 0,
    hist: hist,
    hintPct: n ? Math.round(((Math.floor(Number(row.hint_any) || 0)) / n) * 100) : 0,
    topHint: hints[0].n > 0 ? hints[0].name : '',
    ratingN: rn,
    ratingHist: rh,
    ratingEnough: rn >= CLASS_MIN,
    ratingLabel: rn ? RATING_LABELS[Math.min(4, Math.max(0, Math.round(mean) - 1))] : '',
  };
}

/** Share of standard finishes strictly worse than slot (0-100), or null. */
export function fewerMistakesPct(summary, slot) {
  if (!summary || !summary.enough || slot === null || slot === undefined || slot >= 4) return null;
  var worse = 0;
  for (var i = slot + 1; i < 5; i++) worse += summary.hist[i];
  var pct = Math.round((worse / summary.stdFinishes) * 100);
  return pct > 0 ? pct : null;
}

/** Menu card line, e.g. "142 plays · 64% solved · Rated Hard" ('' if nothing to show). */
export function menuStatsLine(summary) {
  if (!summary) return '';
  var parts = [];
  if (summary.enough) {
    parts.push(summary.plays + ' plays');
    parts.push(summary.solvedPct + '% solved');
  }
  if (summary.ratingEnough) parts.push('Rated ' + summary.ratingLabel);
  return parts.join(' · ');
}
