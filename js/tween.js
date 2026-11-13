// ── Tweens ────────────────────────────────────────────────────────────────
// One small interpolator shared by Magic Move, builds and stage transitions. A tween
// writes numeric keys on a target between `from` and `to` on the frame clock; nothing
// here knows what an object is. Objects are tweened IN PLACE — the final frame leaves
// exactly the spec values on the object, so serialize() after the cut is the scene.

export const EASE = {
  linear: (t) => t,
  // Keynote's default curve is a gentle ease-in-out. This cubic reads the same.
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  // Overshoots to ~1.1 then settles — the "pop" in a pulse build.
  back: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

export class Tweens {
  constructor() { this.active = []; }

  get busy() { return this.active.length > 0; }

  // { target, from: {k: v}, to: {k: v}, dur (s), ease, onUpdate(k), onDone }
  // `from` defaults to the target's current values, so a tween can be started with only
  // the destination and whatever is on the object right now is where it begins.
  add(t) {
    const now = performance.now();
    const keys = Object.keys(t.to ?? {});
    const from = {};
    for (const k of keys) from[k] = t.from?.[k] ?? t.target?.[k] ?? 0;
    // A second tween on the same target+key replaces the first: a build interrupted by
    // the next keypress should jump to where the new one says, not fight it.
    if (t.target && keys.length) {
      this.active = this.active.filter((o) =>
        !(o.target === t.target && o.keys.some((k) => keys.includes(k))));
    }
    // `delay` (s) holds the tween before it starts; `onStart` fires on its first frame, so
    // a delayed entrance can stay hidden until its moment.
    const delay = Math.max(0, (t.delay ?? 0) * 1000);
    const tw = { ...t, from, keys, t0: now + delay, dur: Math.max(0, (t.dur ?? 0.5) * 1000), ease: EASE[t.ease] ?? t.ease ?? EASE.inOut };
    this.active.push(tw);
    if (tw.dur === 0 && !delay) this._apply(tw, 1);
    return tw;
  }

  // Finish everything now — used when a scene cut arrives mid-tween, so the previous
  // scene's final state is exactly what the next one inherits from.
  finishAll() {
    const all = this.active;
    this.active = [];
    for (const tw of all) this._apply(tw, 1);
  }

  cancel(target) { this.active = this.active.filter((tw) => tw.target !== target); }

  update(now) {
    if (!this.active.length) return;
    const done = [];
    for (const tw of this.active) {
      if (now < tw.t0) continue;                      // still waiting out its delay
      const k = tw.dur ? Math.min(1, (now - tw.t0) / tw.dur) : 1;
      this._apply(tw, k);
      if (k >= 1) done.push(tw);
    }
    if (done.length) this.active = this.active.filter((tw) => !done.includes(tw));
  }

  _apply(tw, k) {
    if (!tw.started) { tw.started = true; tw.onStart?.(); }
    const e = k >= 1 ? 1 : tw.ease(k);
    if (tw.target) for (const key of tw.keys) tw.target[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * e;
    tw.onUpdate?.(e, k);
    if (k >= 1) tw.onDone?.();
  }
}

// The transform channels Magic Move interpolates. `z` is not one — depth is a sort key,
// and an object sliding through the stack mid-tween would flicker in and out of others.
export const TWEEN_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity', 'size', 'width', 'strokeWidth', 'boxWidth'];

// Which of these differ between two specs, as a `to` map. Null when nothing moved.
export function transformDelta(from, to) {
  let out = null;
  for (const k of TWEEN_KEYS) {
    const a = from?.[k], b = to?.[k];
    if (typeof a !== 'number' || typeof b !== 'number' || Math.abs(a - b) < 1e-6) continue;
    (out ??= {})[k] = b;
  }
  return out;
}
