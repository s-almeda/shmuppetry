// ── Builds ────────────────────────────────────────────────────────────────
// (Actions — builds that change an object already on stage — are further down.)
// Per-object entrances and exits, in the Keynote sense: an object with
//
//   "in":  { "effect": "wipe", "dir": "right", "dur": 0.6, "step": 2 }
//   "out": { "effect": "fade", "step": 4 }
//
// is hidden when its scene appears, plays in on build step 2, and plays out on step 4.
// Space / → play the next pending step before moving to the next scene; ← reverses one.
// Objects sharing a `step` play together. Steps are whatever integers the file uses,
// sorted — 1, 2, 5 is fine, and the importer writes Keynote's build order straight in.
//
// An effect is a pure function of progress k ∈ 0..1 (0 = absent, 1 = fully there) that
// writes the object's TRANSIENT `fx` channels: alpha, dx/dy (stage fractions), scale, a
// clip polygon, and `draw` (line draw progress). Nothing authored is touched, so the
// panel's save button never bakes half a build into the scene file. Exits run the same
// function backwards. Stage transitions (js/transition.js) reuse the same table.

import { TWEEN_KEYS } from './tween.js';

// `dir` is the direction of TRAVEL: a wipe "up" reveals from the bottom edge toward the
// top, a move "up" enters from below. Diagonals are the four compass corners.
export const DIRS = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upLeft: [-1, -1], upRight: [1, -1], downLeft: [-1, 1], downRight: [1, 1],
};
const unit = (dir) => {
  const [x, y] = DIRS[dir] ?? DIRS.right;
  const n = Math.hypot(x, y) || 1;
  return [x / n, y / n];
};

export const NEUTRAL_FX = Object.freeze({ alpha: 1, dx: 0, dy: 0, scale: 1, clip: null, draw: 1 });

// The part of the unit square (0..1 × 0..1) revealed by a wipe that has travelled
// fraction k in direction `dir`: the square cut by one half-plane. A polygon rather than
// a rect so diagonals work, and the same polygon serves canvas (scaled to the object's
// box) and DOM (as a clip-path in %). Sutherland–Hodgman against one edge.
export function wipePolygon(dir, k) {
  if (k >= 1) return null;                        // nothing clipped
  if (k <= 0) return [];                          // everything clipped
  const [vx, vy] = unit(dir);
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Project the square's corners onto v; the wipe front sits at min + k·(max − min).
  const proj = square.map(([x, y]) => x * vx + y * vy);
  const lo = Math.min(...proj), hi = Math.max(...proj);
  const front = lo + k * (hi - lo);
  const inside = ([x, y]) => x * vx + y * vy <= front + 1e-9;
  const out = [];
  for (let i = 0; i < square.length; i++) {
    const a = square[i], b = square[(i + 1) % square.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const pa = a[0] * vx + a[1] * vy, pb = b[0] * vx + b[1] * vy;
      const t = (front - pa) / (pb - pa);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// k is "how present": 0 absent, 1 fully on stage. `b` is the build spec (dir, etc.).
export const EFFECTS = {
  fade:     (k) => ({ alpha: k }),
  dissolve: (k) => ({ alpha: k }),
  // Enters from off-stage opposite to its travel direction and lands on its spot.
  move:     (k, b) => { const [vx, vy] = unit(b.dir ?? 'right'); return { dx: -(1 - k) * vx * 1.1, dy: -(1 - k) * vy * 1.1 }; },
  // Keynote's default build: a short slide with a fade. 6% of the stage reads right.
  fadeMove: (k, b) => { const [vx, vy] = unit(b.dir ?? 'up'); return { alpha: k, dx: -(1 - k) * vx * 0.06, dy: -(1 - k) * vy * 0.06 }; },
  wipe:     (k, b) => ({ clip: wipePolygon(b.dir ?? 'right', k) }),
  // Pop: overshoot past full size and settle, fading in over the first third.
  pulse:    (k) => { const c = 1.70158, t = k - 1; return { scale: Math.max(0, 1 + (c + 1) * t * t * t + c * t * t), alpha: Math.min(1, k * 3) }; },
  pop:      (k) => EFFECTS.pulse(k),
  scale:    (k) => ({ scale: k, alpha: Math.min(1, k * 2) }),
  // Typewriter: the TextBox owns the timing, so the fx channel is just "visible".
  keyboard: () => ({}),
  lineDraw: (k) => ({ draw: k }),
};

// A build's own duration, in seconds. The keyboard effect lasts as long as the typing
// does, which the object decides — so its tween is instant and only flips visibility.
export function buildDuration(b) {
  if (b.effect === 'keyboard') return 0;
  return b.dur ?? 0.5;
}

export function applyEffect(obj, b, k) {
  // A wipe clips the object's box. Types that cannot say what their box is — a body
  // cutout, a label box, a button — fade instead of popping in at the end.
  const boxless = b.effect === 'wipe' && typeof obj.bounds !== 'function' && obj.type !== 'text';
  const fn = (!boxless && EFFECTS[b.effect]) || EFFECTS.fade;
  obj.fx = { ...NEUTRAL_FX, ...fn(k, b) };
}

// ── Actions ───────────────────────────────────────────────────────────────
// A build that CHANGES something already on stage, rather than bringing it on or off:
//
//   "actions": [
//     { "step": 2, "set": { "src": 331, "x": 0.3 }, "dur": 0.4 },     ← change properties
//     { "step": 3, "effect": "pulse", "amount": 1.1 }                 ← emphasis, no change
//   ]
//
// on an object; and on the SCENE itself, for the flags a scene carries:
//
//   "actions": [ { "step": 1, "set": { "freeze": true } } ]
//
// `set` numbers that can tween (position, size, scale, rotation, opacity) glide over
// `dur`; everything else — a picture, a colour, `playing` on a sound — switches at the
// start (a changed picture crossfades). Unlike an entrance, an action really does change
// the object, so the NEXT scene inherits the result (scene.js resolveScript), and ←
// puts the old values back.
const sin = Math.sin, PI = Math.PI;
const beat = (k, a) => (k >= 1 ? 0 : (k * (a.repeat ?? 1)) % 1);
export const EMPHASIS = {
  pulse:  (k, a) => ({ scale: 1 + ((a.amount ?? 1.1) - 1) * sin(PI * beat(k, a)) }),
  jiggle: (k, a) => ({ dx: (a.amount ?? 0.01) * sin(2 * PI * 3 * k * (a.repeat ?? 1)) * (1 - k) }),
  blink:  (k, a) => ({ alpha: 1 - (1 - (a.amount ?? 0.2)) * sin(PI * beat(k, a)) }),
};

// Group a resolved stage's builds into ordered steps: [{ step, items: [{ id, kind, build }] }].
// `kind` is 'in' / 'out' (an entrance or exit), 'action' (an object's action) or 'scene'
// (a scene-level action, id null).
export function stepsOf(objects, sceneActions) {
  const groups = new Map();
  const put = (step, item) => { if (!groups.has(step)) groups.set(step, []); groups.get(step).push(item); };
  const stepOf = (a) => (Number.isFinite(a.step) ? Math.max(0, a.step) : 1);
  for (const a of sceneActions ?? []) if (a && typeof a === 'object') put(stepOf(a), { id: null, kind: 'scene', build: a });
  for (const [id, spec] of Object.entries(objects ?? {})) {
    if (!spec) continue;
    for (const a of spec.actions ?? []) if (a && typeof a === 'object') put(stepOf(a), { id, kind: 'action', build: a });
    for (const kind of ['in', 'out']) {
      const b = spec[kind];
      if (!b || typeof b !== 'object') continue;
      // Step 0 plays as the scene arrives, with no click — Keynote's "after transition".
      const step = Number.isFinite(b.step) ? Math.max(0, b.step) : (kind === 'in' ? 1 : 2);
      if (!groups.has(step)) groups.set(step, []);
      groups.get(step).push({ id, kind, build: b });
    }
  }
  return [...groups.keys()].sort((a, b) => a - b).map((step) => ({ step, items: groups.get(step) }));
}

// ── Controller ────────────────────────────────────────────────────────────
// Owned by the Player. `prepare` runs after the pool is synced to a scene; `next`/`back`
// are what Space and ← consult before stepping scenes.
export class Builds {
  constructor({ pool, tweens, onScene }) {
    this.pool = pool;
    this.tweens = tweens;
    this.onScene = onScene;   // (set) => previous values — applies a scene-level action
    this.steps = [];
    this.at = 0;        // how many steps have played
    this.applied = [];  // actions in force, oldest first: [{ item, prev }]
  }

  get pending() { return this.at < this.steps.length; }
  get total() { return this.steps.length; }

  // Put every object in its pre- or post-build state. `done` shows the scene with all
  // builds played, which is what stepping BACK into a scene should land on.
  prepare(objects, { done = false, sceneActions } = {}) {
    this.steps = stepsOf(objects, sceneActions);
    this.at = done ? this.steps.length : 0;
    // The pool has just been synced to the scene as written, so no action is in force.
    this.applied = [];
    for (const obj of this.pool.objects) {
      // Not cancelling tweens here: a Magic Move that just started on this object must
      // survive. Its own frames overwrite whatever fx is set below.
      obj.fx = { ...NEUTRAL_FX };
      const hasIn = !!obj.in, hasOut = !!obj.out;
      obj._hidden = done ? hasOut : hasIn;
      // A video that waits for its step stays parked on its first frame until then.
      if (obj.type === 'video') obj.setPlaying?.(done ? !hasOut : !hasIn && obj.play !== 'onStep');
    }
    if (done) for (const g of this.steps) for (const item of g.items) if (item.kind !== 'in' && item.kind !== 'out') this._act(item, true);
    if (!done && this.steps[0]?.step === 0) this.next();
  }

  // Every object visible and every action UNDONE — the scene as it is written, which is
  // what you edit. (Editing the after-state of an action would save it as the before.)
  revealAll() {
    this.tweens.finishAll();
    this.rewindActions();
    this.at = this.steps.length;
    for (const obj of this.pool.objects) { obj._hidden = false; obj.fx = { ...NEUTRAL_FX }; }
  }

  next() {
    if (!this.pending) return false;
    const group = this.steps[this.at++];
    for (const item of group.items) (item.kind === 'in' || item.kind === 'out') ? this._play(item, +1) : this._act(item);
    return true;
  }

  back() {
    if (this.at <= 0) return false;
    const group = this.steps[--this.at];
    for (const item of [...group.items].reverse()) (item.kind === 'in' || item.kind === 'out') ? this._play(item, -1) : this._unact(item);
    return true;
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  _act(item, instant = false) {
    const a = item.build;
    if (item.kind === 'scene') {
      if (a.set) this.applied.push({ item, prev: this.onScene?.(a.set) ?? {} });
      return;
    }
    const obj = this.pool.live.get(item.id);
    if (!obj) return;
    const dur = instant ? 0 : a.dur ?? 0.5, delay = instant ? 0 : a.delay ?? 0;
    if (a.effect && !instant) {
      const fn = EMPHASIS[a.effect] ?? EMPHASIS.pulse;
      const prog = { k: 0 };
      this.tweens.add({
        target: prog, to: { k: 1 }, dur, delay, ease: 'linear',
        onUpdate: () => { obj.fx = { ...NEUTRAL_FX, ...fn(prog.k, a) }; },
        onDone: () => { obj.fx = { ...NEUTRAL_FX }; },
      });
    }
    if (!a.set) return;
    const prev = {};
    for (const k of Object.keys(a.set)) prev[k] = obj[k];
    this.applied.push({ item, prev });
    this._set(obj, a.set, dur, delay);
  }

  _unact(item, instant = false) {
    const i = this.applied.findLastIndex((e) => e.item === item);
    if (i < 0) return;
    const [{ prev }] = this.applied.splice(i, 1);
    if (item.kind === 'scene') { this.onScene?.(prev); return; }
    const obj = this.pool.live.get(item.id);
    if (obj) this._set(obj, prev, instant ? 0 : item.build.dur ?? 0.5, 0);
  }

  // Numbers that can tween glide; the rest goes through the object's own apply(), the
  // same door a scene change uses, so a new picture loads and a new colour repaints.
  _set(obj, set, dur, delay) {
    const glide = {}, rest = {};
    for (const [k, v] of Object.entries(set)) {
      (TWEEN_KEYS.includes(k) && typeof v === 'number' && typeof obj[k] === 'number' ? glide : rest)[k] = v;
    }
    const swap = () => {
      if (!Object.keys(rest).length) return;
      const was = obj.src;
      obj.apply({ ...obj.serialize(), ...rest });
      if ('src' in rest && was != null && rest.src != null && was !== rest.src && dur > 0) obj.crossfadeFrom?.(was, dur);
      if (obj.type === 'video' && 'playing' in rest) obj.setPlaying?.(!!rest.playing);
    };
    if (!delay) swap();
    if (Object.keys(glide).length || delay) {
      this.tweens.add({ target: obj, to: glide, dur, delay, ease: 'inOut', onStart: delay ? swap : undefined });
    }
  }

  // Undo every action in force, newest first, without animating.
  rewindActions() {
    this.tweens.finishAll();
    for (const e of [...this.applied].reverse()) this._unact(e.item, true);
    this.applied = [];
  }

  // For saving: put the scene back as written, and hand back a function that restores
  // what the audience was looking at.
  suspendActions() {
    // Object actions only. Scene flags are not in what gets saved, and un-freezing just
    // to re-freeze would grab a new frozen frame in front of the audience.
    this.tweens.finishAll();
    const items = this.applied.filter((e) => e.item.kind === 'action').map((e) => e.item);
    for (const item of [...items].reverse()) this._unact(item, true);
    return () => { for (const item of items) this._act(item, true); };
  }

  // dirn +1 plays the step forward, −1 undoes it. An `in` undone is an exit and vice
  // versa, so both are one tween of k with the sign folded into from/to.
  _play({ id, kind, build }, dirn) {
    const obj = this.pool.live.get(id);
    if (!obj) return;
    const entering = (kind === 'in') === (dirn > 0);
    const [from, to] = entering ? [0, 1] : [1, 0];
    const dur = buildDuration(build);
    // `delay` sequences builds within one click ("after previous"). Undoing never waits.
    const delay = dirn > 0 ? build.delay ?? 0 : 0;
    const start = () => {
      obj._hidden = false;
      // Put it in its starting pose NOW. The tween's first frame comes later, and until
      // then the object would sit on stage fully built — a flash of the finished slide
      // before the entrance plays.
      applyEffect(obj, build, from);
      if (entering) {
        if (build.effect === 'keyboard') obj.retype?.();
        if (obj.type === 'video') obj.setPlaying?.(true);
      }
    };
    if (!delay) start();
    const prog = { k: from };
    this.tweens.add({
      target: prog, to: { k: to }, dur, delay, ease: 'inOut',
      onStart: delay ? start : undefined,
      onUpdate: () => applyEffect(obj, build, prog.k),
      onDone: () => {
        obj.fx = { ...NEUTRAL_FX };
        if (!entering) { obj._hidden = true; if (obj.type === 'video') obj.setPlaying?.(false); }
      },
    });
  }
}
