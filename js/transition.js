// ── Scene transitions ─────────────────────────────────────────────────────
// Whole-stage effects at a scene cut, from a scene's
//
//   "transition": { "effect": "wipe", "dir": "up", "dur": 0.7 }
//
// Two kinds, and they compose differently with the object pool:
//
//   magicMove — nothing is snapshotted. Objects that KEEP THEIR ID across the cut are
//     tweened from where they were to where they now are (x, y, size, rotation…) and an
//     image whose src changed crossfades. New ids fade in; ids that left are kept alive
//     for the length of the tween, faded out, then disposed. This is why the scene model
//     needs no notion of "linked" objects: the link IS the id (README, "how a scene works").
//
//   fade / dissolve / wipe / move / push — the last frame of the outgoing canvas is
//     copied to an offscreen buffer before the pool is synced, and the renderer paints
//     the new stage against it: under a fading snapshot, through a clip that travels in
//     `dir`, or sliding in from the edge. The DOM layer (text, and every object on a
//     slide) gets the matching CSS, and a clone of the outgoing DOM layer plays the other
//     half — see _ghostDom.
//
// No `transition` on a scene means a hard cut, exactly as before. Puppet scenes never
// start tweening by accident.

import { transformDelta } from './tween.js';
import { EFFECTS, NEUTRAL_FX, DIRS, wipePolygon } from './builds.js';

const SNAPSHOT_EFFECTS = new Set(['fade', 'dissolve', 'wipe', 'move', 'push']);
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left', upLeft: 'downRight', downRight: 'upLeft', upRight: 'downLeft', downLeft: 'upRight' };
const DEFAULT_DUR = { magicMove: 0.7, fade: 0.5, dissolve: 0.5, wipe: 0.6, move: 0.6, push: 0.6 };

export function normalizeTransition(t) {
  if (!t) return null;
  if (typeof t === 'string') t = { effect: t };
  const effect = String(t.effect ?? 'magicMove').replace(/\s+/g, '');
  const name = effect === 'magic-move' || effect.toLowerCase() === 'magicmove' ? 'magicMove' : effect;
  if (name !== 'magicMove' && !SNAPSHOT_EFFECTS.has(name)) return null;
  return { effect: name, dir: t.dir ?? 'right', dur: t.dur ?? DEFAULT_DUR[name] ?? 0.6 };
}

export class Transitions {
  constructor({ pool, tweens, renderer, stage, domLayer }) {
    this.pool = pool;
    this.tweens = tweens;
    this.renderer = renderer;
    this.stage = stage;
    this.domLayer = domLayer;
    this._snap = null;
  }

  // Called by the player BEFORE the pool is synced to the new scene. Returns a handle the
  // player passes back to `after()` once the pool has been synced.
  before(t) {
    if (!t) return null;
    if (t.effect === 'magicMove') {
      // Where everything is right now, by id — the `from` of every tween.
      const was = new Map();
      for (const obj of this.pool.objects) was.set(obj.id, obj.serialize());
      return { t, was };
    }
    this._snapshot();
    this._ghostDom(t);
    return { t };
  }

  // The outgoing slide's PAGE ELEMENTS — text, and on a slide every image and shape —
  // are not in a canvas snapshot. So the DOM layer is cloned as it stands, and the clone
  // plays the outgoing half of the transition while the real layer brings in the new
  // scene. Videos are replaced by a still of their current frame: a cloned <video>
  // restarts from black.
  _ghostDom(t) {
    this._ghost?.remove();
    const src = this.domLayer;
    if (!src?.parentNode || !src.children.length) { this._ghost = null; return; }
    const ghost = src.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.className = 'dom-ghost';
    const live = src.querySelectorAll('video'), copies = ghost.querySelectorAll('video');
    copies.forEach((v, i) => {
      const from = live[i];
      const c = document.createElement('canvas');
      c.width = from?.videoWidth || 2; c.height = from?.videoHeight || 2;
      try { if (from?.readyState >= 2) c.getContext('2d').drawImage(from, 0, 0); } catch { /* tainted */ }
      c.className = v.className; c.style.cssText = v.style.cssText;
      v.replaceWith(c);
    });
    // Fade puts the outgoing slide OVER the incoming one and fades it away; every other
    // effect reveals the incoming slide over it.
    const over = t.effect === 'fade' || t.effect === 'dissolve';
    Object.assign(ghost.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: over ? '6' : '4', opacity: '', clipPath: '', transform: '' });
    src.parentNode.insertBefore(ghost, src.nextSibling);
    this._ghost = ghost;
  }

  after(handle, resolved) {
    if (!handle) return;
    const { t } = handle;
    if (t.effect === 'magicMove') return this._magicMove(handle, resolved);
    this._stageEffect(t);
  }

  // ── Magic Move ──────────────────────────────────────────────────────────
  _magicMove({ t, was }, resolved) {
    const dur = t.dur;
    for (const obj of this.pool.objects) {
      const from = was.get(obj.id);
      if (!from) {
        // New on this scene: fade in. Skipped for objects with a pending build, which
        // start hidden and own their own entrance.
        if (obj.in) continue;
        this._fx(obj, (k) => ({ alpha: k }), dur);
        continue;
      }
      if (from.type !== obj.type) continue;
      const to = transformDelta(from, obj);
      if (to) {
        const start = {};
        for (const k of Object.keys(to)) start[k] = from[k];
        this.tweens.add({ target: obj, from: start, to, dur, ease: 'inOut' });
      }
      // Same id, different picture: crossfade on the image itself (it knows both frames).
      if (from.src != null && obj.src != null && from.src !== obj.src) obj.crossfadeFrom?.(from.src, dur);
    }
  }

  // Objects that are NOT in the next scene get a farewell: the player calls this with the
  // ids about to leave, before syncing, so the pool keeps them until the fade is over.
  leaving(ids, t) {
    const dur = t?.dur ?? DEFAULT_DUR.magicMove;
    const out = [];
    for (const id of ids) {
      const obj = this.pool.live.get(id);
      if (!obj) continue;
      out.push(obj);
      this._fx(obj, (k) => ({ alpha: 1 - k }), dur, () => {
        // Still ours to remove? A later cut may have disposed it already.
        if (this.pool.live.get(id) === obj) { this.pool.remove(id); this.renderer.setObjects(this.pool.objects); }
      });
    }
    return out;
  }

  _fx(obj, fn, dur, onDone) {
    const prog = { k: 0 };
    obj.fx = { ...NEUTRAL_FX, ...fn(0) };
    this.tweens.add({
      target: prog, to: { k: 1 }, dur, ease: 'inOut',
      onUpdate: () => { obj.fx = { ...NEUTRAL_FX, ...fn(prog.k) }; },
      onDone: () => { obj.fx = { ...NEUTRAL_FX }; onDone?.(); },
    });
  }

  // ── Snapshot effects ────────────────────────────────────────────────────
  _snapshot() {
    const c = this.stage.canvas;
    if (!c?.width) { this._snap = null; return; }
    const off = this._snapCanvas ??= document.createElement('canvas');
    if (off.width !== c.width || off.height !== c.height) { off.width = c.width; off.height = c.height; }
    const g = off.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, off.width, off.height);
    g.drawImage(c, 0, 0);
    this._snap = off;
  }

  _stageEffect(t) {
    const snap = this._snap;
    const prog = { k: 0 };
    const state = { t, snap, k: 0 };
    this.renderer.transition = state;
    this._dom(state);
    this.tweens.add({
      target: prog, to: { k: 1 }, dur: t.dur, ease: t.effect === 'push' || t.effect === 'move' ? 'inOut' : 'linear',
      onUpdate: () => { state.k = prog.k; this._dom(state); },
      onDone: () => {
        if (this.renderer.transition === state) this.renderer.transition = null;
        this._dom(null);
        this._ghost?.remove(); this._ghost = null;
      },
    });
  }

  // The DOM layer mirrors what the canvas does to the NEW content.
  // The DOM layer mirrors what the canvas does to the NEW content; the ghost (the cloned
  // outgoing layer) does the opposite half.
  _dom(state) {
    const el = this.domLayer, ghost = this._ghost;
    if (!el) return;
    if (!state) { el.style.opacity = ''; el.style.clipPath = ''; el.style.transform = ''; return; }
    const { t, k } = state;
    const [vx, vy] = DIRS[t.dir] ?? DIRS.right;
    const poly = (p) => (p === null ? '' : `polygon(${(p.length ? p : [[0, 0], [0, 0], [0, 0]]).map(([x, y]) => `${x * 100}% ${y * 100}%`).join(',')})`);
    switch (t.effect) {
      case 'fade': case 'dissolve':
        // The incoming layer is simply THERE, under the fading ghost — fading both would
        // dip through the background mid-transition.
        if (ghost) ghost.style.opacity = String(1 - k);
        else el.style.opacity = String(k);
        break;
      case 'wipe':
        el.style.clipPath = poly(wipePolygon(t.dir, k));
        // What the wipe has NOT reached yet: the same cut seen from the far side.
        if (ghost) ghost.style.clipPath = poly(wipePolygon(OPPOSITE[t.dir] ?? 'left', 1 - k));
        break;
      case 'move':
        el.style.transform = `translate(${-(1 - k) * vx * 100}%, ${-(1 - k) * vy * 100}%)`; break;
      case 'push':
        el.style.transform = `translate(${-(1 - k) * vx * 100}%, ${-(1 - k) * vy * 100}%)`;
        if (ghost) ghost.style.transform = `translate(${k * vx * 100}%, ${k * vy * 100}%)`;
        break;
      default: break;
    }
  }

  // ── Renderer hooks ──────────────────────────────────────────────────────
  // Paint the outgoing snapshot and set up the canvas for the incoming objects. The
  // renderer calls these around its object pass with the same ctx.
  static beforeObjects(g, stage, state) {
    const { t, snap, k } = state;
    const [vx, vy] = DIRS[t.dir] ?? DIRS.right;
    const W = stage.w, H = stage.h;
    const drawSnap = (dx = 0, dy = 0, alpha = 1) => {
      if (!snap) return;
      g.save();
      g.globalAlpha = alpha;
      g.drawImage(snap, dx, dy, W, H);
      g.restore();
    };
    g.save();
    switch (t.effect) {
      case 'wipe': {
        drawSnap();
        const poly = wipePolygon(t.dir, k);
        g.beginPath();
        if (poly === null) g.rect(0, 0, W, H);
        else if (!poly.length) g.rect(0, 0, 0, 0);
        else { poly.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H))); g.closePath(); }
        g.clip();
        break;
      }
      case 'move':
        drawSnap();
        g.translate(-(1 - k) * vx * W, -(1 - k) * vy * H);
        break;
      case 'push':
        drawSnap(k * vx * W, k * vy * H);
        g.translate(-(1 - k) * vx * W, -(1 - k) * vy * H);
        break;
      default: break;   // fade: the snapshot goes on top, afterwards
    }
  }

  static afterObjects(g, stage, state) {
    g.restore();
    const { t, snap, k } = state;
    if ((t.effect === 'fade' || t.effect === 'dissolve') && snap) {
      g.save();
      g.globalAlpha = 1 - k;
      g.drawImage(snap, 0, 0, stage.w, stage.h);
      g.restore();
    }
  }
}

export { EFFECTS };
