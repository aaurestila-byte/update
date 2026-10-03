// Cross DJ Pro Audio Engine & Offline Performance Suite
// Compatible with Hercules DJControl Inpulse 300 MK2 & Standalone Offline Operation

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// Audio Engine Setup
const AC = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = AC.createGain();
masterGain.gain.value = 0.85;

// Master Analyser for VU Meter
const masterAnalyser = AC.createAnalyser();
masterAnalyser.fftSize = 64;
masterGain.connect(masterAnalyser);
masterAnalyser.connect(AC.destination);

// Offline Mix Recorder Engine
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordTimerInterval = null;
let recordSeconds = 0;
const mediaDest = AC.createMediaStreamDestination();
masterGain.connect(mediaDest);

// Master Clock & Sync
let xfadeCurve = 'smooth'; // 'smooth', 'sharp', 'cut'
let midiOutput = null;

// Helpers
const fmt = s => {
  if (isNaN(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${m}:${String(sc).padStart(2, '0')}.${ms}`;
};
const fmtMinSec = s => {
  if (isNaN(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const dB = v => (v < 0.5 ? -32 * (1 - v * 2) : 14 * (v * 2 - 1));
const flt = (type, freq) => {
  const n = AC.createBiquadFilter();
  n.type = type;
  n.frequency.value = freq;
  return n;
};

// Decks State Model
const D = {};

function createDeck(id) {
  const d = {
    id,
    buf: null,
    src: null,
    name: 'No track loaded',
    artist: 'Cross DJ Offline',
    off: 0,
    t0: 0,
    play: false,
    rate: 1,
    bend: 0,
    eff: 1,
    cue: 0,
    hot: new Array(8).fill(null),
    lp: null, // Loop { s, e }
    sl: null, // Slip loop state
    bpm: 0,
    origBpm: 0,
    pk: null,
    touch: false,
    prev: false,
    acc: 0,
    last: 0,
    bt: 0,
    rotation: 0,
    padMode: 'hotcue', // 'hotcue', 'roll', 'sampler', 'fx'
    // EQ Kill states
    killLo: false,
    killMi: false,
    killHi: false,
    rawLo: 0.5,
    rawMi: 0.5,
    rawHi: 0.5,
    tempoRange: 0.16, // +- 16% default
    keylock: true,
    col: id === 'A' ? '#ff7700' : '#00c3ff',
    fg: '#ffffff',
  };

  // Deck Audio Chain
  d.g = AC.createGain(); // Gain
  d.lo = flt('lowshelf', 250);
  d.mi = flt('peaking', 1000);
  d.mi.Q.value = 0.7;
  d.hi = flt('highshelf', 3500);
  d.fl = flt('allpass', 1000); // Filter
  
  // FX Send / Insert
  d.fxGain = AC.createGain();
  d.fxDelay = AC.createDelay();
  d.fxDelay.delayTime.value = 0.25;
  d.fxFeedback = AC.createGain();
  d.fxFeedback.gain.value = 0.35;
  d.fxDelay.connect(d.fxFeedback);
  d.fxFeedback.connect(d.fxDelay);
  d.fxDelay.connect(d.fxGain);

  d.v = AC.createGain(); // Channel Volume
  d.x = AC.createGain(); // Crossfader

  // Deck Analyser for Real-time Waveform Frequency Visualizer & VU Meter
  d.analyser = AC.createAnalyser();
  d.analyser.fftSize = 256;
  d.analyser.smoothingTimeConstant = 0.65;
  d.freqData = new Uint8Array(d.analyser.frequencyBinCount);
  d.timeData = new Uint8Array(d.analyser.frequencyBinCount);

  // Routing:
  // Source -> g -> lo -> mi -> hi -> fl -> v -> x -> master
  d.g.connect(d.lo);
  d.lo.connect(d.mi);
  d.mi.connect(d.hi);
  d.hi.connect(d.fl);
  d.fl.connect(d.v);
  
  // FX routing
  d.fl.connect(d.fxDelay);
  d.fxGain.connect(d.v);
  d.fxGain.gain.value = 0; // default dry

  d.v.connect(d.x);
  d.v.connect(d.analyser);
  d.x.connect(masterGain);

  d.pos = () => {
    if (!d.play) return d.off;
    let p = d.off + (AC.currentTime - d.t0) * d.eff;
    if (d.lp && p >= d.lp.e) {
      const dur = d.lp.e - d.lp.s;
      p = dur > 0 ? d.lp.s + ((p - d.lp.s) % dur) : d.lp.s;
    }
    return Math.min(p, d.buf ? d.buf.duration : 0);
  };

  d.kill = () => {
    if (d.src) {
      d.src.onended = null;
      try { d.src.stop(); } catch (e) {}
      d.src = null;
    }
  };

  d.start = () => {
    d.kill();
    if (!d.buf) return;
    const s = AC.createBufferSource();
    s.buffer = d.buf;
    s.playbackRate.value = d.eff;
    s.connect(d.g);
    s.onended = () => {
      if (d.src === s) {
        d.src = null;
        d.play = false;
        d.off = 0;
        updateTransportUI(d);
      }
    };
    d.t0 = AC.currentTime;
    s.start(0, d.off);
    d.src = s;
  };

  d.go = () => {
    if (!d.buf || d.play) return;
    d.start();
    d.play = true;
    updateTransportUI(d);
  };

  d.stop = () => {
    if (!d.play) return;
    d.off = d.pos();
    d.play = false;
    d.lp = null;
    d.kill();
    updateTransportUI(d);
  };

  d.seek = t => {
    if (!d.buf) return;
    d.lp = null;
    d.off = Math.max(0, Math.min(t, d.buf.duration - 0.05));
    if (d.play) {
      d.t0 = AC.currentTime;
      d.start();
    }
  };

  d.setEff = () => {
    if (d.play) {
      d.off = d.pos();
      d.t0 = AC.currentTime;
    }
    d.eff = Math.max(0.1, d.rate * (1 + d.bend));
    if (d.src) {
      d.src.playbackRate.value = d.eff;
    }
    const bpmDisplay = (d.bpm * d.rate).toFixed(1);
    const pitchOffset = ((d.rate - 1) * 100).toFixed(1);
    $(`#bpm-val-${d.id}`).textContent = d.bpm ? bpmDisplay : '--';
    $(`#pitch-val-${d.id}`).textContent = (d.rate >= 1 ? '+' : '') + pitchOffset + '%';
  };

  return d;
}

D.A = createDeck('A');
D.B = createDeck('B');

// Param Setter
function param(id, p, v) {
  const d = D[id];
  if (!d) return;

  if (p === 'vol') {
    d.v.gain.value = v * v;
  } else if (p === 'gain') {
    d.g.gain.value = v * 2;
  } else if (p === 'lo') {
    d.rawLo = v;
    if (!d.killLo) d.lo.gain.value = dB(v);
  } else if (p === 'mi') {
    d.rawMi = v;
    if (!d.killMi) d.mi.gain.value = dB(v);
  } else if (p === 'hi') {
    d.rawHi = v;
    if (!d.killHi) d.hi.gain.value = dB(v);
  } else if (p === 'fl') {
    if (Math.abs(v - 0.5) < 0.04) {
      d.fl.type = 'allpass';
    } else if (v < 0.5) {
      d.fl.type = 'lowpass';
      d.fl.frequency.value = 150 * Math.pow(130, v * 2);
    } else {
      d.fl.type = 'highpass';
      d.fl.frequency.value = 20 * Math.pow(400, (v - 0.5) * 2);
    }
  } else if (p === 'tempo') {
    const inverted = $('#inv-tempo')?.checked || false;
    const x = inverted ? 1 - v : v;
    d.rate = 1 + (x - 0.5) * d.tempoRange;
    d.setEff();
  }

  const el = $(`[data-d="${id}"][data-p="${p}"]`);
  if (el) el.value = Math.round(v * 100);
}

// Crossfader calculation
function xfade(x) {
  if (xfadeCurve === 'cut') {
    D.A.x.gain.value = x < 0.95 ? 1 : (1 - x) * 20;
    D.B.x.gain.value = x > 0.05 ? 1 : x * 20;
  } else if (xfadeCurve === 'sharp') {
    D.A.x.gain.value = Math.min(1, Math.cos(x * Math.PI / 2) * 1.4);
    D.B.x.gain.value = Math.min(1, Math.sin(x * Math.PI / 2) * 1.4);
  } else {
    // Equal power smooth
    D.A.x.gain.value = Math.cos(x * Math.PI / 2);
    D.B.x.gain.value = Math.sin(x * Math.PI / 2);
  }
  $('#crossfader').value = Math.round(x * 100);
}

// Controller LED Communication
function sendMidi(msg) {
  if (midiOutput) {
    try { midiOutput.send(msg); } catch (e) {}
  }
}

function updateTransportUI(d) {
  const plBtn = $(`#btn-play-${d.id}`);
  const cueBtn = $(`#btn-cue-${d.id}`);
  if (plBtn) {
    plBtn.classList.toggle('playing', d.play);
    plBtn.innerHTML = d.play ? '❚❚ PAUSE' : '▶ PLAY';
  }
  if (cueBtn) {
    const atCue = !d.play && d.buf && Math.abs(d.off - d.cue) < 0.05;
    cueBtn.classList.toggle('active', atCue);
  }

  // MIDI LEDs for Inpulse 300 MK2
  const st = 0x90 | (d.id === 'A' ? 1 : 2);
  sendMidi([st, 7, d.play ? 127 : 0]);
  sendMidi([st, 6, (!d.play && d.buf && Math.abs(d.off - d.cue) < 0.05) ? 127 : 0]);
}

function updateHotCueUI(d) {
  for (let i = 0; i < 8; i++) {
    const btn = $(`[data-deck="${d.id}"][data-pad="${i}"]`);
    if (btn && d.padMode === 'hotcue') {
      btn.classList.toggle('set', d.hot[i] != null);
      btn.textContent = d.hot[i] != null ? `CUE ${i + 1}` : `${i + 1}`;
    }
  }
}

function cueDown(d) {
  if (!d.buf) return;
  if (d.play) {
    d.stop();
    d.seek(d.cue);
  } else if (Math.abs(d.off - d.cue) < 0.05) {
    d.prev = true;
    d.go();
  } else {
    d.cue = d.off;
    updateTransportUI(d);
  }
}

function cueUp(d) {
  if (d.prev) {
    d.prev = false;
    d.stop();
    d.seek(d.cue);
  }
}

function triggerHotCue(d, i, del = false) {
  if (!d.buf) return;
  if (del) {
    d.hot[i] = null;
  } else if (d.hot[i] == null) {
    d.hot[i] = d.pos();
  } else {
    d.seek(d.hot[i]);
  }
  updateHotCueUI(d);
}

// Jog Wheel Physics & Pitch Bend
function jog(d, delta, scratch) {
  if (!d.buf) return;
  if (scratch && d.touch) {
    d.acc += delta * 0.015;
    const now = performance.now();
    if (now - d.last > 30) {
      d.seek(d.pos() + d.acc);
      d.rotation += d.acc * 50;
      d.acc = 0;
      d.last = now;
    }
  } else {
    // Pitch Bend Nudge
    d.bend = Math.max(-0.25, Math.min(0.25, delta * 0.012));
    d.setEff();
    clearTimeout(d.bt);
    d.bt = setTimeout(() => {
      d.bend = 0;
      d.setEff();
    }, 130);
  }
}

// Looping & Rolls
const ROLL_BEATS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
const LATCH_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

function loopOn(d, beats, roll = false) {
  if (!d.buf || !d.play || !d.src) return;
  const p = d.pos();
  const now = AC.currentTime;
  if (roll) d.sl = { p, t: now };
  d.off = p;
  d.t0 = now;
  const beatSec = 60 / (d.bpm || 120);
  d.lp = { s: p, e: Math.min(p + beats * beatSec, d.buf.duration) };
  d.src.loopStart = d.lp.s;
  d.src.loopEnd = d.lp.e;
  d.src.loop = true;
  $(`#loop-active-${d.id}`)?.classList.add('active');
}

function loopOff(d, slip = false) {
  if (!d.lp) return;
  const now = AC.currentTime;
  if (slip && d.sl) {
    const t = d.sl.p + (now - d.sl.t) * d.eff;
    d.sl = null;
    d.seek(t);
  } else {
    const p = d.pos();
    d.lp = null;
    d.off = p;
    d.t0 = now;
    if (d.src) d.src.loop = false;
  }
  $(`#loop-active-${d.id}`)?.classList.remove('active');
}

function syncDeck(d) {
  const other = d.id === 'A' ? D.B : D.A;
  if (!d.bpm || !other.bpm) return;
  const targetRate = (other.bpm * other.rate) / d.bpm;
  const range = d.tempoRange;
  const v = Math.max(0, Math.min(1, (targetRate - 1) / range + 0.5));
  param(d.id, 'tempo', v);

  // Phase sync to nearest beat
  if (other.play && d.play && d.buf && other.buf) {
    const beatLenOther = 60 / (other.bpm * other.rate);
    const beatLenThis = 60 / (d.bpm * d.rate);
    const phase = (other.pos() % beatLenOther) / beatLenOther;
    const curBeat = Math.floor(d.pos() / beatLenThis);
    d.seek(curBeat * beatLenThis + phase * beatLenThis);
  }

  $(`#btn-sync-${d.id}`)?.classList.add('synced');
  setTimeout(() => $(`#btn-sync-${d.id}`)?.classList.remove('synced'), 600);
}

// Sampler Bank
const SAMPLER_BUFFERS = new Array(8).fill(null);
const samplerGain = AC.createGain();
samplerGain.gain.value = 0.9;
samplerGain.connect(masterGain);

function triggerSample(idx) {
  const buf = SAMPLER_BUFFERS[idx];
  if (!buf) return;
  const s = AC.createBufferSource();
  s.buffer = buf;
  s.connect(samplerGain);
  s.start();

  const pad = $(`[data-sm="${idx}"]`);
  if (pad) {
    pad.style.boxShadow = '0 0 16px var(--led-green)';
    setTimeout(() => { pad.style.boxShadow = ''; }, 150);
  }
}

// BPM Detection & Peak Extraction
function detectBPM(buf) {
  const x = buf.getChannelData(0);
  const hop = Math.floor(buf.sampleRate / 100);
  const tot = Math.floor(x.length / hop);
  const n = Math.min(tot, 6000);
  const s0 = Math.floor((tot - n) / 2);
  const e = new Float32Array(n);
  const o = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let a = 0;
    const b = (s0 + i) * hop;
    for (let j = 0; j < hop; j += 4) a += Math.abs(x[b + j] || 0);
    e[i] = a;
  }
  for (let i = 1; i < n; i++) o[i] = Math.max(0, e[i] - e[i - 1]);

  let best = 0;
  let bb = 124;
  for (let bpm = 75; bpm <= 175; bpm += 0.5) {
    const lag = 6000 / bpm;
    let sc = 0;
    for (let i = 0; i + lag + 1 < n; i++) {
      const k = Math.floor(i + lag);
      const f = i + lag - k;
      sc += o[i] * (o[k] * (1 - f) + (o[k + 1] || 0) * f);
    }
    if (sc > best) {
      best = sc;
      bb = bpm;
    }
  }
  return bb;
}

function extractPeaks(buf, count = 600) {
  const x = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(x.length / count));
  const p = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let m = 0;
    for (let j = 0; j < step; j += 16) {
      m = Math.max(m, Math.abs(x[i * step + j] || 0));
    }
    p[i] = m;
  }
  const max = Math.max(...p) || 1;
  return p.map(v => v / max);
}

// Load Audio File / Buffer into Deck
async function loadTrackIntoDeck(d, buffer, title, artist = 'Local Track') {
  AC.resume();
  d.stop();
  d.off = 0;
  d.cue = 0;
  d.hot = new Array(8).fill(null);
  d.buf = buffer;
  d.name = title;
  d.artist = artist;
  d.pk = extractPeaks(buffer);
  d.bpm = detectBPM(buffer);
  d.origBpm = d.bpm;

  $(`#track-name-${d.id}`).textContent = title;
  $(`#track-artist-${d.id}`).textContent = artist;
  $(`#bpm-val-${d.id}`).textContent = d.bpm.toFixed(1);
  $(`#time-large-${d.id}`).textContent = fmt(0);
  $(`#time-sub-${d.id}`).textContent = `-${fmt(buffer.duration)}`;

  updateTransportUI(d);
  updateHotCueUI(d);
}

// Real-time Frequency Spectrum Analyzer Extractor
function getDeckFrequencyActivity(d) {
  if (!d.play || !d.buf) {
    return { bass: 0, mid: 0, high: 0, total: 0, hasSignal: false };
  }
  d.analyser.getByteFrequencyData(d.freqData);
  d.analyser.getByteTimeDomainData(d.timeData);

  // Bass / Low frequencies: bins 1 - 8 (approx 30Hz - 300Hz)
  let bassSum = 0;
  for (let i = 1; i <= 8; i++) bassSum += d.freqData[i];
  const bass = bassSum / (8 * 255);

  // Mid frequencies: bins 9 - 34 (approx 300Hz - 2.8kHz)
  let midSum = 0;
  for (let i = 9; i <= 34; i++) midSum += d.freqData[i];
  const mid = midSum / (26 * 255);

  // High frequencies: bins 35 - 80 (approx 2.8kHz - 10.5kHz)
  let highSum = 0;
  for (let i = 35; i <= 80; i++) highSum += d.freqData[i];
  const high = highSum / (46 * 255);

  const total = Math.min(1, bass * 0.55 + mid * 0.3 + high * 0.15);
  return { bass, mid, high, total, hasSignal: total > 0.015 };
}

// Overview Waveform Canvas Drawing
function drawOverviewWave(d) {
  const canvas = $(`#overview-wf-${d.id}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const isBending = Boolean(d.bend && Math.abs(d.bend) > 0.0001);
  const highlightEl = $(`#bend-highlight-${d.id}`);
  if (highlightEl) {
    highlightEl.classList.toggle(`active-bend-${d.id.toLowerCase()}`, isBending);
  }

  if (!d.pk || !d.buf) {
    ctx.fillStyle = '#1c2033';
    ctx.font = '12px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NO TRACK LOADED', W / 2, H / 2 + 4);
    return;
  }

  const T = d.buf.duration;
  const act = getDeckFrequencyActivity(d);

  // Background gradient / subtle bend wash
  if (isBending) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, W, 2);
    ctx.fillRect(0, H - 2, W, 2);
    ctx.restore();
  }

  // Draw peaks
  ctx.fillStyle = d.col;
  for (let i = 0; i < W; i++) {
    const peakIdx = Math.floor((i / W) * d.pk.length);
    const h = Math.max(1, (d.pk[peakIdx] || 0) * (H * 0.88));
    ctx.fillRect(i, (H - h) / 2, 1, h);
  }

  // Loop region highlight
  if (d.lp) {
    ctx.fillStyle = d.fg;
    ctx.globalAlpha = 0.28;
    const sX = (d.lp.s / T) * W;
    const eX = (d.lp.e / T) * W;
    ctx.fillRect(sX, 0, eX - sX, H);
    ctx.globalAlpha = 1;
  }

  // Cue point
  ctx.fillStyle = '#f59e0b';
  ctx.globalAlpha = 0.85;
  ctx.fillRect((d.cue / T) * W, 0, 2, H);

  // Hot cues
  ctx.fillStyle = '#38bdf8';
  d.hot.forEach((hc, idx) => {
    if (hc != null) {
      const x = (hc / T) * W;
      ctx.fillRect(x - 1, 0, 2, H);
      ctx.font = '9px monospace';
      ctx.fillText(`${idx + 1}`, x + 3, 10);
    }
  });

  // Playhead with real-time frequency aura
  const curX = (d.pos() / T) * W;
  if (d.play && act.hasSignal) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.2 + act.bass * 0.5;
    const auraW = 8 + act.bass * 20;
    ctx.fillRect(Math.max(0, curX - auraW / 2), 0, auraW, H);
    ctx.restore();
  }

  // Playhead with jog bend aura
  if (isBending) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.max(0, curX - 6), 0, 12, H);
    ctx.font = '700 10px ui-sans-serif, sans-serif';
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.9;
    const pct = (d.bend * 100).toFixed(1);
    ctx.fillText(`${d.bend > 0 ? '▶ +' : '◀ '}${pct}% BEND`, W - 8, 12);
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(curX, 0, 2, H);
}

// Parallel Scrolling Waveform Canvas (Cross DJ Signature Feature)
function drawParallelWaves() {
  const canvas = $('#parallel-waves');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const halfH = H / 2;
  const centerLine = W / 2;

  // Deck A (Top Half - Orange)
  drawSingleParallelWave(ctx, D.A, 0, halfH, W, '#ff7700');

  // Deck B (Bottom Half - Cyan)
  drawSingleParallelWave(ctx, D.B, halfH, halfH, W, '#00c3ff');

  // Divider
  ctx.fillStyle = '#1c2032';
  ctx.fillRect(0, halfH - 1, W, 2);

  // Center Playhead Line
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.fillRect(centerLine - 1, 0, 2, H);
  ctx.shadowBlur = 0;

  // Beat phase sync marker
  updatePhaseMeter();
}

function drawSingleParallelWave(ctx, d, topY, height, W, color) {
  if (!d.buf || !d.pk) {
    ctx.fillStyle = '#141724';
    ctx.fillRect(0, topY, W, height);
    return;
  }

  const act = getDeckFrequencyActivity(d);
  const curPos = d.pos();
  const dur = d.buf.duration;
  const centerLine = W / 2;
  const centerY = topY + height / 2;
  const zoomSec = 8; // 8 seconds visible across the screen
  const pxPerSec = W / zoomSec;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, topY, W, height);
  ctx.clip();

  // Subtle live frequency background reactive wash when playing
  if (d.play && act.total > 0.02) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.04 + act.bass * 0.07;
    ctx.fillRect(0, topY, W, height);
  }

  const totalPeaks = d.pk.length;
  const peakTimeStep = dur / totalPeaks;

  const startSec = curPos - (centerLine / pxPerSec);
  const endSec = curPos + ((W - centerLine) / pxPerSec);

  const startIdx = Math.max(0, Math.floor(startSec / peakTimeStep));
  const endIdx = Math.min(totalPeaks, Math.ceil(endSec / peakTimeStep));

  // Render scrolling waveform bars with 3-band frequency visualization
  for (let i = startIdx; i < endIdx; i++) {
    const peakTime = i * peakTimeStep;
    const x = centerLine + (peakTime - curPos) * pxPerSec;
    const baseH = (d.pk[i] || 0) * (height * 0.82);

    // Live frequency analyzer modulation for bars near the center active playhead
    const distFromCenter = Math.abs(x - centerLine);
    let liveH = baseH;

    if (d.play && distFromCenter < 240) {
      const prox = 1 - (distFromCenter / 240); // 1 at center, 0 at outer edges
      const boost = (act.bass * 0.55 + act.mid * 0.3) * prox;
      liveH = baseH * (1 + boost);
    }

    // Modern 3-Band Frequency Waveform rendering:
    // Layer 1: High frequency outer envelope (lighter shade for treble/air)
    ctx.fillStyle = d.id === 'A' ? '#ffaa44' : '#66e0ff';
    ctx.globalAlpha = 0.35 + act.high * 0.45;
    ctx.fillRect(x, centerY - liveH / 2, 2, liveH);

    // Layer 2: Main deck color mid envelope (vocals, snares, synths)
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    const midH = liveH * 0.65;
    ctx.fillRect(x, centerY - midH / 2, 2, midH);

    // Layer 3: Bass punch core (bright energetic center line that pops on kicks)
    if (d.play && act.bass > 0.1) {
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = Math.min(0.95, act.bass * 0.9);
      const bassH = Math.max(2, liveH * 0.35 * (1 + act.bass * 0.5));
      ctx.fillRect(x, centerY - bassH / 2, 2, bassH);
    }
  }

  // Active Loop region shading in scrolling waveform
  if (d.lp) {
    const sX = centerLine + (d.lp.s - curPos) * pxPerSec;
    const eX = centerLine + (d.lp.e - curPos) * pxPerSec;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.22;
    ctx.fillRect(sX, topY, eX - sX, height);
  }

  // Beat Grid Marker Lines with beat transient highlighting
  if (d.bpm > 0) {
    const beatDur = 60 / (d.bpm * d.rate);
    const startBeat = Math.floor(startSec / beatDur);
    const endBeat = Math.ceil(endSec / beatDur);

    for (let b = startBeat; b <= endBeat; b++) {
      const bTime = b * beatDur;
      const bx = centerLine + (bTime - curPos) * pxPerSec;
      const isBar = b % 4 === 0;

      // Glow beat lines near center on bass kicks
      const bDist = Math.abs(bx - centerLine);
      const nearCenter = d.play && bDist < 30 && act.bass > 0.3;

      ctx.fillStyle = nearCenter ? '#ffffff' : (isBar ? '#ffffff' : '#8899aa');
      ctx.globalAlpha = nearCenter ? 0.9 : (isBar ? 0.6 : 0.22);
      ctx.fillRect(bx, topY, isBar ? 2 : 1, height);
    }
  }

  // Real-Time Frequency Activity Oscilloscope / Spectrum Ribbon at Playhead
  if (d.play && act.hasSignal) {
    // Dynamic radial frequency pulse at center
    const pulseRad = 20 + act.bass * 35;
    const grad = ctx.createRadialGradient(centerLine, centerY, 0, centerLine, centerY, pulseRad);
    grad.addColorStop(0, d.id === 'A' ? 'rgba(255, 119, 0, 0.5)' : 'rgba(0, 195, 255, 0.5)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(centerLine - pulseRad, topY, pulseRad * 2, height);

    // Live frequency bin needles (14 active spectrum bars dancing right around the center playhead)
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    const bars = 14;
    for (let b = 0; b < bars; b++) {
      const binIdx = Math.min(d.freqData.length - 1, b * 3 + 2);
      const binVal = (d.freqData[binIdx] || 0) / 255;
      const bh = Math.max(1, binVal * (height * 0.88));
      const bx = centerLine + (b - bars / 2) * 3;
      ctx.fillRect(bx, centerY - bh / 2, 2, bh);
    }
  }

  // Real-time Frequency Spectrum HUD (LOW / MID / HIGH Activity)
  ctx.save();
  ctx.font = '700 9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Deck identifier
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.fillText(d.id, 10, topY + 4);

  // Live frequency meters
  if (d.play) {
    const meterY = topY + 4;
    const meterX = 28;
    const barW = 20;
    const barH = 5;

    // LOW (Bass)
    ctx.fillStyle = '#ff4444';
    ctx.globalAlpha = 0.85;
    ctx.fillText('L', meterX, meterY);
    ctx.fillRect(meterX + 10, meterY + 1, barW * act.bass, barH);

    // MID
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('M', meterX + 42, meterY);
    ctx.fillRect(meterX + 52, meterY + 1, barW * act.mid, barH);

    // HI (Treble)
    ctx.fillStyle = '#22c55e';
    ctx.fillText('H', meterX + 84, meterY);
    ctx.fillRect(meterX + 94, meterY + 1, barW * act.high, barH);
  }
  ctx.restore();

  ctx.restore();
}

// Phase Meter (Visual Beat Alignment)
function updatePhaseMeter() {
  const marker = $('#phase-marker');
  if (!marker || !D.A.buf || !D.B.buf || !D.A.bpm || !D.B.bpm) {
    if (marker) marker.style.left = '50%';
    return;
  }

  const beatA = 60 / (D.A.bpm * D.A.rate);
  const beatB = 60 / (D.B.bpm * D.B.rate);

  const phaseA = (D.A.pos() % beatA) / beatA;
  const phaseB = (D.B.pos() % beatB) / beatB;

  let diff = phaseB - phaseA;
  if (diff > 0.5) diff -= 1;
  if (diff < -0.5) diff += 1;

  // diff is in range -0.5 to +0.5
  const pct = 50 + diff * 100;
  marker.style.left = `${Math.max(5, Math.min(95, pct))}%`;
  marker.style.background = Math.abs(diff) < 0.05 ? '#22c55e' : (Math.abs(diff) < 0.15 ? '#f59e0b' : '#ef4444');
}

// Stereo VU Meter Animation
function updateVUMeters() {
  const actA = getDeckFrequencyActivity(D.A);
  const actB = getDeckFrequencyActivity(D.B);

  const levelA = D.A.play ? Math.min(8, Math.floor(actA.total * 9.5)) : 0;
  const levelB = D.B.play ? Math.min(8, Math.floor(actB.total * 9.5)) : 0;

  renderVU('A', levelA);
  renderVU('B', levelB);
}

function renderVU(deckId, activeCount) {
  const leds = $$(`#vu-meter-${deckId} .vu-led`);
  // Leds are ordered top to bottom: index 0 is RED clip, 1 is AMBER, 2-7 are GREEN
  // activeCount 8 lights up all 8
  const total = leds.length;
  leds.forEach((led, idx) => {
    // idx 0 is top
    const fromBottom = total - 1 - idx;
    led.classList.toggle('on', fromBottom < activeCount);
  });
}

// Vinyl Platter Rotation & Scratching
function animatePlatters() {
  ['A', 'B'].forEach(id => {
    const d = D[id];
    if (d.play && !d.touch) {
      // 33 RPM = ~200 deg/sec
      d.rotation += 2.5 * d.eff;
    }
    const needle = $(`#jog-needle-${id}`);
    if (needle) {
      needle.style.transform = `rotate(${d.rotation}deg)`;
    }
  });
}

// -------------------------------------------------------------
// OFFLINE AUDIO SYNTHESIS ENGINE (BUILT-IN DEMO TRACKS)
// Allows 100% offline instant DJ mixing with zero external files
// -------------------------------------------------------------

function generateOfflineDemoTrack(genre) {
  const sr = AC.sampleRate;
  let bpm = 124;
  let bars = 16;
  if (genre === 'techno') { bpm = 130; bars = 16; }
  else if (genre === 'dnb') { bpm = 174; bars = 32; }
  else if (genre === 'hiphop') { bpm = 95; bars = 8; }

  const beatLen = 60 / bpm;
  const barLen = beatLen * 4;
  const totalDuration = bars * barLen;
  const totalSamples = Math.floor(sr * totalDuration);

  const buffer = AC.createBuffer(2, totalSamples, sr);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Helper sound synthesizers directly into float buffers
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const beatTime = (bar * 4 + beat) * beatLen;
      const beatSamp = Math.floor(beatTime * sr);

      // Kick drum
      const isKick = (genre === 'dnb') ? (beat === 0 || beat === 2.5) : (genre === 'hiphop' ? (beat === 0 || beat === 2) : true);
      if (isKick) {
        for (let i = 0; i < sr * 0.22 && beatSamp + i < totalSamples; i++) {
          const t = i / sr;
          const freq = Math.max(35, 150 * Math.exp(-t * 28));
          const val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 14);
          left[beatSamp + i] += val * 0.7;
          right[beatSamp + i] += val * 0.7;
        }
      }

      // Snare / Clap on beat 2 and 4
      if (beat === 1 || beat === 3) {
        for (let i = 0; i < sr * 0.18 && beatSamp + i < totalSamples; i++) {
          const t = i / sr;
          const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22);
          const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 30);
          const val = (noise * 0.6 + tone * 0.4) * 0.55;
          left[beatSamp + i] += val;
          right[beatSamp + i] += val * 0.95;
        }
      }

      // Hi-Hats (8th notes and 16th notes)
      for (let sub = 0; sub < 4; sub++) {
        const hatSamp = beatSamp + Math.floor((sub * beatLen / 4) * sr);
        const isOpen = (sub === 2);
        const hatLen = isOpen ? sr * 0.12 : sr * 0.035;
        if (hatSamp < totalSamples) {
          for (let i = 0; i < hatLen && hatSamp + i < totalSamples; i++) {
            const t = i / sr;
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * (isOpen ? 25 : 80));
            left[hatSamp + i] += noise * 0.18;
            right[hatSamp + i] += noise * 0.2;
          }
        }
      }

      // Bassline note per beat
      const bassFreq = genre === 'techno' ? 48 : (genre === 'dnb' ? (bar % 2 === 0 ? 55 : 44) : 65);
      for (let i = 0; i < sr * (beatLen * 0.85) && beatSamp + i < totalSamples; i++) {
        const t = i / sr;
        const val = Math.sin(2 * Math.PI * bassFreq * t) * Math.exp(-t * 2.5);
        left[beatSamp + i] += val * 0.4;
        right[beatSamp + i] += val * 0.4;
      }
    }
  }

  // Normalize
  let maxAmp = 0;
  for (let i = 0; i < totalSamples; i++) {
    maxAmp = Math.max(maxAmp, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (maxAmp > 0) {
    const scale = 0.92 / maxAmp;
    for (let i = 0; i < totalSamples; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  return buffer;
}

// Generate Offline Sound Effects for Sampler
function initOfflineSampleBank() {
  const sr = AC.sampleRate;

  // 1. Airhorn
  const hornBuf = AC.createBuffer(2, sr * 0.7, sr);
  const hl = hornBuf.getChannelData(0);
  const hr = hornBuf.getChannelData(1);
  for (let i = 0; i < hl.length; i++) {
    const t = i / sr;
    const f1 = 466, f2 = 587, f3 = 700;
    const val = (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t) + Math.sin(2 * Math.PI * f3 * t)) / 3;
    hl[i] = hr[i] = val * Math.min(1, t * 20) * Math.exp(-t * 2.5) * 0.8;
  }
  SAMPLER_BUFFERS[0] = hornBuf;

  // 2. 808 Sub Drop
  const subBuf = AC.createBuffer(2, sr * 1.0, sr);
  const sl = subBuf.getChannelData(0);
  const srCh = subBuf.getChannelData(1);
  for (let i = 0; i < sl.length; i++) {
    const t = i / sr;
    const f = Math.max(30, 120 * Math.exp(-t * 3));
    sl[i] = srCh[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 1.5) * 0.9;
  }
  SAMPLER_BUFFERS[1] = subBuf;

  // 3. Laser Zap
  const laserBuf = AC.createBuffer(2, sr * 0.4, sr);
  const ll = laserBuf.getChannelData(0);
  const lr = laserBuf.getChannelData(1);
  for (let i = 0; i < ll.length; i++) {
    const t = i / sr;
    const f = 2400 * Math.exp(-t * 20);
    ll[i] = lr[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) * 0.75;
  }
  SAMPLER_BUFFERS[2] = laserBuf;

  // 4. Scratch Stab
  const scratchBuf = AC.createBuffer(2, sr * 0.35, sr);
  const scl = scratchBuf.getChannelData(0);
  const scr = scratchBuf.getChannelData(1);
  for (let i = 0; i < scl.length; i++) {
    const t = i / sr;
    const f = 300 + Math.sin(t * 80) * 200;
    scl[i] = scr[i] = (Math.sin(2 * Math.PI * f * t) + (Math.random() - 0.5) * 0.4) * Math.exp(-t * 8) * 0.75;
  }
  SAMPLER_BUFFERS[3] = scratchBuf;

  // 5. Clap Verb
  const clapBuf = AC.createBuffer(2, sr * 0.5, sr);
  const cl = clapBuf.getChannelData(0);
  const cr = clapBuf.getChannelData(1);
  for (let i = 0; i < cl.length; i++) {
    const t = i / sr;
    cl[i] = cr[i] = (Math.random() * 2 - 1) * Math.exp(-t * 10) * 0.7;
  }
  SAMPLER_BUFFERS[4] = clapBuf;

  // 6. Synth Chime
  const chimeBuf = AC.createBuffer(2, sr * 0.8, sr);
  const chl = chimeBuf.getChannelData(0);
  const chr = chimeBuf.getChannelData(1);
  for (let i = 0; i < chl.length; i++) {
    const t = i / sr;
    chl[i] = chr[i] = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 3.5) * 0.7;
  }
  SAMPLER_BUFFERS[5] = chimeBuf;

  // 7. Impact Boom
  const boomBuf = AC.createBuffer(2, sr * 1.2, sr);
  const bml = boomBuf.getChannelData(0);
  const bmr = boomBuf.getChannelData(1);
  for (let i = 0; i < bml.length; i++) {
    const t = i / sr;
    bml[i] = bmr[i] = ((Math.random() * 2 - 1) * 0.3 + Math.sin(2 * Math.PI * 60 * t) * 0.7) * Math.exp(-t * 2.2);
  }
  SAMPLER_BUFFERS[6] = boomBuf;

  // 8. White Noise Sweep
  const noiseBuf = AC.createBuffer(2, sr * 0.9, sr);
  const nzl = noiseBuf.getChannelData(0);
  const nzr = noiseBuf.getChannelData(1);
  for (let i = 0; i < nzl.length; i++) {
    const t = i / sr;
    nzl[i] = nzr[i] = (Math.random() * 2 - 1) * Math.sin(t / 0.9 * Math.PI) * 0.6;
  }
  SAMPLER_BUFFERS[7] = noiseBuf;
}

// -------------------------------------------------------------
// OFFLINE MIX RECORDER TO HIGH FIDELITY WAV
// -------------------------------------------------------------

function toggleMixRecording() {
  AC.resume();
  const btn = $('#btn-record-mix');
  const timer = $('#record-timer');

  if (isRecording) {
    // STOP Recording
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    clearInterval(recordTimerInterval);
    btn.classList.remove('recording');
    btn.innerHTML = `<span class="rec-dot"></span> ● REC MIX`;
  } else {
    // START Recording
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaDest.stream);
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = saveRecordedMix;
      mediaRecorder.start(250);
      isRecording = true;
      recordSeconds = 0;
      btn.classList.add('recording');
      btn.innerHTML = `<span class="rec-dot"></span> ■ STOP (0:00)`;

      recordTimerInterval = setInterval(() => {
        recordSeconds++;
        const timeStr = fmtMinSec(recordSeconds);
        btn.innerHTML = `<span class="rec-dot"></span> ■ STOP (${timeStr})`;
        if (timer) timer.textContent = timeStr;
      }, 1000);
    } catch (err) {
      alert('Could not start audio recorder: ' + err.message);
    }
  }
}

function saveRecordedMix() {
  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const title = `CrossDJ_Mix_${now.toISOString().slice(0, 10)}_${now.getHours()}h${now.getMinutes()}m.webm`;

  const list = $('#recordings-list');
  if (list) {
    const item = document.createElement('div');
    item.className = 'recording-item';
    item.innerHTML = `
      <div class="rec-info">
        <strong>${title}</strong>
        <span style="color:var(--text-dim);font-size:11px">${fmtMinSec(recordSeconds)}</span>
      </div>
      <div style="display:flex;gap:8px">
        <audio src="${url}" controls style="height:28px"></audio>
        <a href="${url}" download="${title}" class="rec-download-btn">DOWNLOAD</a>
      </div>
    `;
    list.prepend(item);
  }
}

// -------------------------------------------------------------
// MIDI CONTROLLER ENGINE (HERCULES INPULSE 300 MK2 MAPPING)
// -------------------------------------------------------------

const MIDI_MAP = { 0: 'vol', 1: 'fl', 2: 'lo', 3: 'mi', 4: 'hi', 5: 'gain', 8: 'tempo' };

function handleMidiMessage(e) {
  const [s, a, b] = e.data;
  const t = s & 0xf0;
  const ch = s & 0x0f;

  const hex = [s, a, b].map(x => x.toString(16).padStart(2, '0')).join(' ');
  const logEl = $('#midi-log-text');
  if (logEl) logEl.textContent = `MIDI: ${hex}`;

  const dk = ch === 1 ? D.A : ch === 2 ? D.B : null;

  if (t === 0x90 || t === 0x80) {
    const on = t === 0x90 && b > 0;
    if (dk) {
      if (a === 7 && on) dk.play ? dk.stop() : dk.go();
      else if (a === 6) on ? cueDown(dk) : cueUp(dk);
      else if (a === 8) dk.touch = on;
      else if (a === 5 && on) syncDeck(dk);
    }

    const pd = ch === 6 ? D.A : ch === 7 ? D.B : null;
    if (pd) {
      const idx = a & 7;
      const grp = a >> 3;
      if (grp < 2) {
        if (on) triggerHotCue(pd, idx, grp === 1);
      } else if (grp === 2) {
        on ? loopOn(pd, ROLL_BEATS[idx], true) : loopOff(pd, true);
      } else if (grp === 4) {
        if (on) (pd.lp ? loopOff(pd, false) : loopOn(pd, LATCH_BEATS[idx], false));
      } else if (grp === 6) {
        if (on) triggerSample(idx);
      }
    }
  } else if (t === 0xb0) {
    if (a >= 0x20 && a < 0x40) return;
    const v = b / 127;
    if (ch === 0 && a === 0) xfade(v);
    if (!dk) return;
    if (MIDI_MAP[a]) param(dk.id, MIDI_MAP[a], v);
    else if (a === 9 || a === 10) jog(dk, b < 64 ? b : b - 128, a === 10);
  }
}

async function connectMidiController() {
  AC.resume();
  const statusEl = $('#controller-status');
  try {
    const access = await navigator.requestMIDIAccess();
    const updatePorts = () => {
      let foundName = '';
      midiOutput = null;
      access.inputs.forEach(i => {
        if (/inpulse/i.test(i.name) || /dj/i.test(i.name) || /controller/i.test(i.name)) {
          i.onmidimessage = handleMidiMessage;
          foundName = i.name;
        } else {
          i.onmidimessage = handleMidiMessage;
        }
      });
      access.outputs.forEach(o => {
        if (/inpulse/i.test(o.name) || /dj/i.test(o.name)) midiOutput = o;
      });

      if (statusEl) {
        if (foundName) {
          statusEl.textContent = `Connected: ${foundName}`;
          statusEl.classList.add('connected');
        } else {
          statusEl.textContent = 'MIDI Ready (Touch Controls Active)';
          statusEl.classList.remove('connected');
        }
      }
    };
    updatePorts();
    access.onstatechange = updatePorts;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'MIDI Unavail (Touch / Keyboard Active)';
  }
}

// -------------------------------------------------------------
// UI INITIALIZATION & EVENT LISTENERS
// -------------------------------------------------------------

function setupEventListeners() {
  // Master Volume
  $('#master-vol')?.addEventListener('input', e => {
    masterGain.gain.value = (e.target.value / 100) * 1.2;
  });

  // Crossfader
  $('#crossfader')?.addEventListener('input', e => {
    xfade(e.target.value / 100);
  });

  // Crossfader Curve options
  $$('.curve-opt').forEach(opt => {
    opt.addEventListener('click', e => {
      $$('.curve-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      xfadeCurve = opt.dataset.curve;
      xfade($('#crossfader').value / 100);
    });
  });

  // Connect MIDI button
  $('#btn-connect-midi')?.addEventListener('click', connectMidiController);

  // Record Mix button
  $('#btn-record-mix')?.addEventListener('click', toggleMixRecording);

  // Deck Controls
  ['A', 'B'].forEach(id => {
    const d = D[id];

    // Transport buttons
    $(`#btn-play-${id}`)?.addEventListener('click', () => {
      AC.resume();
      d.play ? d.stop() : d.go();
    });

    $(`#btn-cue-${id}`)?.addEventListener('pointerdown', () => {
      AC.resume();
      cueDown(d);
    });
    $(`#btn-cue-${id}`)?.addEventListener('pointerup', () => cueUp(d));

    $(`#btn-sync-${id}`)?.addEventListener('click', () => syncDeck(d));

    // Nudge + / - buttons
    $(`#nudge-plus-${id}`)?.addEventListener('click', () => jog(d, 8, false));
    $(`#nudge-minus-${id}`)?.addEventListener('click', () => jog(d, -8, false));

    // Tempo range cycle
    $(`#tempo-range-${id}`)?.addEventListener('click', e => {
      const ranges = [0.08, 0.16, 0.50];
      const curIdx = ranges.indexOf(d.tempoRange);
      d.tempoRange = ranges[(curIdx + 1) % ranges.length];
      e.target.textContent = `±${Math.round(d.tempoRange * 100)}%`;
      const slider = $(`#tempo-slider-${id}`);
      if (slider) param(id, 'tempo', slider.value / 100);
    });

    // Keylock toggle
    $(`#keylock-${id}`)?.addEventListener('click', e => {
      d.keylock = !d.keylock;
      e.target.classList.toggle('active', d.keylock);
    });

    // Slider inputs (Volume, EQ, Filter, Tempo, Gain)
    $$(`[data-d="${id}"]`).forEach(input => {
      input.addEventListener('input', e => {
        param(id, e.target.dataset.p, e.target.value / 100);
      });
    });

    // EQ Kill buttons
    $(`#kill-hi-${id}`)?.addEventListener('click', e => {
      d.killHi = !d.killHi;
      e.target.classList.toggle('active', d.killHi);
      d.hi.gain.value = d.killHi ? -70 : dB(d.rawHi);
    });
    $(`#kill-mid-${id}`)?.addEventListener('click', e => {
      d.killMi = !d.killMi;
      e.target.classList.toggle('active', d.killMi);
      d.mi.gain.value = d.killMi ? -70 : dB(d.rawMi);
    });
    $(`#kill-low-${id}`)?.addEventListener('click', e => {
      d.killLo = !d.killLo;
      e.target.classList.toggle('active', d.killLo);
      d.lo.gain.value = d.killLo ? -70 : dB(d.rawLo);
    });

    // Loop controls
    $(`#loop-in-${id}`)?.addEventListener('click', () => {
      if (d.buf) d.lp = { s: d.pos(), e: d.buf.duration };
    });
    $(`#loop-out-${id}`)?.addEventListener('click', () => {
      if (d.buf && d.lp) {
        d.lp.e = Math.max(d.lp.s + 0.1, d.pos());
        d.start();
        $(`#loop-active-${id}`)?.classList.add('active');
      }
    });
    $(`#loop-active-${id}`)?.addEventListener('click', () => {
      d.lp ? loopOff(d, false) : loopOn(d, 4, false);
    });
    $(`#loop-half-${id}`)?.addEventListener('click', () => {
      if (d.lp) {
        const half = (d.lp.e - d.lp.s) / 2;
        d.lp.e = d.lp.s + half;
      }
    });
    $(`#loop-double-${id}`)?.addEventListener('click', () => {
      if (d.lp && d.buf) {
        const double = (d.lp.e - d.lp.s) * 2;
        d.lp.e = Math.min(d.buf.duration, d.lp.s + double);
      }
    });

    // Pad mode tabs
    $$(`[data-deck-tab="${id}"]`).forEach(tab => {
      tab.addEventListener('click', () => {
        $$(`[data-deck-tab="${id}"]`).forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        d.padMode = tab.dataset.mode;
        renderPads(d);
      });
    });

    // Performance Pads
    $$(`[data-deck="${id}"][data-pad]`).forEach(pad => {
      const idx = +pad.dataset.pad;
      pad.addEventListener('pointerdown', e => {
        AC.resume();
        if (d.padMode === 'hotcue') {
          triggerHotCue(d, idx, e.shiftKey);
        } else if (d.padMode === 'roll') {
          pad.classList.add('active-roll');
          loopOn(d, ROLL_BEATS[idx], true);
        } else if (d.padMode === 'sampler') {
          triggerSample(idx);
        } else if (d.padMode === 'fx') {
          d.fxGain.gain.value = (idx + 1) * 0.15;
          pad.classList.add('set');
        }
      });
      pad.addEventListener('pointerup', () => {
        if (d.padMode === 'roll') {
          pad.classList.remove('active-roll');
          loopOff(d, true);
        } else if (d.padMode === 'fx') {
          d.fxGain.gain.value = 0;
          pad.classList.remove('set');
        }
      });
    });

    // Overview Waveform Seek Click / Drag
    const overviewEl = $(`#overview-wf-${id}`);
    if (overviewEl) {
      overviewEl.addEventListener('pointerdown', e => {
        AC.resume();
        const rect = overviewEl.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        if (d.buf) d.seek(ratio * d.buf.duration);
      });
    }

    // Touch & Scratch on Jog Platter
    const platter = $(`#jog-platter-${id}`);
    if (platter) {
      let isScratching = false;
      let startAngle = 0;
      let prevX = 0;

      platter.addEventListener('pointerdown', e => {
        AC.resume();
        isScratching = true;
        d.touch = true;
        prevX = e.clientX;
        platter.classList.add('touching');
        platter.setPointerCapture(e.pointerId);
      });

      platter.addEventListener('pointermove', e => {
        if (!isScratching) return;
        const delta = e.clientX - prevX;
        prevX = e.clientX;
        jog(d, delta * 3, true);
      });

      const endScratch = e => {
        if (isScratching) {
          isScratching = false;
          d.touch = false;
          platter.classList.remove('touching');
          try { platter.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      platter.addEventListener('pointerup', endScratch);
      platter.addEventListener('pointercancel', endScratch);
    }
  });

  // Wheel Jog Pitch Bend on Overview and Parallel Waveforms
  document.addEventListener('wheel', e => {
    const wf = e.target.closest('.overview-canvas, .parallel-wave-canvas');
    if (wf) {
      e.preventDefault();
      AC.resume();
      let d = null;
      if (wf.id.includes('overview-wf-A')) d = D.A;
      else if (wf.id.includes('overview-wf-B')) d = D.B;
      else {
        // Parallel waveform: upper half Deck A, lower half Deck B
        const rect = wf.getBoundingClientRect();
        d = (e.clientY - rect.top) < rect.height / 2 ? D.A : D.B;
      }
      if (d && d.buf) {
        const delta = e.deltaX !== 0 ? (e.deltaX > 0 ? 4 : -4) : (e.deltaY > 0 ? -4 : 4);
        jog(d, delta, false);
      }
    }
  }, { passive: false });

  // Bottom Drawer Tabs
  $$('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab-btn').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`)?.classList.add('active');
    });
  });

  // Offline Demo Tracks Buttons
  $$('.btn-load').forEach(btn => {
    btn.addEventListener('click', async () => {
      AC.resume();
      const genre = btn.dataset.genre;
      const targetDeckId = btn.dataset.target;
      const d = D[targetDeckId];

      btn.textContent = 'BUILDING…';
      setTimeout(() => {
        const buffer = generateOfflineDemoTrack(genre);
        const titles = {
          house: 'Neon Groove (House 124)',
          techno: 'Cyber Pulse (Techno 130)',
          dnb: 'Gravity Rush (DnB 174)',
          hiphop: 'Sunset Chill (HipHop 95)',
        };
        loadTrackIntoDeck(d, buffer, titles[genre] || 'Offline Beat', 'Cross DJ Offline');
        btn.textContent = `DECK ${targetDeckId}`;
      }, 50);
    });
  });

  // Custom Local File Upload
  const fileInput = $('#audio-file-input');
  const dropZone = $('#upload-drop-zone');

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--deck-b)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = '';
    });
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      if (e.dataTransfer.files.length) handleLoadedFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) handleLoadedFiles(e.target.files);
    });
  }
}

async function handleLoadedFiles(files) {
  AC.resume();
  for (const file of files) {
    try {
      const arr = await file.arrayBuffer();
      const buf = await AC.decodeAudioData(arr);
      // Auto-load to empty deck or Deck A
      if (!D.A.buf) loadTrackIntoDeck(D.A, buf, file.name);
      else if (!D.B.buf) loadTrackIntoDeck(D.B, buf, file.name);
      else loadTrackIntoDeck(D.A, buf, file.name);
    } catch (e) {
      alert(`Could not decode audio file: ${file.name}`);
    }
  }
}

function renderPads(d) {
  const pads = $$(`[data-deck="${d.id}"][data-pad]`);
  pads.forEach((pad, idx) => {
    pad.className = 'pad-btn';
    if (d.padMode === 'hotcue') {
      pad.textContent = d.hot[idx] != null ? `CUE ${idx + 1}` : `${idx + 1}`;
      if (d.hot[idx] != null) pad.classList.add('set');
    } else if (d.padMode === 'roll') {
      const beats = ['1/16', '1/8', '1/4', '1/2', '1', '2', '4', '8'];
      pad.textContent = beats[idx];
    } else if (d.padMode === 'sampler') {
      const smNames = ['HORN', '808', 'ZAP', 'SCRTCH', 'CLAP', 'CHIME', 'BOOM', 'NOISE'];
      pad.textContent = smNames[idx];
    } else if (d.padMode === 'fx') {
      const fxNames = ['DLY 1', 'DLY 2', 'DLY 3', 'DLY 4', 'REV 1', 'REV 2', 'FLT 1', 'FLT 2'];
      pad.textContent = fxNames[idx];
    }
  });
}

// -------------------------------------------------------------
// MAIN TICK RUNTIME LOOP (60 FPS)
// -------------------------------------------------------------

function runAnimationLoop() {
  ['A', 'B'].forEach(id => {
    const d = D[id];
    if (d.buf) {
      const cur = d.pos();
      const dur = d.buf.duration;
      const rem = dur - cur;

      const timeLarge = $(`#time-large-${id}`);
      const timeSub = $(`#time-sub-${id}`);
      if (timeLarge) timeLarge.textContent = fmt(cur);
      if (timeSub) timeSub.textContent = `-${fmt(rem)}`;

      drawOverviewWave(d);
    }
  });

  drawParallelWaves();
  updateVUMeters();
  animatePlatters();

  requestAnimationFrame(runAnimationLoop);
}

// Boot Initialization
window.addEventListener('DOMContentLoaded', () => {
  // Default Mixer params
  ['A', 'B'].forEach(id => {
    param(id, 'vol', 0.85);
    param(id, 'gain', 0.5);
    param(id, 'hi', 0.5);
    param(id, 'mi', 0.5);
    param(id, 'lo', 0.5);
    param(id, 'fl', 0.5);
    param(id, 'tempo', 0.5);
  });
  xfade(0.5);

  setupEventListeners();
  initOfflineSampleBank();

  // PWA Install Handling
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = $('#btn-install-pwa');
    if (btn) btn.classList.add('primary');
  });

  function triggerPWAInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(({ outcome }) => {
        if (outcome === 'accepted') {
          const btn = $('#btn-install-pwa');
          if (btn) btn.style.display = 'none';
        }
        deferredInstallPrompt = null;
      });
    } else {
      alert(
        'To install as a desktop or mobile app:\n\n' +
        '• Chrome / Edge (PC/Mac): Click the install icon in the address bar or Menu ⋮ ➔ Install Inpulse 300 MK2 DJ.\n' +
        '• Chrome (Android): Tap Menu (⋮) ➔ Add to Home screen.\n' +
        '• Safari (iOS): Tap the Share button ➔ "Add to Home Screen".\n\n' +
        'Alternatively, use "Download ZIP" to download the full offline bundle!'
      );
    }
  }

  $('#btn-install-pwa')?.addEventListener('click', triggerPWAInstall);
  $('#btn-tab-install-pwa')?.addEventListener('click', triggerPWAInstall);

  // Preload Offline Demo Track on Deck A & Deck B so user can mix immediately
  setTimeout(() => {
    try {
      const bufA = generateOfflineDemoTrack('house');
      loadTrackIntoDeck(D.A, bufA, 'Neon Drive (House 124)', 'Cross DJ Offline');
      const bufB = generateOfflineDemoTrack('techno');
      loadTrackIntoDeck(D.B, bufB, 'Cyber Pulse (Techno 130)', 'Cross DJ Offline');
    } catch (_) {}
  }, 100);

  runAnimationLoop();
});
