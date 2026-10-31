/* ════════════════════════════════════════════════════════════════════
 * stats.js — "My stats" panel (this browser only), the menu-level
 * Settings dialog for the share-stats switch. Sending and the random
 * browser id live in stats-remote.js (re-exported here).
 *
 * Imports: state.js, stats-core.js, ui-menu.js (loadRegistry).
 * Exports: statsSharingEnabled, getAnonId, readAllSaves, readAllFirstResults,
 *   getFirstResult, openStats,
 *   closeStats, openMenuSettings, closeMenuSettings, bindStatsUi.
 * ════════════════════════════════════════════════════════════════════ */

import { state, els, SAVE_NS, FIRST_NS, getFirstResult, saveSettings, syncSettingsUi } from './state.js';
import { computeStats, classifySave, classifyFirst } from './stats-core.js';
import { loadRegistry } from './ui-menu.js';
import { statsSharingEnabled, getAnonId, onShareSettingChanged } from './stats-remote.js';

var lastFocus = null;

// The share switch and the random browser id live with the sending code.
export { statsSharingEnabled, getAnonId };

/** Every localStorage value under one key prefix, parsed, keyed by puzzle id. */
function readAllUnder(ns) {
  var out = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(ns) !== 0) continue;
      try { out[k.slice(ns.length)] = JSON.parse(localStorage.getItem(k)); } catch (e) { /* skip bad value */ }
    }
  } catch (e) { /* storage unavailable */ }
  return out;
}
/** Every dp2d:save3:* save in this browser, keyed by puzzle id. */
export function readAllSaves() { return readAllUnder(SAVE_NS); }
/** Every permanent first-result record (dp2d:first:*), keyed by puzzle id. */
export function readAllFirstResults() { return readAllUnder(FIRST_NS); }
/** The first win/loss record for one puzzle, or null (for the server stats step). */
export { getFirstResult };

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Which chart row the just-finished game belongs to (results entry). */
function highlightRow() {
  var g = state.game;
  if (!g || state.previewMode || (g.phase !== 'won' && g.phase !== 'lost')) return null;
  // The chart counts the first finish, so a replay highlights that game's row, not this one's.
  var c = classifyFirst(getFirstResult(g.puzzle.id)) ||
    classifySave({ phase: g.phase, mistakes: g.mistakes, casual: !!state.settings.casual, desk: state.desk });
  if (!c || c.casual) return null;
  return c.won ? Math.min(c.mistakes, 3) : 'lost';
}

function renderStats(s, hl) {
  var body = els.statsBody;
  body.innerHTML = '';
  var nums = el('div', 'stats-nums');
  [
    [s.played, 'Played'],
    [s.solvedPct + '%', 'Solved'],
    [s.currentStreak, 'Current streak'],
    [s.bestStreak, 'Best streak'],
    [s.perfect, 'Perfect'],
    [s.hintFree, 'Hint-free solves'],
  ].forEach(function (p) {
    var cell = el('div', 'stats-num');
    cell.appendChild(el('div', 'stats-num-v', String(p[0])));
    cell.appendChild(el('div', 'stats-num-k', p[1]));
    nums.appendChild(cell);
  });
  body.appendChild(nums);

  body.appendChild(el('h3', 'stats-chart-title', 'Guesses per game'));
  var rows = [[0, '0', s.chart[0]], [1, '1', s.chart[1]], [2, '2', s.chart[2]], [3, '3', s.chart[3]], ['lost', 'Not solved', s.notSolved]];
  var max = Math.max.apply(null, rows.map(function (r) { return r[2]; }).concat([1]));
  var chart = el('ol', 'stats-chart');
  chart.setAttribute('aria-label', 'Standard games by guesses');
  rows.forEach(function (r) {
    var li = el('li', 'stats-row' + (r[0] === 'lost' ? ' is-lost' : '') + (hl !== null && hl === r[0] ? ' is-you' : ''));
    li.appendChild(el('span', 'stats-row-k', r[1]));
    var track = el('span', 'stats-row-track');
    var bar = el('span', 'stats-bar', String(r[2]));
    bar.style.width = Math.max(8, Math.round((r[2] / max) * 100)) + '%';
    track.appendChild(bar);
    li.appendChild(track);
    li.setAttribute('aria-label', (r[0] === 'lost' ? 'Not solved' : 'Solved with ' + r[1] + ' wrong guess' + (r[1] === '1' ? '' : 'es')) + ': ' + r[2]);
    chart.appendChild(li);
  });
  body.appendChild(chart);

  var note = s.played
    ? 'Casual games count toward Played only' + (s.casualPlayed ? ' (' + s.casualPlayed + ' so far)' : '') +
      '. A streak is puzzles solved in a row in release order, in standard mode.'
    : 'Finish a puzzle to start your stats. A streak is puzzles solved in a row in release order, in standard mode.';
  body.appendChild(el('p', 'stats-note', note));
}

export function openStats() {
  if (!els.overlayStats) return;
  var hl = highlightRow();
  lastFocus = document.activeElement;
  loadRegistry().catch(function () { return { puzzles: [] }; }).then(function (registry) {
    renderStats(computeStats(registry.puzzles || [], readAllSaves(), readAllFirstResults()), hl);
    els.overlayStats.hidden = false;
    if (els.btnCloseStats) els.btnCloseStats.focus();
  });
}

export function closeStats() {
  if (!els.overlayStats || els.overlayStats.hidden) return;
  els.overlayStats.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

export function openMenuSettings() {
  if (!els.overlayMenuSettings) return;
  lastFocus = document.activeElement;
  syncSettingsUi();
  els.overlayMenuSettings.hidden = false;
  var first = els.overlayMenuSettings.querySelector('input');
  if (first) first.focus();
}

export function closeMenuSettings() {
  if (!els.overlayMenuSettings || els.overlayMenuSettings.hidden) return;
  els.overlayMenuSettings.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/** Wire buttons, the share-stats switches, Escape, and backdrop clicks. Call once. */
export function bindStatsUi() {
  [els.btnMenuStats, els.btnResultsStats].forEach(function (b) { if (b) b.addEventListener('click', openStats); });
  if (els.btnCloseStats) els.btnCloseStats.addEventListener('click', closeStats);
  if (els.btnNoticeSettings) els.btnNoticeSettings.addEventListener('click', openMenuSettings);
  // Both Settings menus carry the full privacy text in a collapsed "About your data" section.
  var aboutTpl = document.getElementById('tpl-about-data');
  if (aboutTpl) document.querySelectorAll('[data-about-data]').forEach(function (box) {
    if (!box.firstElementChild) box.appendChild(aboutTpl.content.cloneNode(true));
  });
  if (els.btnCloseMenuSettings) els.btnCloseMenuSettings.addEventListener('click', closeMenuSettings);
  document.querySelectorAll('input[data-setting="shareStats"]').forEach(function (c) {
    c.addEventListener('change', function () {
      state.settings.shareStats = c.checked;
      saveSettings();
      syncSettingsUi();
      onShareSettingChanged();
    });
  });
  [els.overlayStats, els.overlayMenuSettings].forEach(function (ov) {
    if (!ov) return;
    ov.addEventListener('click', function (ev) {
      if (ev.target !== ov) return;
      if (ov === els.overlayStats) closeStats(); else closeMenuSettings();
    });
  });
  // Capture phase so the play screen's Escape handling never sees it first.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (els.overlayStats && !els.overlayStats.hidden) { ev.stopImmediatePropagation(); closeStats(); }
    else if (els.overlayMenuSettings && !els.overlayMenuSettings.hidden) { ev.stopImmediatePropagation(); closeMenuSettings(); }
  }, true);
}
