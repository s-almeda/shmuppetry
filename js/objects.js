// ── Objects ───────────────────────────────────────────────────────────────
// Everything on stage is one of these: the webcam, a background, a prop, a dialogue
// box, and later the cut-out pieces of the puppeteer's own body. Not features with
// toggles — objects with positions (§1).

import { resolvePlacement } from './stage.js';
import { resample } from './silhouette.js';
import { FACE_PARTS } from './tracking.js';
import { isReady, naturalSize } from './assets.js';

const round = (n) => (typeof n === 'number' ? +n.toFixed(4) : n);
const MOUNTS = ['hat', 'glasses', 'nose', 'beard', 'mouthTop', 'mouthBottom'];

// Shared placement for DOM-rendered objects (text, buttons, progress). They live above the
// canvas rather than in it (see the deviation note on TextBox), but they position by the
// same rules as everything else: fastener, then locks and clamps, then normalized x/y.
function placeDom(el, obj, stage) {
  let x = obj.x, y = obj.y;
  if (obj.fasten) {
    const pin = obj._resolvePin(stage);
    if (!pin) { el.hidden = true; return false; }
    x += pin.x;
    y += pin.y;
  }
  ({ x, y } = obj._constrain(x, y));
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  el.style.zIndex = String(Math.round(obj.z));
  el.style.setProperty('--o', obj.opacity);
  el.hidden = obj.visible === false;
  return obj.visible !== false;
}

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
    { key: 'flipX', label: 'flip', type: 'checkbox' },
  ];

  get fields() { return this.constructor.fields; }

  // Does this object rotate with its fastener? Art mounted on a head does. Geometry built
  // FROM landmarks does not — a face cutout's outline already reflects the head's roll,
  // so applying it again rotates the cutout twice.
  static followsPinAngle = false;

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
  // `maskedBy: ["spotL","spotR"]` shows this object only where those objects are opaque.
  // Scene 11's spotlights: white circles on the hands revealing a curtain over black.
  //
  // The mask is the masking objects' own PIXELS, not a shape — so any art works, a circle
  // SVG included, and alpha edges come through soft.
  draw(g, stage, t) {
    if (this.maskedBy?.length) return this._drawMasked(g, stage, t);
    this._paintSelf(g, stage, t);
  }

  _drawMasked(g, stage, t) {
    if (!this._maskCanvas) this._maskCanvas = document.createElement('canvas');
    const off = this._maskCanvas;
    const W = Math.round(stage.w * stage.dpr), H = Math.round(stage.h * stage.dpr);
    if (!W || !H) return;
    if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
    const og = off.getContext('2d');
    og.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);
    og.clearRect(0, 0, stage.w, stage.h);

    for (const id of this.maskedBy) {
      const m = this.deps.find?.(id);
      if (m && m.visible !== false) m._paintSelf(og, stage, t);
    }
    og.globalCompositeOperation = 'source-in';
    this._paintSelf(og, stage, t);
    og.globalCompositeOperation = 'source-over';

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(off, 0, 0);
    g.restore();
  }

  _paintSelf(g, stage, t) {
    if (this.opacity <= 0) return;

    // Pinned objects follow their fastener. If the hand isn't visible there is nothing
    // to pin to, so the object simply isn't on stage this frame.
    this.pin = null;
    let x = this.x, y = this.y;
    if (this.fasten) {
      this.pin = this._resolvePin(stage);
      if (!this.pin) return;
      x += this.pin.x;
      y += this.pin.y;
    }
    // Locks and clamps apply AFTER the fastener, so an object can follow one axis of a
    // hand while the other is pinned. The marquee is `lockX: 0.5, maxY: 0.5` — held to
    // centre horizontally, dragged down by the hand, and unable to pass halfway. A clamp,
    // not a latch: it follows the hand back up freely.
    ({ x, y } = this._constrain(x, y));

    // A fastener may carry an angle — the head's roll — so a hat tilts with the head.
    // The object's own rotation is applied on top of it.
    const rot = this.rotation + (this.constructor.followsPinAngle ? this.pin?.angle ?? 0 : 0);

    g.save();
    g.globalAlpha = this.opacity;
    g.translate(x * stage.w, y * stage.h);
    if (rot) g.rotate((rot * Math.PI) / 180);
    if (this.flipX) g.scale(-1, 1);
    if (this.scale !== 1) g.scale(this.scale, this.scale);
    try { this.render(g, stage, t); } finally { g.restore(); }
  }

  // `fasten: "hat"` pins to the live face. `fasten: "face.hat"` pins to the hat mount AS
  // CARRIED BY the object with id `face` — so a hat on a cut-out face moves, scales and
  // rotates with that cutout instead of with the raw webcam (§2.2).
  _resolvePin(stage) {
    const dot = this.fasten.indexOf('.');
    if (dot < 0) return this.deps.tracking?.fastener(this.fasten);

    const host = this.deps.find?.(this.fasten.slice(0, dot));
    const base = this.deps.tracking?.fastener(this.fasten.slice(dot + 1));
    if (!base || !host?.pin) return null;

    // Re-express the mount point in the host's transformed space: offset from the host's
    // own pin, scaled and rotated the way the host is, then placed at the host's origin.
    const rot = ((host.rotation ?? 0) * Math.PI) / 180;
    const dx = (base.x - host.pin.x) * stage.w * (host.scale ?? 1);
    const dy = (base.y - host.pin.y) * stage.h * (host.scale ?? 1);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return {
      x: host.pin.x + host.x + (dx * cos - dy * sin) / stage.w,
      y: host.pin.y + host.y + (dx * sin + dy * cos) / stage.h,
      size: base.size * (host.scale ?? 1),
      angle: (base.angle ?? 0) + (host.rotation ?? 0),
      anchor: base.anchor,
      fit: base.fit,
    };
  }

  // Flat rather than nested (`maxY: 0.5`, not `clampY: { max: 0.5 }`) — easier to read in
  // a scene file and it maps straight onto a panel field.
  _constrain(x, y) {
    if (this.lockX !== undefined && this.lockX !== null) x = this.lockX;
    if (this.lockY !== undefined && this.lockY !== null) y = this.lockY;
    if (this.minX != null) x = Math.max(this.minX, x);
    if (this.maxX != null) x = Math.min(this.maxX, x);
    if (this.minY != null) y = Math.max(this.minY, y);
    if (this.maxY != null) y = Math.min(this.maxY, y);
    return { x, y };
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
    if (this.flipX) out.flipX = true;
    if (this.maskedBy?.length) out.maskedBy = this.maskedBy;
    if (this.isMask) out.isMask = true;
    for (const k of ['lockX', 'lockY', 'minX', 'maxX', 'minY', 'maxY']) {
      if (this[k] != null) out[k] = round(this[k]);
    }
    if (this._note) out._note = this._note;
    return out;
  }
}

// ── Image ─────────────────────────────────────────────────────────────────
// Backgrounds, props, curtains, signs — and slides. A slide is not a feature in 3.0;
// it is an image at BACKGROUND with fit:'cover' (§7).

export class ImageObject extends StageObject {
  static followsPinAngle = true;   // a hat tilts with the head it sits on

  // Offer every mount on the live face, plus the same mounts carried by any cut-out
  // BodyPart on stage — `face.hat` puts a hat on the cutout rather than on the webcam.
  get fields() {
    const hosts = (this.deps.list?.() ?? []).filter((o) => o.type === 'bodyPart' && o.fasten === 'face');
    const nested = hosts.flatMap((h) => MOUNTS.map((m) => `${h.id}.${m}`));
    return ImageObject.fields.map((f) =>
      f.key === 'fasten' ? { ...f, options: [...f.options, ...nested] } : f);
  }

  static fields = [
    ...StageObject.fields,
    { key: 'src', label: 'src', type: 'text' },
    { key: 'size', label: 'size', type: 'range', min: 0.02, max: 2, step: 0.01 },
    { key: 'fit', label: 'fit', type: 'select', options: ['height', 'cover', 'contain'] },
    { key: 'fasten', label: 'fasten', type: 'select', options: ['', 'leftHand', 'rightHand', 'hat', 'glasses', 'nose', 'beard', 'mouthTop', 'mouthBottom', 'face', 'leftEye', 'rightEye', 'mouth'] },
    { key: 'anchor', label: 'anchor', type: 'select', options: ['', 'center', 'top', 'bottom'] },
  ];

  apply(spec) {
    super.apply(spec);
    this.size ??= this.fasten ? 1.1 : 0.5;
    this.fit ??= 'height';
    // A puppet can carry a LIST and be cycled live with a key (§7 — 2.5.0 stepped through
    // a numbered folder with `;`/`'`). Here the scene names the set explicitly, so what
    // you cycle through is what the script says rather than whatever is in a directory.
    //
    // An entry is either a bare src or a small object of overrides:
    //
    //   "srcs": [ 10, { "src": 11, "size": 1.6 }, { "src": 12, "size": 0.9, "y": -0.1 } ]
    //
    // because puppets are not interchangeable — a wide video and a tall drawing want
    // different scales on the same hand. Not a container object: nothing else in the
    // system nests, and per-entry overrides buy the same thing without it.
    this._load(spec);
    return this;
  }

  // Resolve `src` (or the current entry of `srcs`) to a media element. Separate from
  // apply() because apply means "become exactly this spec" and deletes anything the spec
  // omits — so cycling through apply({}) would wipe srcs, index and cycleKey.
  _load(spec = {}) {
    if (this.srcs?.length) {
      this.index = ((this.index ?? 0) % this.srcs.length + this.srcs.length) % this.srcs.length;
      const entry = this.srcs[this.index];
      if (entry && typeof entry === 'object') {
        // Remember the object's own values the first time an entry overrides them, so
        // stepping to a plain entry restores them rather than keeping the last puppet's.
        this._base ??= {};
        for (const k of Object.keys(entry)) {
          if (k !== 'src' && !(k in this._base)) this._base[k] = this[k];
        }
        for (const [k, v] of Object.entries(this._base)) this[k] = v;
        Object.assign(this, entry);
      } else {
        for (const [k, v] of Object.entries(this._base ?? {})) this[k] = v;
        this.src = entry;
      }
    }
    if (this.src !== this._loaded) {
      this.el = this.src != null ? this.deps.assets?.get(this.src) : null;
      this._loaded = this.src;
      // `001_beret_hat.png` mounts itself at the hat unless the scene says otherwise, so
      // dropping art in and naming it is enough (§7).
      if (!this.fasten && !('fasten' in spec)) {
        this.fasten = this.deps.assets?.mount(this.src) ?? undefined;
        // super.apply() has already defaulted x/y to 0.5 (unfastened), so they have to be
        // reset to a zero OFFSET here — unless the scene set them deliberately.
        if (this.fasten) {
          if (!('x' in spec)) this.x = 0;
          if (!('y' in spec)) this.y = 0;
        }
      }
    }
    if (this.el?.tagName === 'VIDEO') {
      this.el.muted = !this.audio;   // videos are muted unless a scene opts in
      this.el.play?.().catch(() => {});
    }
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
      if (this.pin?.fit === 'width') {
        // Head-worn art scales by WIDTH: a hat matches head width, a beard jaw width.
        w = base * this.size * stage.h;
        h = w * (nat.h / nat.w);
      } else {
        h = base * this.size * stage.h;
        w = h * (nat.w / nat.h);
      }
    }
    // The mount says which EDGE of the art meets the point: a hat rests its bottom on the
    // crown, a beard hangs its top off the chin. Without this, every asset needs its own
    // nudge offsets, which is what 2.5.0 ended up doing (§2.2).
    const anchor = this.anchor ?? this.pin?.anchor ?? 'center';
    const dy = anchor === 'bottom' ? -h : anchor === 'top' ? 0 : -h / 2;
    // No clip needed: the canvas is exactly the stage, so it clips its own bounds.
    g.drawImage(this.el, -w / 2, dy, w, h);
  }

  // Step to the next source. The video element is swapped by apply(), so a .webm puppet
  // starts from the top each time it comes round.
  cycle(by = 1) {
    if (!this.srcs?.length) return;
    this.index = (((this.index ?? 0) + by) % this.srcs.length + this.srcs.length) % this.srcs.length;
    this._load();
  }

  dispose() { if (this.el?.tagName === 'VIDEO') this.el.muted = true; }

  serialize() {
    const out = super.serialize();
    if (this.srcs?.length) { out.srcs = this.srcs; out.index = this.index ?? 0; }
    else if (this.src != null) out.src = this.src;
    if (this.cycleKey) out.cycleKey = this.cycleKey;
    if (this.fit !== 'height') out.fit = this.fit; else out.size = round(this.size);
    if (this.audio) out.audio = true;
    if (this.anchor) out.anchor = this.anchor;
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
    if (cam?.live) { stage.drawVideoInto(g, cam.source, w, h); return; }

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
  // Hands: the colour-segmentation pipeline.
  cut: { bound: 0.11, skeleton: 0.01, clean: 0.015, range: 1, grow: 0.08, smooth: 0.55, points: 45, join: 'miter' },
  // Face parts: the landmark contour. `bound`, `clean`, `skeleton` and `range` are inert
  // here — there is no segmentation to steer — so only these have any effect.
  //
  // `face` is the base for every face part; `eye` and `mouth` override it, because the
  // contours differ in kind. The eye ring traces the eye OPENING, so it needs a much
  // larger grow to reach the lid and socket, and far fewer points — an eye is a simple
  // shape and 13 vertices only make it look noisy.
  face: { grow: 0.02, points: 13, smooth: 0.55, crown: 0.22, join: 'miter' },
  eye: { grow: 0.8, points: 7, outline: { width: 0.14 } },
  mouth: { points: 10, outline: { width: 0.08 } },
  outline: { width: 0.045, color: '#ffffff' },
  shadow: { dx: 0, dy: 0.012, blur: 0.02, color: 'rgba(0,0,0,0.45)' },
  // NO live texturing. Per-frame grain was measured as the dominant cost — blend passes
  // clipped per cutout, seven cutouts deep — and removing it was the single biggest win
  // available. If paper grain comes back it should be a CSS overlay on the stage element,
  // which the compositor handles on the GPU outside this loop entirely.
};

export class BodyPart extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'fasten', label: 'part', type: 'select', options: ['leftHand', 'rightHand', 'face', 'leftEye', 'rightEye', 'mouth'] },
    { key: 'bound', label: 'bound', type: 'range', min: 0.05, max: 0.6, step: 0.01 },
    { key: 'skeleton', label: 'skeleton', type: 'range', min: 0.01, max: 0.3, step: 0.005 },
    { key: 'clean', label: 'clean', type: 'range', min: 0, max: 0.15, step: 0.005 },
    { key: 'range', label: 'range', type: 'range', min: 0.5, max: 4, step: 0.05 },
    { key: 'grow', label: 'grow', type: 'range', min: 0, max: 0.8, step: 0.005 },
    { key: 'outlineWidth', label: 'border', type: 'range', min: 0, max: 0.3, step: 0.005 },
    { key: 'crown', label: 'crown', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'smooth', label: 'smooth', type: 'range', min: 0, max: 0.95, step: 0.05 },
    { key: 'points', label: 'points', type: 'range', min: 8, max: 96, step: 1 },
    { key: 'debug', label: 'show mask', type: 'checkbox' },
  ];

  apply(spec) {
    super.apply(spec);
    const paper = this.deps.paper ?? {};
    // Hands and face parts are cut by different pipelines and want different numbers, so
    // they read different default groups. Within the face, eyes and mouth override the
    // face's own values. Resolution, most specific first:
    //   the object's own cut → paper.<eye|mouth> → paper.face → built-in equivalents
    const part = spec.fasten ?? this.fasten;
    const isFace = FACE_PARTS.includes(part);
    const family = part === 'leftEye' || part === 'rightEye' ? 'eye'
      : part === 'mouth' ? 'mouth' : null;
    const chain = isFace
      ? [spec.cut, family && paper[family], paper.face, family && PAPER[family], PAPER.face]
      : [spec.cut, paper.cut, PAPER.cut];
    const pick = (k) => {
      for (const src of chain) if (src && src[k] !== undefined) return src[k];
      return PAPER.cut[k];
    };
    this.bound ??= pick('bound');        // M2 radius — the leak guard
    this.skeleton ??= pick('skeleton');  // M1 stroke width; the colour sample region
    this.clean ??= pick('clean');        // morphological kernel: fill holes, drop speckle
    this.range ??= pick('range');        // widen/narrow the Q1..Q3 colour range
    this.grow ??= pick('grow');          // final dilation, from their published code
    this.smooth ??= pick('smooth');      // temporal EMA on the radii
    this.crown ??= pick('crown');        // lift the top of the face oval over the hair
    this.points ??= pick('points');      // vertices in the hull
    this.join ??= pick('join');
    for (const k of ['bound', 'skeleton', 'clean', 'range', 'grow', 'smooth', 'points', 'join', 'crown']) {
      if (spec.cut?.[k] !== undefined) this[k] = spec.cut[k];
    }
    // Border width is a fraction of the PART's size, and an eye is tiny — so it needs its
    // own value the same way grow does, resolved down the same chain.
    const pickOutline = (k) => {
      for (const src of chain) if (src?.outline?.[k] !== undefined) return src.outline[k];
      return spec.outline?.[k] ?? paper.outline?.[k] ?? PAPER.outline[k];
    };
    this.outlineWidth ??= spec.outline?.width ?? pickOutline('width');
    this.outlineColor ??= spec.outline?.color ?? pickOutline('color');
    this.shadow ??= { ...PAPER.shadow, ...(paper.shadow ?? {}), ...(spec.shadow ?? {}) };
    this.debug ??= false;
    this.showCut ??= true;   // false → a bare mount for pinned puppets (§2.2)
    return this;
  }

  // GEOMETRY happens here, one phase before anything paints — so the expensive work runs
  // once per frame regardless of draw order.
  //
  update(dt, now, stage) {
    this._poly = null;
    if (!this.showCut || this.visible === false) return;
    const cam = this.deps.camera;
    this.pin = this._resolvePin(stage);
    if (!cam?.live || !this.pin) return;

    const ox = this.pin.x * stage.w, oy = this.pin.y * stage.h;

    if (FACE_PARTS.includes(this.fasten)) {
      // A face needs none of the hand's colour segmentation: the landmark contour IS the
      // silhouette, and a face does not fold over itself the way a hand does.
      this._poly = this._contourPoly(stage, ox, oy);
      this._sil = null;
    } else {
      const raw = this.deps.tracking?.hands?.[this.fasten];
      const perf = this.deps.renderer?.perf;
      const t0 = perf && performance.now();
      const sil = raw && this.deps.silhouette?.compute(this.fasten, raw, {
        bound: this.bound, skeleton: this.skeleton, clean: this.clean,
        range: this.range, grow: this.grow, smooth: this.smooth, points: this.points,
        frozen: this.deps.tracking?.frozen,
      });
      if (perf) perf.silhouette += performance.now() - t0;
      if (!sil?.polygon) { this._sil = null; return; }
      // Video px → local stage px. The mirror is resolved here, at the video→stage
      // boundary, as everywhere else (§9.2).
      const { vw, vh } = sil.rect;
      this._toLocal = ([vx, vy]) => {
        const q = stage.videoNormToStage(vx / vw, vy / vh, cam.video);
        return [q.x * stage.w - ox, q.y * stage.h - oy];
      };
      this._poly = sil.polygon.map(this._toLocal);
      this._sil = sil;
    }
    if (!this._poly) return;

  }

  render(g, stage) {
    const cam = this.deps.camera;
    if (!this._poly || !cam?.live || !this.pin) return;
    const ox = this.pin.x * stage.w, oy = this.pin.y * stage.h;
    this._paint(g, stage, this._poly, ox, oy, cam);
    if (this.debug) {
      if (this._sil) this._debug(g, stage, this._sil, this._poly, this._toLocal);
      else this._debugPoly(g, stage, this._poly);
    }
  }

  // A face region's contour, grown and smoothed. Fixed landmark indices in ring order,
  // so the parameterisation is already stable — no anchoring needed the way the traced
  // hand contour needs it.
  _contourPoly(stage, ox, oy) {
    const pts = this.deps.tracking?.contour(this.fasten);
    if (!pts?.length) return null;
    let poly = pts.map((p) => [p.x * stage.w - ox, p.y * stage.h - oy]);

    // MediaPipe's face oval stops at the forehead and cuts straight across, so a cutout
    // loses the top of the head. `crown` lifts the upper contour to take in hair and
    // fringe. The lift is weighted by how high each vertex already sits — squared, so it
    // concentrates at the very top and tapers to nothing by the middle of the face rather
    // than shearing the whole outline upward.
    if (this.fasten === 'face' && this.crown) {
      const ys = poly.map((q) => q[1]);
      const top = Math.min(...ys), mid = (top + Math.max(...ys)) / 2;
      const lift = this.crown * this.pin.size * stage.h;
      const range = mid - top || 1;
      poly = poly.map(([x, y]) => {
        const t = Math.max(0, (mid - y) / range);
        return [x, y - lift * t * t];
      });
    }

    // Resample AFTER the lift, so the vertices are evenly spaced along the final shape.
    if (this.points && this.points >= 6) poly = resample(poly, Math.round(this.points));

    // `grow` offsets the outline along its own NORMAL — a true polygon offset. Pushing
    // radially from the centroid instead fails on a flat shape: almost every direction
    // from an eye's centre is horizontal, so the eye got wider without ever opening.
    // Offsetting along the normal moves the top edge up and the bottom edge down.
    const g = (this.grow ?? 0) * this.pin.size * stage.h;
    if (g) poly = offset(poly, g);

    const sm = this.smooth ?? 0;
    if (sm && this._prev?.length === poly.length) {
      for (let k = 0; k < poly.length; k++) {
        poly[k][0] = this._prev[k][0] * sm + poly[k][0] * (1 - sm);
        poly[k][1] = this._prev[k][1] * sm + poly[k][1] * (1 - sm);
      }
    }
    this._prev = poly.map((q) => q.slice());
    return poly;
  }

  // The paper pass, shared by hands and face: the polygon stroked wider in white with the
  // drop shadow, then the live video clipped to it. Same operation at two radii (§2.3).
  _paint(g, stage, poly, ox, oy, cam) {
    const path = new Path2D();
    path.moveTo(...poly[0]);
    for (let i = 1; i < poly.length; i++) path.lineTo(...poly[i]);
    path.closePath();

    const border = this.outlineWidth * this.pin.size * stage.h;

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

    // A single closed path, so clip() works directly — no offscreen compositing.
    g.save();
    g.clip(path);

    // The video is drawn in STAGE space, so it needs its own transform — and its own
    // save/restore. Anything after it must be back in local space or it lands half a
    // stage away.
    g.save();
    g.translate(-ox, -oy);
    g.translate(stage.w / 2, stage.h / 2);
    stage.drawVideoInto(g, cam.source, stage.w, stage.h);
    g.restore();
    g.restore();
  }

  // The mask, the hull and its vertices, in three colours — so it is obvious which stage
  // is misbehaving when the shape looks wrong.
  _debug(g, stage, sil, poly, toLocal) {
    const { x0, y0, x1, y1 } = sil.rect;
    const a = toLocal([x0, y0]), b = toLocal([x1, y1]);
    const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);

    g.save();
    g.globalAlpha = 0.35;                      // the segmentation mask, in white
    g.translate(left + w / 2, top + h / 2);
    if (stage.mirror) g.scale(-1, 1);
    g.drawImage(sil.canvas, -w / 2, -h / 2, w, h);
    g.restore();

    this._debugPoly(g, stage, poly);
  }

  // The hull and its vertices. The face path has no mask, so this is all it can show.
  _debugPoly(g, stage, poly) {
    g.save();
    g.strokeStyle = '#00e5ff';
    g.lineWidth = Math.max(1, stage.h * 0.003);
    g.beginPath();
    g.moveTo(...poly[0]);
    for (let i = 1; i < poly.length; i++) g.lineTo(...poly[i]);
    g.closePath();
    g.stroke();

    g.fillStyle = '#ff2d55';
    const r = Math.max(2, stage.h * 0.004);
    for (const [x, y] of poly) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }

    g.fillStyle = '#ffd60a';                   // vertex 0 — the anchor the smoothing uses
    g.beginPath(); g.arc(poly[0][0], poly[0][1], r * 1.8, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  serialize() {
    const out = super.serialize();
    out.cut = {
      bound: round(this.bound), skeleton: round(this.skeleton), clean: round(this.clean),
      range: round(this.range), grow: round(this.grow), smooth: round(this.smooth),
      crown: round(this.crown),
      points: this.points, join: this.join,
    };
    out.outline = { width: round(this.outlineWidth), color: this.outlineColor };
    if (!this.showCut) out.showCut = false;
    if (this.debug) out.debug = true;
    return out;
  }
}

// Offset a closed polygon outward by `d` along its own normals. The winding is measured
// rather than assumed, so the offset always grows the shape instead of shrinking it.
function offset(poly, d) {
  const n = poly.length;
  if (n < 3) return poly;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  const sign = a >= 0 ? 1 : -1;
  return poly.map(([x, y], i) => {
    const p = poly[(i - 1 + n) % n], q = poly[(i + 1) % n];
    const tx = q[0] - p[0], ty = q[1] - p[1];
    const len = Math.hypot(tx, ty) || 1;
    return [x + (ty / len) * d * sign, y - (tx / len) * d * sign];
  });
}

// ── Button ────────────────────────────────────────────────────────────────
// A real xp.css button on the stage. Scene 11 wants one clicked live: it reads as a UI
// moment to the audience, and the mic grant genuinely has to be user-initiated.

export class ButtonObject extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'text', label: 'label', type: 'text' },
    { key: 'action', label: 'action', type: 'select', options: ['', 'enableMic'] },
  ];

  apply(spec) {
    super.apply(spec);
    this.text ??= 'click me';
    this.z ??= 250;
    return this;
  }

  update(dt, now, stage) {
    if (!this._el) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'stage-button';
      el.addEventListener('click', () => this._fire());
      this.deps.domLayer.appendChild(el);
      this._el = el;
    }
    // Its job done, it takes itself off stage — the script replaces it with the bar.
    if (this.action === 'enableMic' && this.deps.mic?.ready) { this._el.hidden = true; return; }
    if (this._el.textContent !== this.text) this._el.textContent = this.text;
    placeDom(this._el, this, stage);
  }

  _fire() {
    if (this.action === 'enableMic') this.deps.mic?.enable();
  }

  dispose() { this._el?.remove(); this._el = null; }

  serialize() {
    const out = super.serialize();
    out.text = this.text;
    if (this.action) out.action = this.action;
    return out;
  }
}

// ── Progress ──────────────────────────────────────────────────────────────
// An xp.css progress bar that fills only while the room is loud. Scene 11's drumroll: it
// takes AT LEAST `seconds` of sustained noise, and stalls the moment the room goes quiet.

export class ProgressObject extends StageObject {
  static fields = [
    ...StageObject.fields,
    { key: 'seconds', label: 'min secs', type: 'range', min: 2, max: 30, step: 1 },
    { key: 'threshold', label: 'loud at', type: 'range', min: 0.02, max: 0.8, step: 0.02 },
    { key: 'width', label: 'width', type: 'range', min: 0.1, max: 1, step: 0.01 },
  ];

  apply(spec) {
    super.apply(spec);
    this.seconds ??= 10;
    this.threshold ??= 0.12;
    this.width ??= 0.5;
    this.value ??= 0;
    this.z ??= 250;
    this.needsMic ??= true;   // hidden until the mic is granted
    return this;
  }

  update(dt, now, stage) {
    if (!this._el) {
      const el = document.createElement('progress');
      el.max = 100;
      el.className = 'stage-progress';
      this.deps.domLayer.appendChild(el);
      this._el = el;
    }
    const mic = this.deps.mic;
    if (this.needsMic && !mic?.ready) { this._el.hidden = true; return; }

    // Judged on the ~1s average, not the instant level — one clap should not advance it,
    // and the script asks for sustained noise.
    if (mic && mic.avg > this.threshold) {
      this.value = Math.min(100, this.value + (dt / (this.seconds * 1000)) * 100);
    }
    this._el.value = this.value;
    this._el.style.width = `${this.width * 100}%`;
    placeDom(this._el, this, stage);
  }

  dispose() { this._el?.remove(); this._el = null; }

  serialize() {
    const out = super.serialize();
    out.seconds = this.seconds;
    out.threshold = round(this.threshold);
    out.width = round(this.width);
    return out;
  }
}

// ── FaceLabel ─────────────────────────────────────────────────────────────
// The bounding box and caption over a detected face. Three beats in the script differ
// only in colour and text — `#b4dd1e` with a name, then white with a live description,
// then "bored mf" — so it is one object, not three.
//
// `text` is a template: {emotion} {age} {gender} are filled from face-api, and anything
// without a placeholder is a literal. Race is not inferred; the script writes the word.

export class FaceLabelObject extends StageObject {
  static fields = [
    { key: 'z', label: 'z', type: 'number', min: -400, max: 400, step: 1 },
    { key: 'opacity', label: 'opacity', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'text', label: 'text', type: 'text' },
    { key: 'color', label: 'box', type: 'text' },
    { key: 'textColor', label: 'text col', type: 'text' },
    { key: 'pad', label: 'pad', type: 'range', min: 0, max: 0.3, step: 0.01 },
  ];

  apply(spec) {
    super.apply(spec);
    this.text ??= '{emotion} {age} year-old Asian {gender}';
    this.color ??= '#b4dd1e';
    this.textColor ??= '#000000';
    this.pad ??= 0.06;
    this.z ??= 60;
    return this;
  }

  // Drawn in STAGE space, not at an object position — the box IS wherever the face is.
  draw(g, stage) {
    const face = this.deps.faces;
    const r = face?.result;
    if (!r || this.visible === false || this.opacity <= 0) return;

    const pad = this.pad * r.box.h;
    const x = (r.box.x - pad / stage.aspect) * stage.w;
    const y = (r.box.y - pad) * stage.h;
    const w = (r.box.w + (2 * pad) / stage.aspect) * stage.w;
    const h = (r.box.h + 2 * pad) * stage.h;

    g.save();
    g.globalAlpha = this.opacity;
    g.lineWidth = Math.max(2, stage.h * 0.004);
    g.strokeStyle = this.color;
    g.strokeRect(x, y, w, h);

    const label = face.fill(this.text);
    if (label) {
      const size = Math.max(11, stage.h * 0.032);
      g.font = `${size}px system-ui, sans-serif`;
      const tw = g.measureText(label).width;
      const th = size * 1.5;
      // Caption sits under the box, flipping above it if that would leave the stage.
      const ly = y + h + th > stage.h ? y - th : y + h;
      g.fillStyle = this.color;
      g.fillRect(x, ly, tw + size * 0.8, th);
      g.fillStyle = this.textColor;
      g.textBaseline = 'middle';
      g.fillText(label, x + size * 0.4, ly + th / 2);
    }
    g.restore();
  }

  serialize() {
    const out = super.serialize();
    out.text = this.text;
    out.color = this.color;
    out.textColor = this.textColor;
    out.pad = round(this.pad);
    return out;
  }
}

export const TYPES = { image: ImageObject, webcam: WebcamFeed, text: TextBox, bodyPart: BodyPart, button: ButtonObject, progress: ProgressObject, faceLabel: FaceLabelObject };
