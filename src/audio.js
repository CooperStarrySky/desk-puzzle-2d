/* ════════════════════════════════════════════════════════════════════
 * audio.js — WebAudio synthesis, file overrides, and sound-layer tools.
 *
 * Imports: state.js (state.settings.sound, state.layout).
 * ════════════════════════════════════════════════════════════════════ */

import { state, versioned } from './state.js';

export var SOUND_TUNING = {
  master: 0.5,
  'pickup-paper': { synth: 'noise', dur: 0.06, hp: 1400, lp: 6500, gain: 0.14, attack: 0.004 },
  'drop-paper':   { synth: 'noise', dur: 0.11, hp: 900, lp: 5200, gain: 0.22, attack: 0.006 },
  'film-rustle':  { synth: 'noise', dur: 0.13, hp: 320, lp: 2100, gain: 0.22, attack: 0.01 },
  'pickup-glass': { synth: 'partials', freqs: [2960, 4230], dur: 0.05, gain: 0.14 },
  'drop-glass':   { synth: 'partials', freqs: [2210, 3320], dur: 0.07, gain: 0.16 },
  'dock-glass':   { synth: 'partials', freqs: [1370, 2060], dur: 0.1, gain: 0.17 },
  'dial-tick':    { synth: 'tick', freq: 1800, dur: 0.028, gain: 0.2 },
  'pan-tick':     { synth: 'tick', freq: 1250, dur: 0.02, gain: 0.1 },
  'shuffle':      { synth: 'shuffle', dur: 0.7, f0: 400, f1: 1200, f2: 600,
                     q: 0.8, attack: 0.12, gain: 0.13 },
  'correct':      { synth: 'notes', freqs: [392, 523.25], noteDur: 0.16, gain: 0.2 },
  'wrong':        { synth: 'thud', freq: 108, dur: 0.24, gain: 0.34 },
  'wrong-crack':  { synth: 'noise', dur: 0.09, hp: 2400, lp: 9000, gain: 0.2, attack: 0.002 },
  'one-away':     { synth: 'notes', freqs: [440], noteDur: 0.1, gain: 0.12 },
  'win':          { synth: 'notes', freqs: [392, 494, 587, 784], noteDur: 0.15, gain: 0.18 },
  'lose':         { synth: 'notes', freqs: [330, 262], noteDur: 0.22, gain: 0.16 },
  scrape: {
    vOn: 250, vOff: 110, emaAlpha: 0.4, grainPx: 90, cooldownMs: 55,
    gainLo: 0.35, gainHi: 1.0, vRef: 1400,
    pitchLo: 0.89, pitchHi: 1.12, volJitterDb: 2.5, settleTick: true,
    materials: {
      paper: { hp: 1300, lp: 7000, dur: 0.045, gain: 0.09 },
      slide: { tick: true, freq: 2600, dur: 0.02, gain: 0.05 },
      film:  { hp: 300, lp: 1700, dur: 0.065, gain: 0.11 },
    },
  },
};

export var SOUND_DEFAULTS = JSON.parse(JSON.stringify(SOUND_TUNING));

export var audio = { ctx: null, master: null, buffers: {}, fileList: null, noise: null };

export function audioCtx() {
  if (!state.settings.sound) return null;
  if (!audio.ctx) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = SOUND_TUNING.master;
    audio.master.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}

/** One shared 1s noise buffer, built lazily. */
export function noiseBuffer(ctx) {
  if (!audio.noise) {
    audio.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var data = audio.noise.getChannelData(0);
    for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return audio.noise;
}

export function envGain(ctx, start, peak, attack, dur) {
  var g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(peak, start + (attack || 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  g.connect(audio.master);
  return g;
}

export function synthNoise(ctx, t, o, when) {
  var src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = o.rate || (0.9 + Math.random() * 0.25);
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = o.hp;
  var lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = o.lp;
  var start = when || t;
  src.connect(hp).connect(lp).connect(envGain(ctx, start, o.gain, o.attack, o.dur));
  src.start(start, Math.random() * 0.4, o.dur + 0.05);
}

export function synthPartials(ctx, t, o) {
  o.freqs.forEach(function (f, i) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.01);
    osc.connect(envGain(ctx, t, o.gain / (i + 1), 0.002, o.dur * (1 + i * 0.3)));
    osc.start(t);
    osc.stop(t + o.dur * 2 + 0.05);
  });
}

export function synthTick(ctx, t, o) {
  var osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = o.freq;
  osc.connect(envGain(ctx, t, o.gain, 0.001, o.dur));
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

export function synthNotes(ctx, t, o) {
  o.freqs.forEach(function (f, i) {
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    var start = t + i * o.noteDur * 0.85;
    osc.connect(envGain(ctx, start, o.gain, 0.01, o.noteDur));
    osc.start(start);
    osc.stop(start + o.noteDur + 0.05);
  });
}

export function synthThud(ctx, t, o) {
  var osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(o.freq * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(o.freq, t + o.dur * 0.5);
  osc.connect(envGain(ctx, t, o.gain, 0.004, o.dur));
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
  synthNoise(ctx, t, { hp: 80, lp: 500, gain: o.gain * 0.4, attack: 0.004, dur: o.dur * 0.5 });
}

export function synthShuffle(ctx, t, o) {
  var dur = o.dur || 0.7;
  var peak = o.gain || 0.24;
  var attack = o.attack || 0.09;
  var src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = 0.9 + Math.random() * 0.12;
  var bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = o.q || 0.8;
  bp.frequency.setValueAtTime(o.f0 || 400, t);
  bp.frequency.linearRampToValueAtTime(o.f1 || 1200, t + dur * 0.4);
  bp.frequency.linearRampToValueAtTime(o.f2 || 600, t + dur);
  var g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.linearRampToValueAtTime(peak * 0.5, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  g.connect(audio.master);
  src.connect(bp).connect(g);
  src.start(t, Math.random() * 0.3, dur + 0.1);
  src.stop(t + dur + 0.05);
}

/** Load assets/sounds/manifest.json once; fetch listed override files. */
export function loadSoundOverrides() {
  fetch(versioned('assets/sounds/manifest.json'))
    .then(function (r) { return r.ok ? r.json() : { present: [] }; })
    .then(function (m) {
      audio.fileList = {};
      (m.present || []).forEach(function (f) {
        var name = f.replace(/\.(mp3|wav|ogg)$/i, '');
        if (SOUND_TUNING[name]) audio.fileList[name] = 'assets/sounds/' + f;
      });
    })
    .catch(function () { audio.fileList = {}; });
}

export function playFileCue(ctx, name, url) {
  if (audio.buffers[name]) {
    var src = ctx.createBufferSource();
    src.buffer = audio.buffers[name];
    src.connect(audio.master);
    src.start();
    return;
  }
  fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
    return ctx.decodeAudioData(ab);
  }).then(function (buf) {
    audio.buffers[name] = buf;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.master);
    src.start();
  }).catch(function () { /* fall back silently next call */ });
}

export function playSound(name) {
  var o = SOUND_TUNING[name];
  if (!o) return;
  var ctx = audioCtx();
  if (!ctx) return;
  if (audio.fileList && audio.fileList[name]) {
    playFileCue(ctx, name, audio.fileList[name]);
    return;
  }
  var t = ctx.currentTime + 0.001;
  switch (o.synth) {
    case 'noise': synthNoise(ctx, t, o); break;
    case 'partials': synthPartials(ctx, t, o); break;
    case 'tick': synthTick(ctx, t, o); break;
    case 'notes': synthNotes(ctx, t, o); break;
    case 'thud': synthThud(ctx, t, o); break;
    case 'shuffle': synthShuffle(ctx, t, o); break;
  }
}

/** Pickup/drop cue routed by the piece's physical material. */
export function pieceSound(zone, kind) {
  if (zone === 'rack') playSound(kind === 'pickup' ? 'pickup-glass' : 'drop-glass');
  else if (zone === 'tubes') playSound('film-rustle');
  else playSound(kind === 'pickup' ? 'pickup-paper' : 'drop-paper');
}

/* ── Sound-layer tools (for ?layout editor panel) ────────────────── */

export var EDITABLE_CUES = ['pickup-paper', 'drop-paper', 'pickup-glass', 'drop-glass', 'dock-glass',
  'film-rustle', 'dial-tick', 'pan-tick', 'shuffle', 'correct', 'wrong', 'wrong-crack',
  'one-away', 'win', 'lose'];

export var CUE_DISPLAY_NAMES = { shuffle: 'scatter' };

export function applySoundLayer(sound) {
  if (!sound || typeof sound !== 'object') return;
  if (isFinite(sound.master)) {
    SOUND_TUNING.master = sound.master;
    if (audio.master) audio.master.gain.value = sound.master;
  }
  if (sound.cues) {
    EDITABLE_CUES.forEach(function (c) {
      if (isFinite(sound.cues[c]) && SOUND_TUNING[c]) SOUND_TUNING[c].gain = sound.cues[c];
    });
  }
  if (sound.scrape) {
    Object.keys(sound.scrape).forEach(function (k) {
      if (isFinite(sound.scrape[k]) && k in SOUND_TUNING.scrape) SOUND_TUNING.scrape[k] = sound.scrape[k];
    });
  }
  if (sound.matGains) {
    Object.keys(SOUND_TUNING.scrape.materials).forEach(function (m) {
      if (isFinite(sound.matGains[m])) SOUND_TUNING.scrape.materials[m].gain = sound.matGains[m];
    });
  }
}

export function collectSoundLayer() {
  var cues = {};
  EDITABLE_CUES.forEach(function (c) { cues[c] = SOUND_TUNING[c].gain; });
  var sc = SOUND_TUNING.scrape;
  return {
    master: SOUND_TUNING.master,
    cues: cues,
    scrape: {
      vOn: sc.vOn, vOff: sc.vOff, grainPx: sc.grainPx, cooldownMs: sc.cooldownMs,
      gainLo: sc.gainLo, gainHi: sc.gainHi, vRef: sc.vRef,
      pitchLo: sc.pitchLo, pitchHi: sc.pitchHi, volJitterDb: sc.volJitterDb,
    },
    matGains: {
      paper: sc.materials.paper.gain,
      slide: sc.materials.slide.gain,
      film: sc.materials.film.gain,
    },
  };
}

export function resetSoundLayer() {
  var d = JSON.parse(JSON.stringify(SOUND_DEFAULTS));
  SOUND_TUNING.master = d.master;
  EDITABLE_CUES.forEach(function (c) { SOUND_TUNING[c] = d[c]; });
  SOUND_TUNING.scrape = d.scrape;
  if (audio.master) audio.master.gain.value = d.master;
}
