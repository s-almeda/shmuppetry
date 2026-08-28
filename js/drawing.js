// ── Drawing ───────────────────────────────────────────────────────────────
// Finger-paint, ported from 2.5.0's features/drawing.js. Point one index finger and it
// stamps at the fingertip; hold up two open hands to wipe the canvas.
//
// It is an ordinary stage object, not a feature module with its own layer. 2.5.0 gave it
// a separate CSS-mirrored <canvas> at a hand-picked z-index, which is exactly the stacked
// mirrored-canvas arrangement 3.0 exists to avoid — every overlay needing its own
// un-flip, and z fights between features. Here the strokes accumulate in an offscreen
// buffer that gets blitted in the one sorted pass, so `z` puts it above or below the
// puppets like anything else.

// Landmark indices: 8 index tip, 6 its PIP; 12/10 middle, 16/14 ring, 20/18 pinky.
// Comparing tip to PIP is scale-free — it works at any distance from the camera.
const pointing = (h) =>
  h[8].y < h[6].y - 0.02 && h[12].y > h[10].y && h[16].y > h[14].y && h[20].y > h[18].y;

const openHand = (h) =>
  h[8].y < h[6].y && h[12].y < h[10].y && h[16].y < h[14].y && h[20].y < h[18].y;

export class DrawingObject {
  constructor(spec = {}, deps = {}) {
    this.id = spec.id;
    this.type = 'drawing';
    this.deps = deps;
    this._buf = null;
    this._last = null;
    this._wiped = false;
    this.apply(spec);
  }

  static fields = [
    { key: 'color', label: 'colour', type: 'text' },
    { key: 'size', label: 'size', type: 'range', min: 1, max: 30, step: 1 },
    { key: 'z', label: 'z', type: 'number', min: -400, max: 400, step: 1 },
    { key: 'opacity', label: 'opacity', type: 'range', min: 0, max: 1, step: 0.01 },
  ];

  get fields() { return DrawingObject.fields; }

  apply(spec = {}) {
    for (const k of this._specKeys ?? []) if (!(k in spec)) delete this[k];
    this._specKeys = Object.keys(spec).filter((k) => k !== 'id' && k !== 'type');
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'id' || k === 'type') continue;
      this[k] = v;
    }
    this.color ??= '#b4dd1e';
    this.size ??= 6;
    this.z ??= 45;
    this.opacity ??= 1;
    this.visible = spec.visible ?? this.visible ?? true;
    // A scene can wipe the canvas on entry. One-shot: it is an instruction, not a state,
    // so it must not sit true and re-wipe every frame.
    if (spec.clear) { this.clear(); delete this.clear_; }
    return this;
  }

  clear() {
    if (this._buf) this._buf.getContext('2d').clearRect(0, 0, this._buf.width, this._buf.height);
    this._last = null;
  }

  update(dt, now, stage) {
    // The buffer is the drawing. Assigning width/height CLEARS a canvas, so it is only
    // ever touched on a REAL size change — comparing rounded ints, because a fractional
    // rect would differ every frame and wipe the strokes continuously (§9.1).
    const w = Math.round(stage.w * stage.dpr), h = Math.round(stage.h * stage.dpr);
    if (!w || !h) return;
    if (!this._buf) this._buf = document.createElement('canvas');
    if (this._buf.width !== w || this._buf.height !== h) {
      this._buf.width = w; this._buf.height = h;
    }
    if (this.visible === false) { this._last = null; return; }

    const hands = Object.values(this.deps.tracking?.hands ?? {});
    const video = this.deps.camera?.video;
    if (!video) return;

    // Two open hands wipes it — once per gesture, so you have to drop the pose to wipe
    // again rather than it clearing on every frame you hold them up.
    if (hands.length >= 2 && hands.every(openHand)) {
      if (!this._wiped) { this.clear(); this._wiped = true; }
      this._last = null;
      return;
    }
    this._wiped = false;

    // Exactly one hand, pointing. A second hand means you are gesturing, not drawing.
    if (hands.length !== 1 || !pointing(hands[0])) { this._last = null; return; }

    // Through videoNormToStage, so the mirror is resolved once at the video→stage
    // boundary like everything else — 2.5.0 instead CSS-mirrored the layer, which is why
    // every other overlay then needed its own un-flip.
    const tip = hands[0][8];
    const p = this.deps.stage.videoNormToStage(tip.x, tip.y, video);
    const x = p.x * w, y = p.y * h;
    const g = this._buf.getContext('2d');
    const r = this.size * stage.dpr;

    g.strokeStyle = g.fillStyle = this.color;
    g.lineCap = g.lineJoin = 'round';
    g.lineWidth = r * 2;
    if (this._last) {
      // Fingertips arrive at frame rate, so consecutive stamps leave gaps at speed. The
      // connecting line is what makes it read as a stroke rather than as dots.
      g.beginPath();
      g.moveTo(this._last.x, this._last.y);
      g.lineTo(x, y);
      g.stroke();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    this._last = { x, y };
  }

  draw(g, stage) {
    if (!this._buf || this.visible === false || this.opacity <= 0) return;
    g.save();
    g.globalAlpha = this.opacity;
    // The buffer is already in device pixels, so it is blitted with the transform reset
    // rather than scaled twice.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this._buf, 0, 0);
    g.restore();
  }

  dispose() { this._buf = null; }

  serialize() {
    return {
      type: this.type,
      color: this.color,
      size: this.size,
      z: this.z,
      opacity: this.opacity,
      visible: this.visible !== false,
    };
  }
}
