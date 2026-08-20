// ── Stage + render loop ───────────────────────────────────────────────────
// The drawing surface and the one loop that paints it.
//
// STAGE SPACE is normalized: x, y ∈ 0..1 of the stage rect; sizes are a fraction of
// stage HEIGHT. CSS lays the stage out; this only reads the result.
//
// Stage space is NOT mirrored. The mirror is a property of the webcam source, applied
// once in drawVideoInto(). In 2.5.0 the webcam was CSS-mirrored, so every overlay
// canvas was too, so every draw needed its own ctx.scale(-1,1) un-flip (§9.2).

export const BACKGROUND = -200;
export const FOREGROUND = 200;

export const POSITIONS = {
  CENTER: { x: 0.50, y: 0.50 }, LEFT: { x: 0.22, y: 0.50 }, RIGHT: { x: 0.78, y: 0.50 },
  FARLEFT: { x: 0.10, y: 0.50 }, FARRIGHT: { x: 0.90, y: 0.50 },
  TOP: { x: 0.50, y: 0.18 }, BOTTOM: { x: 0.50, y: 0.82 },
};

// Accepts { x, y } · "CENTER" · { at: "CENTER", dx: 0.03, dy: -0.1 }
export function resolvePlacement(at, fallback = { x: 0.5, y: 0.5 }) {
  if (at == null) return { ...fallback };
  if (typeof at === 'string') return { ...(POSITIONS[at.toUpperCase()] ?? fallback) };
  if (typeof at.at === 'string') {
    const base = POSITIONS[at.at.toUpperCase()] ?? fallback;
    return { x: base.x + (at.dx ?? 0), y: base.y + (at.dy ?? 0) };
  }
  return { x: at.x ?? fallback.x, y: at.y ?? fallback.y };
}

export class Stage {
  constructor({ el, canvas, mirror = true }) {
    this.el = el;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mirror = mirror;
    this.w = 0; this.h = 0; this.dpr = 1;
    this._bw = 0; this._bh = 0;
  }

  get aspect() { return this.h ? this.w / this.h : 16 / 9; }

  // TRAP (§9.1): assigning canvas.width CLEARS the canvas even when unchanged, and DPR
  // is fractional — so round, compare, and assign only on a real change.
  sync() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
    if (bw === this._bw && bh === this._bh) return;
    this.canvas.width = bw; this.canvas.height = bh;
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this._bw = bw; this._bh = bh;
  }

  // Reset to a known state; everything downstream draws in stage CSS px.
  beginFrame() {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    return g;
  }

  // The one cover-fit in the codebase. In 2.5.0 this math was copy-pasted into four
  // modules (§8.1). Expressed source-side: which rect OF THE VIDEO is visible.
  coverFit(video, targetW, targetH) {
    // Accepts a <video>, an <img>, or a canvas — the last is how a frozen frame arrives.
    const vw = video.videoWidth || video.naturalWidth || video.width || 0;
    const vh = video.videoHeight || video.naturalHeight || video.height || 0;
    if (!vw || !vh) return null;
    const scale = Math.max(targetW / vw, targetH / vh);
    const sw = targetW / scale, sh = targetH / scale;
    return { sw, sh, sx: (vw - sw) / 2, sy: (vh - sh) / 2 };
  }

  // Map a NORMALIZED point in the video (what MediaPipe gives) into stage space,
  // applying the mirror. After this the point is ordinary stage space and nothing flips
  // it again — that is the whole reason stage space is unmirrored (§9.2).
  videoNormToStage(nx, ny, video) {
    if (!video) return { x: nx, y: ny };
    const f = this.coverFit(video, this.w, this.h);
    if (!f) return { x: nx, y: ny };
    const vw = video.videoWidth || video.naturalWidth || video.width;
    const vh = video.videoHeight || video.naturalHeight || video.height;
    const x = (nx * vw - f.sx) / f.sw;
    const y = (ny * vh - f.sy) / f.sh;
    return { x: this.mirror ? 1 - x : x, y };
  }

  // Draw a video cover-fitted into a w×h box centred on the current origin. The mirror
  // lives here and only here.
  drawVideoInto(g, video, w, h) {
    const f = this.coverFit(video, w, h);
    if (!f) return false;
    g.save();
    if (this.mirror) g.scale(-1, 1);
    g.drawImage(video, f.sx, f.sy, f.sw, f.sh, -w / 2, -h / 2, w, h);
    g.restore();
    return true;
  }
}

// One loop, replacing 2.5.0's three setIntervals plus a rAF loop (§9.3).
export class Renderer {
  constructor(stage) {
    this.stage = stage;
    this.objects = [];
    this.beforeFrame = null;   // optional fn(now) — tracking runs here, before objects draw
    this.running = false;
    this._last = 0;
    // ?perf — where the frame actually goes. Measuring beats guessing; every stage that
    // could plausibly be the cost gets its own timer.
    this.perf = null;
  }

  _mark(key, ms) { if (this.perf) this.perf[key] = (this.perf[key] ?? 0) + ms; }

  setObjects(objects) { this.objects = objects; }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      const dt = Math.min(now - this._last, 100);  // clamp: a backgrounded tab must not
      this._last = now;                            // fast-forward every animation at once
      const t0 = this.perf && performance.now();
      try { this.frame(dt, now); } catch (err) { console.error('[renderer]', err); }
      if (this.perf) this.perf.total += performance.now() - t0;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop() { this.running = false; }

  frame(dt, now) {
    const stage = this.stage;
    const P = this.perf;
    stage.sync();

    let t = P && performance.now();
    this.beforeFrame?.(now);
    if (P) { this._mark('tracking', performance.now() - t); t = performance.now(); }

    // Every object ticks, including DOM-rendered ones (a TextBox drives its typewriter
    // here — off the frame clock, so heavy work can never starve it).
    for (const o of this.objects) o.update?.(dt, now, stage);
    if (P) { this._mark('update', performance.now() - t); t = performance.now(); }

    const g = stage.beginFrame();
    // One sorted pass, painter's algorithm (§2.1) — not stacked canvases with
    // hand-picked z-index ints, which is what collided in 2.5.0.
    // `isMask` objects are painted only into the mask buffer of whatever they mask, never
    // onto the stage — the spotlight circles themselves are never visible.
    const drawable = this.objects.filter((o) => o.draw && o.visible !== false && !o.isMask);
    drawable.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    for (const o of drawable) {
      try { o.draw(g, stage, now); }
      catch (err) {
        console.error(`[renderer] ${o.type}#${o.id}`, err);
        o.visible = false;   // one bad object must not kill the show mid-performance
      }
    }

    if (P) {
      this._mark('draw', performance.now() - t);
      if (++P.frames >= 60) {
        const per = (k) => (P[k] / P.frames).toFixed(2).padStart(6);
        console.log(
          `[perf] frame ${(P.total / P.frames).toFixed(1)}ms  ·  tracking ${per('tracking')}` +
          `  update ${per('update')}  draw ${per('draw')}  ·  silhouette ${per('silhouette')}` +
          `  objects ${this.objects.length}`);
        for (const k of Object.keys(P)) P[k] = 0;
      }
    }
  }
}
