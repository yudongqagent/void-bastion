// Procedural sci-fi audio. No sample files — every sound is synthesised from
// oscillators and a noise buffer, which keeps the whole game asset-free.
//
// Two rules make this pleasant rather than fatiguing:
//   1. Shot sounds are rate-limited and randomly detuned, so a 20/sec fire rate
//      becomes a texture instead of a machine-gun of identical clicks.
//   2. Everything routes through a master compressor, so a screen full of
//      explosions ducks smoothly instead of clipping.

export class Synth {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.noiseBuffer = null;
    this._lastShot = 0;
  }

  /** Must be called from a user gesture — browsers require it. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = new AC();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 9;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // One second of white noise, reused by every percussive sound.
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    this._startDrone();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) {
      this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.05);
    }
  }

  get t() { return this.ctx.currentTime; }

  _env(node, t0, peak, attack, decay) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _tone({ freq, freq2, type = 'sine', peak = 0.3, attack = 0.005, decay = 0.2, delay = 0, detune = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.t + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + attack + decay);
    if (detune) osc.detune.value = detune;
    this._env(gain, t0, peak, attack, decay);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  _noise({ peak = 0.3, attack = 0.002, decay = 0.25, filter = 'lowpass', freq = 1200, freq2, q = 1, delay = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const biq = this.ctx.createBiquadFilter();
    biq.type = filter;
    biq.frequency.setValueAtTime(freq, t0);
    if (freq2 != null) biq.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + attack + decay);
    biq.Q.value = q;
    const gain = this.ctx.createGain();
    this._env(gain, t0, peak, attack, decay);
    src.connect(biq).connect(gain).connect(this.master);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.05);
  }

  /** Low ambient bed so silence never feels dead. */
  _startDrone() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 240;
    for (const [f, d] of [[55, 0], [55, 7], [82.5, -5]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(filt);
      o.start();
    }
    // Slow filter sweep keeps the bed from sounding static.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain).connect(filt.frequency);
    lfo.start();
    filt.connect(g).connect(this.master);
  }

  // --- game events ----------------------------------------------------------

  shot(pitch = 1) {
    // Rate limit: past ~18 shots/sec the ear cannot separate them anyway, and
    // stacking hundreds of nodes would stall the audio thread.
    const now = performance.now();
    if (now - this._lastShot < 55) return;
    this._lastShot = now;
    this._tone({
      freq: 780 * pitch * (0.94 + Math.random() * 0.12),
      freq2: 190 * pitch, type: 'square', peak: 0.075, attack: 0.001, decay: 0.055,
    });
    this._noise({ peak: 0.03, decay: 0.04, filter: 'highpass', freq: 2600 });
  }

  hit() {
    this._noise({ peak: 0.05, attack: 0.001, decay: 0.05, filter: 'bandpass', freq: 1800, q: 2 });
  }

  kill(big = false) {
    const s = big ? 1 : 0.55;
    this._noise({
      peak: 0.13 * s, attack: 0.002, decay: big ? 0.5 : 0.2,
      filter: 'lowpass', freq: big ? 1800 : 1100, freq2: 90,
    });
    this._tone({
      freq: big ? 150 : 260, freq2: big ? 32 : 60, type: 'triangle',
      peak: 0.16 * s, attack: 0.003, decay: big ? 0.55 : 0.22,
    });
  }

  /** Wreckage hitting water: a soft, bright-then-dark noise swell. */
  splash() {
    this._noise({
      peak: 0.05, attack: 0.004, decay: 0.26,
      filter: 'bandpass', freq: 1600, freq2: 380,
    });
  }

  /** Wreckage hitting rock: shorter, lower, harder. */
  thud() {
    this._noise({
      peak: 0.055, attack: 0.001, decay: 0.16,
      filter: 'lowpass', freq: 620, freq2: 90,
    });
    this._tone({ freq: 110, freq2: 48, type: 'triangle', peak: 0.05, attack: 0.002, decay: 0.14 });
  }

  towerHit() {
    this._tone({ freq: 120, freq2: 44, type: 'sawtooth', peak: 0.22, attack: 0.002, decay: 0.3 });
    this._noise({ peak: 0.12, decay: 0.22, filter: 'lowpass', freq: 700, freq2: 120 });
  }

  shieldHit() {
    this._tone({ freq: 900, freq2: 1500, type: 'sine', peak: 0.1, attack: 0.002, decay: 0.16 });
  }

  upgrade() {
    // Rising perfect fifth — reads as "you got stronger" without a jingle.
    this._tone({ freq: 520, type: 'triangle', peak: 0.13, attack: 0.004, decay: 0.11 });
    this._tone({ freq: 780, type: 'triangle', peak: 0.11, attack: 0.004, decay: 0.15, delay: 0.06 });
  }

  ability() {
    this._tone({ freq: 220, freq2: 1400, type: 'sawtooth', peak: 0.16, attack: 0.01, decay: 0.4 });
    this._noise({ peak: 0.1, decay: 0.4, filter: 'bandpass', freq: 400, freq2: 4000, q: 3 });
  }

  waveStart(wave) {
    const root = 196 * Math.pow(2, (wave % 12) / 24);
    this._tone({ freq: root, type: 'triangle', peak: 0.1, attack: 0.01, decay: 0.3 });
    this._tone({ freq: root * 1.5, type: 'triangle', peak: 0.07, attack: 0.01, decay: 0.35, delay: 0.08 });
  }

  milestone() {
    [0, 4, 7, 12].forEach((semi, i) => {
      this._tone({
        freq: 330 * Math.pow(2, semi / 12), type: 'triangle',
        peak: 0.15, attack: 0.006, decay: 0.5, delay: i * 0.085,
      });
    });
  }

  boss() {
    this._tone({ freq: 70, freq2: 46, type: 'sawtooth', peak: 0.3, attack: 0.05, decay: 1.4 });
    this._noise({ peak: 0.14, attack: 0.1, decay: 1.3, filter: 'lowpass', freq: 500, freq2: 90 });
  }

  death() {
    this._tone({ freq: 320, freq2: 28, type: 'sawtooth', peak: 0.3, attack: 0.02, decay: 1.7 });
    this._noise({ peak: 0.22, attack: 0.01, decay: 1.6, filter: 'lowpass', freq: 2200, freq2: 60 });
  }

  prestige() {
    [0, 5, 9, 12, 16, 19].forEach((semi, i) => {
      this._tone({
        freq: 262 * Math.pow(2, semi / 12), type: 'sine',
        peak: 0.16, attack: 0.01, decay: 0.9, delay: i * 0.1,
      });
    });
    this._noise({ peak: 0.1, attack: 0.4, decay: 1.2, filter: 'highpass', freq: 600, freq2: 6000 });
  }

  click() {
    this._tone({ freq: 660, type: 'square', peak: 0.05, attack: 0.001, decay: 0.03 });
  }

  denied() {
    this._tone({ freq: 180, type: 'square', peak: 0.09, attack: 0.002, decay: 0.1 });
  }
}
