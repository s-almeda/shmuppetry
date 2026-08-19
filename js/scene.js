// ── Scenes ────────────────────────────────────────────────────────────────
// A scene resolves to the COMPLETE stage. The file may be sparse and inherit from the
// previous scene; the editor always writes back fully resolved absolute state (§2.5).
//
// This kills the single biggest documented pain in 2.5.0. There, persistence was
// per-feature folklore — toggles sticky, `stage` sticky-but-absolute, `potato` reset
// every scene, `drawingClear` one-shot, `leftPuppet` reset but `puppetSize` sticky.
// Each rule was defensible alone and unlearnable together, and it is why edit-mode
// "save scene" could only ever capture a subset of what was on screen.
//
// One rule here, enforced by the runtime: a scene inherits the previous scene's
// resolved stage, applies its patch, and that is the stage. `null` removes an object.
// `"reset": true` starts from empty.
//
// The whole script is resolved UP FRONT, from scene 0. So jumping straight to scene 40
// gives byte-identical state to stepping there one scene at a time — in 2.5.0 those two
// paths could differ, because sticky state depended on the route you took.

export function resolveScript(scenes) {
  const out = [];
  let previous = {};
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i] ?? {};
    const base = scene.reset ? {} : previous;
    const objects = {};

    // Inherit everything from the previous resolved stage.
    for (const [id, spec] of Object.entries(base)) objects[id] = { ...spec };

    // Apply this scene's patch.
    for (const [id, patch] of Object.entries(scene.objects ?? {})) {
      if (patch === null) { delete objects[id]; continue; }
      const prior = objects[id];
      if (!prior) {
        if (!patch.type) {
          console.warn(`[scene ${scene.id ?? i}] object "${id}" is new but has no "type" — skipped`);
          continue;
        }
        objects[id] = { id, ...patch };
      } else if (patch.type && patch.type !== prior.type) {
        // A changed type is a replacement, not a merge — otherwise the new object
        // inherits fields that mean nothing to it.
        objects[id] = { id, ...patch };
      } else {
        objects[id] = mergeSpec(prior, patch, id);
      }
    }

    out.push({
      id: scene.id ?? i + 1,
      index: i,
      _note: scene._note,
      objects,
    });
    previous = objects;
  }
  return out;
}

// Shallow merge, except that the nested style groups (§2.3) merge one level down so a
// scene can adjust `outline.width` without restating `outline.color`.
const NESTED = new Set(['cut', 'outline', 'shadow', 'texture', 'anchor']);

function mergeSpec(prior, patch, id) {
  const next = { ...prior, id };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (v === null) { delete next[k]; continue; }
    if (NESTED.has(k) && v && typeof v === 'object' && prior[k] && typeof prior[k] === 'object') {
      next[k] = { ...prior[k], ...v };
    } else {
      next[k] = v;
    }
  }
  return next;
}

// ── Live objects ──────────────────────────────────────────────────────────
// Syncs the live object instances to a resolved stage. Objects that persist across a
// scene change are UPDATED IN PLACE, not rebuilt — so a video keeps playing, a
// typewriter that is mid-line is not restarted, and an eased position keeps its
// momentum across the cut.
export class ObjectPool {
  constructor(make) {
    this.make = make;        // (spec) => StageObject | null
    this.live = new Map();   // id → StageObject
  }

  get objects() { return [...this.live.values()]; }

  sync(resolved) {
    // Remove what left the stage.
    for (const [id, obj] of this.live) {
      if (!(id in resolved)) {
        try { obj.dispose(); } catch (err) { console.error(`[scene] disposing ${id} threw`, err); }
        this.live.delete(id);
      }
    }
    // Add or update what is on it.
    for (const [id, spec] of Object.entries(resolved)) {
      const existing = this.live.get(id);
      if (existing && existing.type === (spec.type ?? existing.type)) {
        existing.apply(spec);
      } else {
        if (existing) { try { existing.dispose(); } catch { /* already gone */ } }
        const obj = this.make({ ...spec, id });
        if (obj) this.live.set(id, obj);
        else this.live.delete(id);
      }
    }
    return this.objects;
  }

  clear() {
    for (const obj of this.live.values()) { try { obj.dispose(); } catch { /* ignore */ } }
    this.live.clear();
  }

  // What edit mode writes back: a pure serialization of what is on screen. This is the
  // property 2.5.0 never had — there, snapshotState() was a fixed field list, so most
  // state simply could not round-trip through the save button.
  serialize() {
    const out = {};
    for (const [id, obj] of this.live) out[id] = obj.serialize();
    return out;
  }
}

// ── Player ────────────────────────────────────────────────────────────────
// Walks the script scene by scene, following the stage directions (§2.5).

export class Player {
  constructor({ make, renderer, onSceneChange } = {}) {
    this.renderer = renderer;
    this.pool = new ObjectPool(make);
    this.script = [];       // raw, as authored — what gets saved back
    this.resolved = [];     // fully resolved absolute stages
    this.index = -1;
    this.onSceneChange = onSceneChange ?? (() => {});
  }

  get scene() { return this.resolved[this.index] ?? null; }
  get length() { return this.resolved.length; }

  load(scenes) {
    this.script = Array.isArray(scenes) ? scenes : (scenes?.scenes ?? []);
    this.reresolve();
    this.index = -1;
    return this;
  }

  // Re-run resolution from scene 0. Called after any edit, because a change to scene 3
  // propagates forward into every scene that inherits from it.
  reresolve() {
    this.resolved = resolveScript(this.script);
  }

  goto(i, { instant = false } = {}) {
    if (!this.resolved.length) return;
    const next = Math.max(0, Math.min(i, this.resolved.length - 1));
    this.index = next;
    const objects = this.pool.sync(this.resolved[next].objects);
    if (instant) for (const o of objects) o.finishTyping?.();
    this.renderer.setObjects(objects);
    this.onSceneChange(this.resolved[next], this);
    console.log(`[player] scene ${this.resolved[next].id} (${next + 1}/${this.resolved.length})`);
  }

  next() { this.goto(this.index + 1); }
  prev() { this.goto(this.index - 1); }

  // Space is one key with two jobs, as in 2.5.0: finish the current line if it is still
  // typing, otherwise advance. A fast reader never waits out a line they have read.
  advance() {
    const typing = this.pool.objects.filter((o) => o.typing);
    if (typing.length) {
      for (const o of typing) o.finishTyping();
      return;
    }
    this.next();
  }

  // Apply live edits back into the authored script. The scene becomes fully resolved
  // and absolute (§2.5) — sparse authoring is preserved in the file until you save
  // through the editor, at which point that scene becomes self-contained.
  captureCurrentScene() {
    if (this.index < 0) return null;
    const objects = this.pool.serialize();
    const existing = this.script[this.index] ?? {};
    const scene = { ...existing, objects };
    if (existing.id != null) scene.id = existing.id;
    delete scene.reset;   // an absolute scene has nothing to inherit, so reset is moot
    return scene;
  }

  bindKeys(target = document) {
    const isTyping = (e) => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    target.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.advance();
          break;
        case 'ArrowRight': e.preventDefault(); this.next(); break;
        case 'ArrowLeft': e.preventDefault(); this.prev(); break;
        default: return;
      }
    });
  }
}
