// ── Microphone ────────────────────────────────────────────────────────────
// RMS level from the mic, ported from 2.5.0's stagePuppets.readLevel().
//
// The FLOOR/CEIL window is the important part and the easy thing to get wrong: speech RMS
// realistically lives in ~0.04–0.22, so the level is normalised across THAT window. 2.5.0
// originally divided by the full 0–1 range, which left the signal peaking around 0.2 and
// made the whole effect invisible for months (§8.4).
//
// Camera and mic are SEPARATE getUserMedia grants (§9.4). People enable a mic-driven
// effect and wonder why nothing moves, so `ready` is exposed for the UI to surface.

const FLOOR = 0.04;   // at or below this reads as silence
const CEIL = 0.22;    // good loud speech

export class Mic {
  constructor() {
    this.ready = false;
    this.denied = false;
    this.raw = 0;       // 0..1 RMS
    this.level = 0;     // 0..1 normalised across the speech window
    this.avg = 0;       // ~1s moving average, for gates that must ignore a single clap
    this._trying = false;
  }

  async enable() {
    if (this.ready || this._trying) return this.ready;
    this._trying = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      this.ready = true;
    } catch (err) {
      this.denied = true;
      console.warn('[mic] unavailable', err);
    }
    this._trying = false;
    return this.ready;
  }

  update(dt) {
    if (!this.ready) return;
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    this.raw = Math.sqrt(sum / this.data.length);
    this.level = Math.max(0, Math.min(1, (this.raw - FLOOR) / (CEIL - FLOOR)));
    // ~1 second time constant. An EMA rather than a ring buffer: same behaviour for a
    // gate, no allocation per frame.
    this.avg += (this.level - this.avg) * Math.min(1, dt / 1000);
  }
}
