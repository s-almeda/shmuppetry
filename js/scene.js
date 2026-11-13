import { Tweens } from './tween.js';
import { Builds } from './builds.js';
import { Transitions, normalizeTransition } from './transition.js';

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

const byStep = (actions) => (Array.isArray(actions) ? [...actions].sort((a, b) => (a?.step ?? 1) - (b?.step ?? 1)) : []);

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

    // Inherit everything from the previous resolved stage — except BUILDS. An `in` or
    // `out` belongs to the scene that states it: an object that built in on scene 5 is
    // simply THERE on scene 6, not hidden again waiting for another click. And an object
    // that built OUT has left: it is not carried forward unless the next scene names it.
    // ACTIONS do carry their RESULT forward: an action changes the object (builds.js), so
    // the next scene starts from what the audience was last shown, not from before it.
    const left = {};
    for (const [id, spec] of Object.entries(base)) {
      const { in: _in, out, actions, ...rest } = spec;
      for (const a of byStep(actions)) if (a?.set) Object.assign(rest, a.set);
      if (out) left[id] = rest; else objects[id] = rest;
    }

    // Apply this scene's patch.
    for (const [id, patch] of Object.entries(scene.objects ?? {})) {
      if (patch === null) { delete objects[id]; continue; }
      const prior = objects[id] ?? left[id];
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
      // Which public toggles this scene STARTS with. Per-scene and non-inheriting, like
      // _note — a scene that already puts cutouts on both hands wants to start with the
      // hand puppets off, and that must not then carry forward to every later scene.
      toggles: scene.toggles,
      // How this scene ARRIVES. Per-scene and non-inheriting, like _note: a wipe into
      // scene 12 says nothing about how scene 13 should come in.
      transition: normalizeTransition(scene.transition),
      slide: !!scene.slide,
      // Scene-level actions: builds that set this scene's own flags (freeze, …) on a step.
      actions: Array.isArray(scene.actions) ? scene.actions : undefined,
      objects,
      ...flags,
    });
    // …and, like an object's, their result is what the next scene inherits.
    for (const a of byStep(scene.actions)) {
      for (const k of SCENE_FLAGS) if (a?.set && k in a.set) flags = { ...flags, [k]: a.set[k] };
    }
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
    this.make = make;        // (spec, { dom }) => StageObject | null
    this.live = new Map();   // id → StageObject
    // Slide scenes draw their objects as page elements (objects.js placeBox); set per
    // scene by the player before each sync.
    this.dom = false;
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
      // An object crossing between a puppet scene and a slide changes how it is drawn, so
      // it is rebuilt rather than updated (only types that CAN be page elements care).
      const sameMode = !existing?.constructor.domCapable || existing.isDom === this.dom;
      if (existing && sameMode && existing.type === (spec.type ?? existing.type)) {
        existing.apply(spec);
      } else {
        if (existing) { try { existing.dispose(); } catch { /* already gone */ } }
        const obj = this.make({ ...spec, id }, { dom: this.dom });
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
    const obj = this.make({ ...spec, id }, { dom: this.dom });
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
  constructor({ make, renderer, tracking, camera, bodyBase, onSceneChange, stage, domLayer } = {}) {
    this.renderer = renderer;
    this.tracking = tracking;
    this.camera = camera;
    this.bodyBase = bodyBase;   // classes that survive every scene, e.g. 'show-mode'
    this.pool = new ObjectPool(make);
    this.script = [];       // raw, as authored — what gets saved back
    this.resolved = [];     // fully resolved absolute stages
    this.index = -1;
    this.onSceneChange = onSceneChange ?? (() => {});
    // Motion between and within scenes (js/tween.js, js/builds.js, js/transition.js).
    // `tick` runs them from the renderer's frame clock.
    this.tweens = new Tweens();
    this.builds = new Builds({ pool: this.pool, tweens: this.tweens, onScene: (set) => this._sceneAction(set) });
    this.liveFlags = {};
    this.transitions = new Transitions({ pool: this.pool, tweens: this.tweens, renderer, stage, domLayer });
  }

  tick(now) { this.tweens.update(now); }

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

  // `instant` paints the scene with every typewriter finished and no transition.
  // `built` lands with every build already played — what stepping BACK into a scene
  // should show, as in Keynote.
  goto(i, { instant = false, built = false } = {}) {
    if (!this.resolved.length) return;
    const next = Math.max(0, Math.min(i, this.resolved.length - 1));
    const from = this.index;
    this.index = next;
    const scene = this.resolved[next];
    // Whatever was mid-flight lands now, so the outgoing stage is exactly its scene.
    this.tweens.finishAll();
    this.renderer.transition = null;
    // A transition only plays going FORWARD one scene — jumping around the script, or
    // stepping back, is a hard cut: you are navigating, not performing.
    const t = !instant && next === from + 1 ? scene.transition : null;
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

    // `decorate` lets something outside the script contribute to the resolved stage —
    // the public showcase panel puts a visitor's chosen puppets in here. It runs BEFORE
    // sync on purpose: sync already knows how to add, update in place and dispose, so a
    // toggle turning on is a key appearing and turning off is a key missing. Re-adding
    // objects after sync would have to reimplement all three, and would rebuild objects
    // that should have persisted across the cut.
    const resolved = this.decorate ? this.decorate(scene) : scene.objects;
    this.pool.dom = !!scene.slide;
    const handle = this.transitions.before(t);
    // Under a Magic Move, objects that leave fade out rather than vanish: they are kept
    // in the pool for the length of the tween by handing sync() a stage that still has
    // them, and removed when their fade lands.
    let target = resolved;
    if (t?.effect === 'magicMove') {
      const leaving = [...this.pool.live.keys()].filter((id) => !(id in resolved));
      if (leaving.length) {
        target = { ...resolved };
        for (const o of this.transitions.leaving(leaving, t)) target[o.id] = o.serialize();
      }
    }
    const objects = this.pool.sync(target);
    this.transitions.after(handle, resolved);
    // Builds: objects with a pending `in` start hidden, unless we arrive from ahead.
    this.liveFlags = Object.fromEntries(SCENE_FLAGS.map((k) => [k, scene[k]]));
    this.builds.prepare(resolved, { done: built || (from > next), sceneActions: scene.actions });
    if (this.reveal) this.builds.revealAll();
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

  // Edit mode shows EVERY object in the scene — ones waiting on a build and ones already
  // built out — because you cannot adjust what you cannot see. Turning it off puts the
  // scene in its fully-built state without re-syncing, so unsaved edits stay on stage.
  setReveal(on) {
    this.reveal = !!on;
    if (this.index < 0) return;
    if (this.reveal) this.builds.revealAll();
    else this.builds.prepare(this.scene.objects, { done: true, sceneActions: this.scene.actions });
  }

  // A scene-level action (builds.js): change this scene's flags mid-scene, on a build
  // step. Returns the values it replaced, which is what ← hands back to undo it.
  _sceneAction(set) {
    const prev = {};
    for (const k of SCENE_FLAGS) if (k in set) { prev[k] = this.liveFlags[k]; this.liveFlags[k] = set[k]; }
    const f = this.liveFlags;
    if ('freeze' in set) {
      if (this.tracking) this.tracking.frozen = !!f.freeze;
      if (this.camera) { if (f.freeze) this.camera.snap(); else this.camera.release(); }
    }
    const det = this.tracking?.detector;
    if (det && ('potato' in set || 'potatoManual' in set)) {
      det.enabled = !!f.potato;
      det.manual = !!f.potatoManual;
      if (!det.manual) det.manualOn = false;
    }
    // classList, not className: rewriting the whole attribute mid-scene would also drop
    // `editing` and whatever else has been toggled on the body since the scene began.
    if ('bodyClass' in set) {
      const split = (v) => String(v ?? '').split(/\s+/).filter(Boolean);
      document.body.classList.remove(...split(prev.bodyClass));
      document.body.classList.add(...split(f.bodyClass));
    }
    return prev;
  }

  next() { this.goto(this.index + 1); }
  // Stepping back lands on the previous scene with its builds played — the state you
  // left it in — so ← is always exactly one step back, build or scene.
  prev() { this.goto(this.index - 1, { built: true }); }

  // Space is one key with three jobs, as in 2.5.0 plus Keynote: finish the current line
  // if it is still typing, else play the next build step, else advance. A fast reader
  // never waits out a line they have read.
  advance() {
    const typing = this.pool.objects.filter((o) => o.typing && !o._hidden);
    if (typing.length) {
      for (const o of typing) o.finishTyping();
      return;
    }
    if (this.builds.next()) { this.onSceneChange(this.scene, this); return; }
    this.next();
  }

  // ← undoes one build step if any has played, otherwise steps back a scene.
  back() {
    if (this.builds.back()) { this.onSceneChange(this.scene, this); return; }
    this.prev();
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
    // A cutout is pinned to a hand or the face, and draws nothing until that is tracked.
    // A show that never declared the capability would add an object that can never
    // appear — so adding one loads what it needs (a no-op when it is already loaded).
    if (obj?.fasten) this.tracking?.load?.(/Hand/.test(obj.fasten) ? 'hands' : 'face');
    return obj;
  }

  removeObject(id) {
    const ok = this.pool.remove(id);
    if (ok) this.renderer.setObjects(this.pool.objects);
    return ok;
  }

  captureCurrentScene() {
    if (this.index < 0) return null;
    // Land anything mid-flight first: a Magic Move halfway there would save halfway
    // positions, and an object fading out on its way off stage would be saved as present.
    this.tweens.finishAll();
    // …and undo any action that has played: the file holds the scene as it STARTS, with
    // its actions listed, not the state three clicks in. Put back straight after.
    const replay = this.builds.suspendActions();
    const objects = this.pool.serialize();
    replay();

    // Anything `decorate` put on stage belongs to the visitor, not to the script. Without
    // this, an author on localhost with the showcase toggles on would bake `hat`,
    // `leftPuppet` and friends into shows/demo/script.json the first time they pressed
    // "save scene".
    if (this.ephemeral) for (const id of Object.keys(objects)) if (this.ephemeral(id)) delete objects[id];

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
        // Shift skips the builds: straight to the next / previous scene.
        case 'ArrowRight': e.preventDefault(); e.shiftKey ? this.next() : this.advance(); break;
        case 'ArrowLeft': e.preventDefault(); e.shiftKey ? this.prev() : this.back(); break;
        default: return;
      }
    });
  }
}
