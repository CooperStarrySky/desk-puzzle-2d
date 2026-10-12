/* ════════════════════════════════════════════════════════════════════
 * stats-class-ui.js — class-wide stats on screen: the results screen's
 * "How everyone did" block and difficulty rating row, the menu card line,
 * and the share-text line. Numbers come from stats-core.js classSummary
 * (definitions there). Nothing shows for puzzles released on or before
 * 2026-10-11, in preview mode, or when the totals can't be loaded (3 s
 * limit, hidden silently).
 *
 * Imports: state.js, stats-core.js, stats-remote.js.
 * ════════════════════════════════════════════════════════════════════ */

import { state, getFirstResult } from './state.js';
import { isStatsEligible, classSummary, classSlot, fewerMistakesPct, menuStatsLine, RATING_LABELS, CLASS_MIN } from './stats-core.js';
import { fetchClassStats, cachedClassStats, whenSent, statsSharingEnabled, getMyRating, rate, skipRating } from './stats-remote.js';

var renderToken = 0;
var $ = function (id) { return document.getElementById(id); };

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/* ── Results screen ──────────────────────────────────────────────── */

function drawChart(list, s, mine) {
  list.innerHTML = '';
  var rows = [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, 'Not solved']];
  var max = Math.max.apply(null, s.hist.concat([1]));
  rows.forEach(function (r) {
    var n = s.hist[r[0]];
    var pct = s.stdFinishes ? Math.round((n / s.stdFinishes) * 100) : 0;
    var li = el('li', 'stats-row' + (r[0] === 4 ? ' is-lost' : '') + (mine === r[0] ? ' is-you' : ''));
    li.appendChild(el('span', 'stats-row-k', r[1]));
    var track = el('span', 'stats-row-track');
    var bar = el('span', 'stats-bar', pct + '%');
    bar.style.width = Math.max(14, Math.round((n / max) * 100)) + '%';
    track.appendChild(bar);
    li.appendChild(track);
    li.setAttribute('aria-label', (r[0] === 4 ? 'Not solved' : 'Solved with ' + (r[0] === 1 ? '1 wrong guess' : r[0] + ' wrong guesses')) + ': ' + pct + '% of players' + (mine === r[0] ? ' (you)' : ''));
    list.appendChild(li);
  });
}

/** "Players rated it Hard · 58% solved" + a small distribution, or a wait note. */
function drawRated(box, s) {
  box.innerHTML = '';
  if (!s || !s.ratingEnough) {
    box.appendChild(el('p', 'results-rated-line is-wait', 'Ratings show once ' + CLASS_MIN + ' players have rated this one.'));
    return;
  }
  var line = el('p', 'results-rated-line');
  line.appendChild(el('strong', '', 'Players rated it ' + s.ratingLabel));
  if (s.enough) line.appendChild(document.createTextNode(' · ' + s.solvedPct + '% solved'));
  box.appendChild(line);
  var dist = el('ol', 'rate-dist');
  dist.setAttribute('aria-label', 'Difficulty ratings');
  var max = Math.max.apply(null, s.ratingHist.concat([1]));
  RATING_LABELS.forEach(function (name, i) {
    var n = s.ratingHist[i];
    var li = el('li', 'rate-dist-col');
    var bar = el('span', 'rate-dist-bar');
    bar.style.height = Math.max(6, Math.round((n / max) * 100)) + '%';
    li.appendChild(bar);
    li.appendChild(el('span', 'rate-dist-k', name));
    li.setAttribute('aria-label', name + ': ' + plural(n, 'rating'));
    dist.appendChild(li);
  });
  box.appendChild(dist);
}

function drawRating(puzzleId, s) {
  var row = $('results-rate');
  var rated = $('results-rated');
  if (!row || !rated) return;
  var mine = getMyRating(puzzleId);
  var canVote = statsSharingEnabled();
  row.hidden = !canVote;
  if (canVote) {
    row.querySelectorAll('[data-rate]').forEach(function (b) {
      var v = Number(b.dataset.rate);
      b.setAttribute('aria-pressed', mine && mine.rating === v ? 'true' : 'false');
      b.onclick = function () {
        rate(puzzleId, v);
        drawRating(puzzleId, s);
        refreshAfterSend(puzzleId);
      };
    });
    var skip = $('btn-rate-skip');
    if (skip) {
      skip.hidden = !!mine;
      skip.onclick = function () { skipRating(puzzleId); drawRating(puzzleId, s); };
    }
  }
  // The summary waits until this browser has voted or skipped, so it can't sway the vote.
  var reveal = !canVote || !!mine;
  rated.hidden = !reveal || (!canVote && !(s && s.ratingEnough));
  if (!rated.hidden) drawRated(rated, s);
}

function refreshAfterSend(puzzleId) {
  var token = renderToken;
  whenSent(puzzleId).then(function () { return fetchClassStats([puzzleId], { fresh: true }); }).then(function (map) {
    if (token !== renderToken || !(puzzleId in map)) return;
    var s = classSummary(map[puzzleId]);
    drawEveryone(puzzleId, s);
    var rated = $('results-rated');
    if (rated && !rated.hidden) drawRated(rated, s);
  });
}

function drawEveryone(puzzleId, s) {
  var line = $('results-class-line');
  var wait = $('results-class-wait');
  var chart = $('results-class-chart');
  var hints = $('results-class-hints');
  if (!line || !wait || !chart || !hints) return;
  var enough = !!(s && s.enough);
  wait.hidden = enough;
  line.hidden = chart.hidden = hints.hidden = !enough;
  if (!enough) return;
  line.textContent = s.plays + ' plays · ' + s.solvedPct + '% solved · avg ' + s.avgMistakes.toFixed(1) + ' wrong guesses';
  drawChart(chart, s, classSlot(getFirstResult(puzzleId)));
  hints.textContent = s.hintPct + '% used a hint' + (s.hintPct && s.topHint ? ' · most used: ' + s.topHint : '');
}

/** Fill the results screen's class block for a just-finished (or reopened) puzzle. */
export function renderResultsClass(puzzle) {
  var sec = $('results-class');
  if (!sec) return;
  var token = ++renderToken;
  sec.hidden = true;
  var id = puzzle && puzzle.id;
  if (state.previewMode || state.editorMode || !isStatsEligible(id)) return;
  var everyone = $('results-class-everyone');
  if (everyone) everyone.hidden = true;
  // Rating row first: it works even while the totals are loading or down.
  drawRating(id, undefined);
  sec.hidden = !statsSharingEnabled();
  whenSent(id).then(function () { return fetchClassStats([id], { fresh: true }); }).then(function (map) {
    if (token !== renderToken) return;
    if (!(id in map)) return; // couldn't load: leave the totals hidden
    var s = classSummary(map[id]);
    drawEveryone(id, s);
    if (everyone) everyone.hidden = false;
    drawRating(id, s);
    sec.hidden = false;
  });
}

/** Results closed or reused for a preview: stop any late update. */
export function hideResultsClass() {
  renderToken++;
  var sec = $('results-class');
  if (sec) sec.hidden = true;
}

/* ── Menu cards ──────────────────────────────────────────────────── */

/** One batched request; fills each eligible card's .pcard-class line. */
export function fillMenuClassLines(entries) {
  if (state.previewMode || state.editorMode) return;
  var ids = (entries || []).map(function (e) { return e.id; }).filter(isStatsEligible);
  if (!ids.length) return;
  fetchClassStats(ids).then(function (map) {
    ids.forEach(function (id) {
      var text = menuStatsLine(classSummary(map[id]));
      document.querySelectorAll('.pcard-class[data-class-for="' + id + '"]').forEach(function (n) {
        n.textContent = text;
        n.hidden = !text;
      });
    });
  });
}

/* ── Share text ──────────────────────────────────────────────────── */

/** "Fewer mistakes than X% of players" for the counted (first) finish, or ''. */
export function classShareLine(puzzleId) {
  if (!isStatsEligible(puzzleId)) return '';
  var row = cachedClassStats(puzzleId);
  var pct = fewerMistakesPct(classSummary(row), classSlot(getFirstResult(puzzleId)));
  return pct === null ? '' : 'Fewer wrong guesses than ' + pct + '% of players';
}
