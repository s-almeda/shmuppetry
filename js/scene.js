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

// Scene-level settings, as opposed to objects. They inherit exactly like objects do —
// omit one and it carries forward — which is what lets scene 23 say "still frozen"
// without restating it.
const SCENE_FLAGS = ['freeze', 'bodyClass', 'potato', 'potatoManual'];

export function resolveScript(scenes) {
  const out = [];
  let previous = {};
  let flags = {};
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i] ?? {};
    const base = scene.reset ? {} : previous;
    const objects = {};
    if (scene.reset) flags = {};
    for (const k of SCENE_FLAGS) if (k in scene) flags[k] = scene[k];

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
      ...flags,
    });
    previous = objects;
  }
  return out;
}

// Shallow merge, except that the nested style groups (§2.3) merge one level down so a
// scene can adjust `outline.width` without restating `outline.color`.
const NESTED = new Set(['cut', 'outline', 'shadow', 'texture', 'anchor', 'orbit']);

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

  // Add a new object, with an id unique on this stage.
  add(spec) {
    let id = spec.id ?? spec.type;
    for (let i = 2; this.live.has(id); i++) id = `${spec.type}${i}`;
    const obj = this.make({ ...spec, id });
    if (obj) this.live.set(id, obj);
    return obj;
  }

  remove(id) {
    const obj = this.live.get(id);
    if (!obj) return false;
    try { obj.dispose(); } catch (err) { console.error(`[scene] disposing ${id} threw`, err); }
    return this.live.delete(id);
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

// What the panel's "+ add" menu can create. Keyed by menu entry rather than by object
// type, so a cutout is offered as "face"/"eye"/"mouth"/"hand" — each a bodyPart already
// fastened to the right part, at a z that stacks sensibly, and named for what it is.
// Picking "bodyPart" and then hunting for the fastener is a worse thing to ask of anyone.
//
// `alternates` lets one menu entry fill several slots: adding a hand takes the right hand
// first, then the left; adding an eye takes whichever is free.
const NEW_OBJECT = {
  text: { type: 'text', text: 'new text', y: 0.8 },
  image: { type: 'image', size: 0.4 },
  webcam: { type: 'webcam', fit: 'box', size: 0.5 },
  face: { type: 'bodyPart', fasten: 'face', z: 25 },
  eye: { type: 'bodyPart', z: 26, alternates: ['leftEye', 'rightEye'] },
  mouth: { type: 'bodyPart', fasten: 'mouth', z: 26 },
  hand: { type: 'bodyPart', z: 30, alternates: ['rightHand', 'leftHand'] },
  audio: { type: 'audio', playing: true },
};

// ── Player ────────────────────────────────────────────────────────────────
// Walks the script scene by scene, following the stage directions (§2.5).

export class Player {
  constructor({ make, renderer, tracking, camera, bodyBase, onSceneChange } = {}) {
    this.renderer = renderer;
    this.tracking = tracking;
    this.camera = camera;
    this.bodyBase = bodyBase;   // classes that survive every scene, e.g. 'show-mode'
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
    const scene = this.resolved[next];
    // Freeze holds ALL tracking: landmarks stop updating, so every cutout, mount and
    // fastener downstream holds its pose without knowing anything about freezing.
    if (this.tracking) this.tracking.frozen = !!scene.freeze;
    // Freeze holds the picture as well as the tracking, or a frozen cutout would keep
    // showing live video through a still outline.
    if (this.camera) { if (scene.freeze) this.camera.snap(); else this.camera.release(); }
    const det = this.tracking?.detector;
    if (det) {
      det.enabled = !!scene.potato;
      det.manual = !!scene.potatoManual;
      if (!det.manual) det.manualOn = false;   // never leave the override armed by accident
    }
    // Scene chrome is a body class; the CSS does the rest. Not a skin system.
    document.body.className = `${this.bodyBase ?? ''} ${scene.bodyClass ?? ''}`.trim();

    const objects = this.pool.sync(scene.objects);
    // Freeze holds the SOUND as well as the picture and the tracking. Applied AFTER sync
    // so it overrides the resolved spec for the length of the freeze without editing it —
    // step to a scene that is not frozen and the scene's own `playing` value comes back,
    // resuming from where it stopped rather than restarting the cue.
    if (scene.freeze) for (const o of objects) if (o.type === 'audio') o.playing = false;
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
  // Back to a bare stage: the webcam, full frame, nothing on top. The starting point for
  // authoring a scene, and the way out when one has accumulated too much to reason about.
  //
  // Everything inherited from the previous scene is dropped, which `captureCurrentScene`
  // records as explicit nulls — so a reset survives save and reload.
  resetScene() {
    this.pool.clear();
    this.pool.add({ id: 'cam', type: 'webcam', fit: 'cover', z: -100 });
    this.renderer.setObjects(this.pool.objects);
  }

  // `key` is a menu entry from NEW_OBJECT, not a bare type.
  addObject(key) {
    const { alternates, ...spec } = NEW_OBJECT[key] ?? { type: key };
    if (alternates) {
      // Take the first slot not already on stage, so adding two hands gives you one of
      // each rather than two of the same.
      const taken = new Set(this.pool.objects.map((o) => o.fasten));
      spec.fasten = alternates.find((a) => !taken.has(a)) ?? alternates[0];
    }
    // Name it for what it is — `leftEye`, not `bodyPart3`.
    const obj = this.pool.add({ id: spec.fasten ?? spec.type, ...spec });
    if (obj) this.renderer.setObjects(this.pool.objects);
    return obj;
  }

  removeObject(id) {
    const ok = this.pool.remove(id);
    if (ok) this.renderer.setObjects(this.pool.objects);
    return ok;
  }

  captureCurrentScene() {
    if (this.index < 0) return null;
    const objects = this.pool.serialize();

    // A scene inherits the previous scene's stage, so an object that is simply ABSENT
    // here would come back on reload. Removal has to be written as an explicit null.
    const before = this.index > 0 ? this.resolved[this.index - 1].objects : {};
    for (const id of Object.keys(before)) if (!(id in objects)) objects[id] = null;
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
