// ── Objects ───────────────────────────────────────────────────────────────
// Everything on stage is one of these: the webcam, a background, a prop, a dialogue
// box, and later the cut-out pieces of the puppeteer's own body. Not features with
// toggles — objects with positions (§1).

import { resolvePlacement } from './stage.js';
import { isReady, naturalSize } from './assets.js';

const round = (n) => (typeof n === 'number' ? +n.toFixed(4) : n);

export class StageObject {
  constructor(spec = {}, deps = {}) {
    this.id = spec.id;
    this.type = spec.type ?? 'object';
    this.deps = deps;
    this.apply(spec);
  }

  // Fields the generic panel inspector exposes. Subclasses extend this; the panel never
  // needs to know what type it is looking at — that is what replaces 2.5.0's four
  // hand-written per-feature panel blocks (§2.7).
  static fields = [
    { key: 'x', label: 'x', type: 'range', min: -0.5, max: 1.5, step: 0.005 },
    { key: 'y', label: 'y', type: 'range', min: -0.5, max: 1.5, step: 0.005 },
    { key: 'z', label: 'z', type: 'number', min: -400, max: 400, step: 1 },
    { key: 'scale', label: 'scale', type: 'range', min: 0.05, max: 3, step: 0.01 },
    { key: 'rotation', label: 'rotate', type: 'range', min: -180, max: 180, step: 1 },
    { key: 'opacity', label: 'opacity', type: 'range', min: 0, max: 1, step: 0.01 },
  ];

  get fields() { return this.constructor.fields; }

  // Become exactly this spec. Resolved scenes are absolute (§2.5), so any property a
  // PREVIOUS spec set that this one omits must be forgotten — otherwise stepping back
  // to scene 1 keeps the caption styling scene 8 applied to the same object.
  apply(spec = {}) {
    for (const k of this._specKeys ?? []) if (!(k in spec)) delete this[k];
    this._specKeys = Object.keys(spec).filter((k) => k !== 'id' && k !== 'type');

    if ('at' in spec) {
      const p = resolvePlacement(spec.at, { x: this.x ?? 0.5, y: this.y ?? 0.5 });
      this.x = p.x; this.y = p.y;
    }
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'at' || k === 'id' || k === 'type') continue;
      this[k] = v;
    }
    // A FASTENER is a pushpin (§2.4): `fasten: "rightHand"` pins this object to a
    // tracked point, and x/y become an OFFSET from it rather than an absolute position.
    this.x ??= this.fasten ? 0 : 0.5;
    this.y ??= this.fasten ? 0 : 0.5;
    this.z ??= 0;
    this.scale ??= 1; this.rotation ??= 0; this.opacity ??= 1;
    this.visible = spec.visible ?? this.visible ?? true;
    return this;
  }

  // Apply position + transform in stage CSS px, then hand the subclass a context whose
  // origin is the object's centre. Nothing mirrors anything — the mirror was resolved
  // once at the video→stage boundary (stage.js).
  draw(g, stage, t) {
    if (this.opacity <= 0) return;

    // Pinned objects follow their fastener. If the hand isn't visible there is nothing
    // to pin to, so the object simply isn't on stage this frame.
    this.pin = null;
    let x = this.x, y = this.y;
    if (this.fasten) {
      this.pin = this.deps.tracking?.fastener(this.fasten);
      if (!this.pin) return;
      x += this.pin.x;
      y += this.pin.y;
    }

    g.save();
    g.globalAlpha = this.opacity;
    g.translate(x * stage.w, y * stage.h);
    if (this.rotation) g.rotate((this.rotation * Math.PI) / 180);
    if (this.scale !== 1) g.scale(this.scale, this.scale);
    try { this.render(g, stage, t); } finally { g.restore(); }
  }

  render() {}
  dispose() {}

  // Per-object, not a fixed central field list. 2.5.0's snapshotState() was one hardcoded
  // list plus a hand-wired escape hatch, which is why most feature state could never
  // round-trip through the save button (§6).
  serialize() {
    const out = { type: this.type, x: round(this.x), y: round(this.y) };
    if (this.z !== 0) out.z = this.z;
    if (this.scale !== 1) out.scale = round(this.scale);
    if (this.rotation !== 0) out.rotation = round(this.rotation);
    if (this.opacity !== 1) out.opacity = round(this.opacity);
    if (!this.visible) out.visible = false;
    if (this.fasten) out.fasten = this.fasten;
    if (this._note) out._note = this._note;
    return out;
  }
}

// ── Image ─────────────────────────────────────────────────────────────────
// Backgrounds, props, curtains, signs — and slides. A slide is not a feature in 3.0;
// it is an image at BACKGROUND with fit:'cover' (§7).

export class ImageObject extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'size', label: 'size', type: 'range', min: 0.02, max: 2, step: 0.01 },
    { key: 'fit', label: 'fit', type: 'select', options: ['height', 'cover', 'contain'] },
    { key: 'fasten', label: 'fasten', type: 'select', options: ['', 'leftHand', 'rightHand'] },
  ];

  apply(spec) {
    super.apply(spec);
    this.size ??= this.fasten ? 1.1 : 0.5;
    this.fit ??= 'height';
    if (this.src !== this._loaded) {
      this.el = this.src != null ? this.deps.assets?.get(this.src) : null;
      this._loaded = this.src;
    }
    if (this.el?.tagName === 'VIDEO') {
      this.el.muted = !this.audio;   // videos are muted unless a scene opts in
      this.el.play?.().catch(() => {});
    }
    return this;
  }

  render(g, stage) {
    if (!isReady(this.el)) return;
    const nat = naturalSize(this.el);
    let w, h;
    if (this.fit === 'cover' || this.fit === 'contain') {
      const pick = this.fit === 'cover' ? Math.max : Math.min;
      const s = pick(stage.w / nat.w, stage.h / nat.h);
      w = nat.w * s; h = nat.h * s;
    } else {
      // Unpinned: size is a fraction of stage height. Pinned: size multiplies the
      // fastener's own size, so a hand puppet scales with the hand — matching 2.5.0's
      // puppetSize, which multiplied the measured hand span.
      const base = this.pin ? this.pin.size : 1;
      h = base * this.size * stage.h;
      w = h * (nat.w / nat.h);
    }
    // No clip needed: the canvas is exactly the stage, so it clips its own bounds.
    g.drawImage(this.el, -w / 2, -h / 2, w, h);
  }

  dispose() { if (this.el?.tagName === 'VIDEO') this.el.muted = true; }

  serialize() {
    const out = super.serialize();
    if (this.src != null) out.src = this.src;
    if (this.fit !== 'height') out.fit = this.fit; else out.size = round(this.size);
    if (this.audio) out.audio = true;
    return out;
  }
}

// ── Webcam ────────────────────────────────────────────────────────────────
// An ordinary object with x/y/z/scale — not a privileged background layer. It can fill
// the stage, or be a small framed rectangle off to one side, or be rotated. In 2.5.0
// the video was the fixed bottom of a canvas stack and none of that was expressible.

export class WebcamFeed extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'fit', label: 'fit', type: 'select', options: ['cover', 'box'] },
    { key: 'size', label: 'size', type: 'range', min: 0.05, max: 1.5, step: 0.01 },
  ];

  apply(spec) {
    super.apply(spec);
    this.fit ??= 'cover';
    this.size ??= 0.5;
    this.z ??= -100;
    return this;
  }

  _box(stage) {
    return this.fit === 'cover'
      ? { w: stage.w, h: stage.h }
      : { w: this.size * stage.h * stage.aspect, h: this.size * stage.h };
  }

  render(g, stage) {
    const { w, h } = this._box(stage);
    const cam = this.deps.camera;
    if (cam?.live) { stage.drawVideoInto(g, cam.video, w, h); return; }

    // A visible frame before permission, so the object is positionable while the camera
    // is still off — the same reason stagePuppets drew a 🙂 placeholder.
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.setLineDash([6, 6]);
    g.strokeRect(-w / 2, -h / 2, w, h);
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = `${Math.max(11, Math.round(stage.h * 0.03))}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(cam?.state === 'denied' ? 'camera blocked' : `camera ${cam?.state ?? 'off'}`, 0, 0);
    g.restore();
  }

  serialize() {
    const out = super.serialize();
    if (this.fit !== 'cover') { out.fit = this.fit; out.size = round(this.size); }
    return out;
  }
}

// ── TextBox ───────────────────────────────────────────────────────────────
// DEVIATION FROM §2.1, deliberate: this is DOM, not canvas. Everything that draws
// PIXELS goes through the one sorted canvas pass; text does not. Canvas text would cost
// the per-show CSS skin (§2.6), in-place authoring, selection and screen-reader access,
// and would mean hand-writing a bubble layout engine. The rec's target was stacked
// MIRRORED CV canvases, which one unmirrored DOM layer does not reintroduce.
// Price: text sits above the canvas, so no image can be placed on top of a TextBox.
//
// The speaker name is an xp.css TAB and the line its TABPANEL — the same idiom 2.5.0's
// dialogue overlay used, so xp.css draws the chrome and the skin only places it.

const SPEEDS = { fast: [8, 6], normal: [12, 8], medium: [25, 10], slow: [45, 35] };

export class TextBox extends StageObject {
  static fields = [
    { key: 'x', label: 'x', type: 'range', min: 0, max: 1, step: 0.005 },
    { key: 'y', label: 'y', type: 'range', min: 0, max: 1, step: 0.005 },
    { key: 'z', label: 'z', type: 'number', min: -400, max: 400, step: 1 },
    { key: 'width', label: 'width', type: 'range', min: 0.1, max: 1, step: 0.01 },
    { key: 'style', label: 'style', type: 'select', options: ['speech', 'thought', 'caption', 'plain'] },
    { key: 'speed', label: 'speed', type: 'select', options: ['fast', 'normal', 'medium', 'slow'] },
    { key: 'speaker', label: 'speaker', type: 'text' },
    { key: 'text', label: 'text', type: 'textarea' },
  ];

  apply(spec) {
    super.apply(spec);
    this.text ??= '';
    this.style ??= 'speech';
    this.speed ??= 'normal';
    this.width ??= 0.92;
    this.z ??= 200;
    return this;
  }

  get typing() { return this._typed < this.text.length; }
  finishTyping() { this._typed = this.text.length; }

  _ensureEl() {
    if (this._el) return;
    const el = document.createElement('div');
    el.innerHTML =
      '<menu role="tablist" class="textbox-tabs"><button role="tab" aria-selected="true" class="textbox-name" type="button"></button></menu>' +
      '<div role="tabpanel" class="textbox-text"></div>';
    this._tabs = el.querySelector('.textbox-tabs');
    this._name = el.querySelector('.textbox-name');
    this._body = el.querySelector('.textbox-text');
    this.deps.domLayer.appendChild(el);
    this._el = el;

    // Edit in place, as 2.5.0's edit mode did. Typing writes straight back onto the
    // object, so "save scene" serialises exactly what is on screen (§2.7).
    const commit = () => {
      this.text = this._body.textContent;
      this.speaker = this._name.textContent || null;
      this._rendered = this.text;
      this._typed = this.text.length;   // don't re-run the typewriter over an edit
      this.deps.edit?.markDirty();
    };
    this._body.addEventListener('input', commit);
    this._name.addEventListener('input', commit);
  }

  update(dt, now, stage) {
    this._ensureEl();

    // While editing, the DOM is the source of truth — the typewriter must not overwrite
    // what is being typed.
    const editing = !!this.deps.edit?.editing;
    if (this._editable !== editing) {
      this._editable = editing;
      this._body.contentEditable = editing ? 'plaintext-only' : 'inherit';
      this._name.contentEditable = editing ? 'plaintext-only' : 'inherit';
      if (editing) this.finishTyping();
    }
    if (editing && (document.activeElement === this._body || document.activeElement === this._name)) {
      return;
    }

    if (this.text !== this._rendered) {          // text changed → restart the typewriter
      this._rendered = this.text;
      this._typed = this.instant ? this.text.length : 0;
      this._acc = 0;
      this._next = 0;
    }
    // Advance on accumulated real time. dt is clamped by the renderer, so a backgrounded
    // tab resumes rather than dumping the whole line at once.
    if (this.typing) {
      this._acc += dt;
      const [base, jitter] = SPEEDS[this.speed] ?? SPEEDS.normal;
      while (this._acc >= this._next && this.typing) {
        this._acc -= this._next;
        this._typed++;
        this._next = base + Math.random() * jitter;
      }
    }

    const el = this._el;
    el.className = `textbox textbox-${this.style}${this.hoverFade ? ' textbox-hoverfade' : ''}${this.typing ? ' typing' : ''}`;
    el.style.left = `${this.x * 100}%`;
    el.style.top = `${this.y * 100}%`;
    el.style.width = `${this.width * 100}%`;
    el.style.zIndex = Math.round(this.z);
    // Opacity goes through a custom property, never an inline `opacity`. An inline value
    // would beat the .textbox-hoverfade rule and the fade would silently do nothing.
    el.style.setProperty('--o', this.opacity);
    el.hidden = this.visible === false;
    // Type scales with the stage, so a line occupies the same share of the frame at
    // every window size.
    el.style.fontSize = `${Math.max(12, stage.h * 0.036)}px`;

    // No speaker → no tab. Set this every frame, not only when the name changes: an
    // object created without a speaker starts at '' and would never trip a change check,
    // leaving an empty tab stuck above the bubble.
    const name = this.speaker ?? '';
    if (this._name.textContent !== name) this._name.textContent = name;
    this._tabs.hidden = !name;
    const shown = this.text.slice(0, this._typed);
    if (this._body.textContent !== shown) this._body.textContent = shown;
  }

  dispose() { this._el?.remove(); this._el = null; }

  serialize() {
    const out = super.serialize();
    delete out.scale; delete out.rotation;
    out.text = this.text;
    if (this.speaker) out.speaker = this.speaker;
    if (this.style !== 'speech') out.style = this.style;
    if (this.speed !== 'normal') out.speed = this.speed;
    if (this.instant) out.instant = true;
    if (this.hoverFade) out.hoverFade = true;
    out.width = round(this.width);
    return out;
  }
}

// ── BodyPart ──────────────────────────────────────────────────────────────
// A region cut from the webcam feed where a hand is detected, so the part reads as
// disembodied (§2.2). Position, z, scale and rotation behave as they do for any object.
//
// The shape is MEASURED, not invented: js/silhouette.js casts rays out from the landmark
// skeleton and finds the hand's edge in the pixels. Landmarks are skeletal — they say
// where the bones are and never how thick the hand is — so every parameter built on them
// alone was a guess at data the model does not contain. That is what `dilate`, `finger`,
// `web`, `heel`, `tipWidth`, `tipLength` and `collapse` all were.
//
// Because the measurement is clamped, a bad reading degrades to a uniform dilated
// skeleton rather than leaking into the face or the background.
//
// REQUIRED BEHAVIOUR: a closed hand merges. A paper cutout of a closed hand has merged
// fingers, and a fist is a single blob, cut and outlined as one shape. This falls out of
// the clamp — a ray from the index toward the middle finger finds no edge and clamps, so
// the two merge — and any future change must preserve it.

const PAPER = {
  cut: { bound: 0.11, skeleton: 0.01, clean: 0.015, range: 1, grow: 0.08, smooth: 0.55, points: 45, join: 'miter' },
  outline: { width: 0.045, color: '#ffffff' },
  shadow: { dx: 0, dy: 0.012, blur: 0.02, color: 'rgba(0,0,0,0.45)' },
};

export class BodyPart extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'bound', label: 'bound', type: 'range', min: 0.05, max: 0.6, step: 0.01 },
    { key: 'skeleton', label: 'skeleton', type: 'range', min: 0.01, max: 0.3, step: 0.005 },
    { key: 'clean', label: 'clean', type: 'range', min: 0, max: 0.15, step: 0.005 },
    { key: 'range', label: 'range', type: 'range', min: 0.5, max: 4, step: 0.05 },
    { key: 'grow', label: 'grow', type: 'range', min: 0, max: 0.1, step: 0.002 },
    { key: 'smooth', label: 'smooth', type: 'range', min: 0, max: 0.95, step: 0.05 },
    { key: 'points', label: 'points', type: 'range', min: 8, max: 96, step: 1 },
    { key: 'debug', label: 'show mask', type: 'checkbox' },
  ];

  apply(spec) {
    super.apply(spec);
    const paper = this.deps.paper ?? {};
    const pick = (k) => spec.cut?.[k] ?? paper.cut?.[k] ?? PAPER.cut[k];
    this.bound ??= pick('bound');        // M2 radius — the leak guard
    this.skeleton ??= pick('skeleton');  // M1 stroke width; the colour sample region
    this.clean ??= pick('clean');        // morphological kernel: fill holes, drop speckle
    this.range ??= pick('range');        // widen/narrow the Q1..Q3 colour range
    this.grow ??= pick('grow');          // final dilation, from their published code
    this.smooth ??= pick('smooth');      // temporal EMA on the radii
    this.points ??= pick('points');      // vertices in the hull
    this.join ??= pick('join');
    for (const k of ['bound', 'skeleton', 'clean', 'range', 'grow', 'smooth', 'points', 'join']) {
      if (spec.cut?.[k] !== undefined) this[k] = spec.cut[k];
    }
    this.outlineWidth ??= spec.outline?.width ?? paper.outline?.width ?? PAPER.outline.width;
    this.outlineColor ??= spec.outline?.color ?? paper.outline?.color ?? PAPER.outline.color;
    this.shadow ??= { ...PAPER.shadow, ...(paper.shadow ?? {}), ...(spec.shadow ?? {}) };
    this.debug ??= false;
    this.showCut ??= true;   // false → a bare mount for pinned puppets (§2.2)
    return this;
  }

  render(g, stage) {
    if (!this.showCut) return;
    const cam = this.deps.camera;
    const raw = this.deps.tracking?.hands?.[this.fasten];
    if (!cam?.live || !raw || !this.pin) return;

    const sil = this.deps.silhouette?.compute(this.fasten, raw, {
      bound: this.bound, skeleton: this.skeleton, clean: this.clean,
      range: this.range, grow: this.grow, smooth: this.smooth, points: this.points,
    });
    if (!sil?.polygon) return;

    // Video px → local stage px. The mirror is resolved here, at the video→stage
    // boundary, as everywhere else (§9.2).
    const { vw, vh } = sil.rect;
    const ox = this.pin.x * stage.w, oy = this.pin.y * stage.h;
    const toLocal = ([vx, vy]) => {
      const q = stage.videoNormToStage(vx / vw, vy / vh, cam.video);
      return [q.x * stage.w - ox, q.y * stage.h - oy];
    };
    const poly = sil.polygon.map(toLocal);

    const path = new Path2D();
    path.moveTo(...poly[0]);
    for (let i = 1; i < poly.length; i++) path.lineTo(...poly[i]);
    path.closePath();

    const border = this.outlineWidth * this.pin.size * stage.h;

    // 1. The paper: the polygon stroked wider in white, carrying the drop shadow. Same
    // operation at a larger radius as always (§2.3).
    g.save();
    g.lineJoin = this.join === 'round' ? 'round' : 'miter';
    g.lineCap = 'round';
    g.miterLimit = 4;
    const sh = this.shadow;
    if (sh && sh.blur !== 0) {
      g.shadowColor = sh.color;
      g.shadowBlur = sh.blur * stage.h;
      g.shadowOffsetX = sh.dx * stage.h;
      g.shadowOffsetY = sh.dy * stage.h;
    }
    g.strokeStyle = g.fillStyle = this.outlineColor;
    g.lineWidth = 2 * border;
    g.stroke(path);
    g.fill(path);
    g.restore();

    // 2. The webcam pixels, clipped to the polygon. A single closed path, so clip() works
    // directly — no offscreen compositing needed any more.
    g.save();
    g.clip(path);
    g.translate(-ox, -oy);
    g.translate(stage.w / 2, stage.h / 2);
    stage.drawVideoInto(g, cam.video, stage.w, stage.h);
    g.restore();

    if (this.debug) this._debug(g, stage, sil, poly, toLocal);
  }

  // The mask, the sampled points, and the hull, in three colours — so it is obvious which
  // stage is misbehaving when the shape looks wrong.
  _debug(g, stage, sil, poly, toLocal) {
    const { x0, y0, x1, y1, vw, vh } = sil.rect;
    const a = toLocal([x0, y0]), b = toLocal([x1, y1]);
    const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);

    g.save();
    g.globalAlpha = 0.35;                      // the mask, in cyan
    g.translate(left + w / 2, top + h / 2);
    if (stage.mirror) g.scale(-1, 1);
    g.drawImage(sil.canvas, -w / 2, -h / 2, w, h);
    g.restore();

    g.save();
    g.strokeStyle = '#00e5ff';                 // the hull
    g.lineWidth = Math.max(1, stage.h * 0.003);
    g.beginPath();
    g.moveTo(...poly[0]);
    for (let i = 1; i < poly.length; i++) g.lineTo(...poly[i]);
    g.closePath();
    g.stroke();

    g.fillStyle = '#ff2d55';                   // the sampled points
    const r = Math.max(2, stage.h * 0.005);
    for (const [x, y] of poly) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }

    g.fillStyle = '#ffd60a';                   // vertex 0, anchored at the wrist
    g.beginPath(); g.arc(poly[0][0], poly[0][1], r * 1.8, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  serialize() {
    const out = super.serialize();
    out.cut = {
      bound: round(this.bound), skeleton: round(this.skeleton), clean: round(this.clean),
      range: round(this.range), grow: round(this.grow), smooth: round(this.smooth),
      points: this.points, join: this.join,
    };
    out.outline = { width: round(this.outlineWidth), color: this.outlineColor };
    if (!this.showCut) out.showCut = false;
    if (this.debug) out.debug = true;
    return out;
  }
}

export const TYPES = { image: ImageObject, webcam: WebcamFeed, text: TextBox, bodyPart: BodyPart };
