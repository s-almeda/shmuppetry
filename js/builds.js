// ── Builds ────────────────────────────────────────────────────────────────
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
  const fn = EFFECTS[b.effect] ?? EFFECTS.fade;
  obj.fx = { ...NEUTRAL_FX, ...fn(k, b) };
}

// Group a resolved stage's builds into ordered steps: [{ step, items: [{ id, kind, build }] }].
export function stepsOf(objects) {
  const groups = new Map();
  for (const [id, spec] of Object.entries(objects ?? {})) {
    if (!spec) continue;
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
  constructor({ pool, tweens }) {
    this.pool = pool;
    this.tweens = tweens;
    this.steps = [];
    this.at = 0;        // how many steps have played
  }

  get pending() { return this.at < this.steps.length; }
  get total() { return this.steps.length; }

  // Put every object in its pre- or post-build state. `done` shows the scene with all
  // builds played, which is what stepping BACK into a scene should land on.
  prepare(objects, { done = false } = {}) {
    this.steps = stepsOf(objects);
    this.at = done ? this.steps.length : 0;
    for (const obj of this.pool.objects) {
      // Not cancelling tweens here: a Magic Move that just started on this object must
      // survive. Its own frames overwrite whatever fx is set below.
      obj.fx = { ...NEUTRAL_FX };
      const hasIn = !!obj.in, hasOut = !!obj.out;
      obj._hidden = done ? hasOut : hasIn;
      // A video that waits for its step stays parked on its first frame until then.
      if (obj.type === 'video') obj.setPlaying?.(done ? !hasOut : !hasIn && obj.play !== 'onStep');
    }
    if (!done && this.steps[0]?.step === 0) this.next();
  }

  // Jump to the end state of every step without animating — what the editor shows.
  revealAll() {
    this.tweens.finishAll();
    this.at = this.steps.length;
    for (const obj of this.pool.objects) { obj._hidden = false; obj.fx = { ...NEUTRAL_FX }; }
  }

  next() {
    if (!this.pending) return false;
    const group = this.steps[this.at++];
    for (const item of group.items) this._play(item, +1);
    return true;
  }

  back() {
    if (this.at <= 0) return false;
    const group = this.steps[--this.at];
    for (const item of group.items) this._play(item, -1);
    return true;
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
