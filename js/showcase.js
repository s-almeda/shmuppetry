// ── Showcase ──────────────────────────────────────────────────────────────
// The public demo's toggle panel: a visitor switches puppets on and off in any
// combination, swaps in their own art, and retypes the dialogue. None of it touches the
// repo — it lives in localStorage and dies with their browser profile.
//
// THE ONE IDEA HERE: this does not add objects to the stage. It contributes to the
// RESOLVED SCENE before ObjectPool.sync() runs, and lets sync do the work.
//
// The tempting shape is "re-add my objects after every scene change", because sync()
// disposes anything absent from the resolved scene (scene.js). That shape has to
// re-implement add, update-in-place and dispose, and it rebuilds objects that should have
// persisted — a video puppet would restart at every cut. Decorating the spec instead
// means a toggle turning on is a key appearing, a toggle turning off is a key missing,
// and sync already knows what both of those mean.

import { FACE_PARTS, FACE_MOUNTS, HAND_PARTS, FINGER_PARTS, CONTOUR_MOUNTS } from './tracking.js';

// ── The toggles ───────────────────────────────────────────────────────────
// `objects` are ordinary scene specs — nothing here is a special object type. Their ids
// are what the visitor sees in the "on stage" list, so they are named for what they ARE.
// The authoring save path filters them out by asking `owns()`, not by reading a prefix.
export const TOGGLES = {
  hands: {
    label: 'hand puppets',
    default: true,
    // One dropdown drives both hands. Per-hand differences and your own art are the
    // inspector's job — click the puppet in the on-stage list. Two mechanisms for the
    // same choice (a cycle key AND a menu) is one more than this needs.
    choice: {
      label: 'puppet', targets: ['leftPuppet', 'rightPuppet'],
      // 004_willsmith.webm is 2MB and last on purpose: nothing fetches it until picked.
      options: [
        { label: 'miku', src: 13 },
        { label: 'shadow', src: 14 },
        { label: 'loss', src: 15 },
        { label: 'dog bubble', src: 16 },
        { label: 'will smith', src: 4 },
      ],
    },
    objects: {
      leftPuppet: { type: 'image', fasten: 'leftHand', z: 40, size: 1.2, src: 13 },
      rightPuppet: { type: 'image', fasten: 'rightHand', z: 40, size: 1.2, src: 13 },
    },
  },
  heads: {
    label: 'head puppet',
    default: true,
    // An option may carry its OWN mount. Filename auto-mounting (`_glasses` → the eyes)
    // only runs while `fasten` is falsy, and these objects pin it explicitly so uploaded
    // art — which has no filename — cannot land unfastened in the corner. Without
    // per-option `fasten`, picking glasses here would wear them on top of your head.
    choice: {
      label: 'wear', targets: ['hat'],
      options: [
        { label: 'artist beret', src: 1, fasten: 'hat' },
        { label: 'top hat', src: 6, fasten: 'hat' },
        { label: 'glasses', src: 2, fasten: 'glasses' },
        { label: 'goggles', src: 3, fasten: 'glasses' },
        // The BricolMage's little body, which is already chin-mounted art — it hangs off
        // the jaw exactly like a beard would.
        { label: 'little body', src: 7, fasten: 'beard' },
      ],
    },
    objects: {
      // `fasten` is EXPLICIT rather than left to the filename. ImageObject only
      // auto-mounts from a filename while fasten is falsy, and an uploaded data: URL has
      // no filename to read a mount out of — so a visitor's own hat would land unfastened
      // in the top corner instead of on their head.
      hat: { type: 'image', fasten: 'hat', z: 41, size: 1.05, src: 1 },
    },
  },
  fingers: {
    label: 'finger puppets',
    objects: Object.fromEntries(
      ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map((f, i) => [
        f.toLowerCase(),
        { type: 'image', src: 21 + i, fasten: `left${f}`, size: 0.75, z: 40 },
      ])),
  },
  drawing: {
    label: 'drawing mode',
    hint: '☝️ point one finger to draw · ✋✋ two open hands to wipe',
    objects: {
      scribbles: { type: 'drawing', color: '#b4dd1e', size: 6, z: 45 },
    },
  },
  facebox: {
    // Scare quotes, as in 2.5.0. The categories are the thing being questioned, and a
    // label reading "age detection" straight would assert exactly what the piece doesn't.
    label: '"age" / "gender" / "mood"',
    objects: {
      faceBox: {
        type: 'label', source: 'face', z: 60,
        text: '{emotion} {age} year-old {gender}',
        color: '#b4dd1e', textColor: '#000000',
      },
    },
  },
  potato: {
    label: 'potato detector',
    objects: {
      potatoBox: {
        type: 'label', source: 'potato', z: 60,
        text: 'potato {score}', color: '#b4dd1e', textColor: '#000000',
      },
    },
  },
};

// ── Capabilities ──────────────────────────────────────────────────────────
const FACE_FASTENERS = new Set([
  ...FACE_PARTS, ...Object.keys(FACE_MOUNTS), ...Object.keys(CONTOUR_MOUNTS),
]);
const HAND_FASTENERS = new Set([...HAND_PARTS, ...FINGER_PARTS]);

// What a set of object specs NEEDS in order to draw. Derived, never declared: the objects
// already say what they are pinned to, and a `needs` key on the scene would have to join
// SCENE_FLAGS, which would make it inherit forward — wrong for a one-scene requirement.
export function capsFor(objects = {}) {
  const caps = new Set();
  for (const spec of Object.values(objects)) {
    if (!spec) continue;
    // "face.hat" is pinned to another object's mount; the mount name is what matters.
    const pin = String(spec.fasten ?? '').split('.').pop();
    if (FACE_FASTENERS.has(pin)) caps.add('face');
    if (HAND_FASTENERS.has(pin)) caps.add('hands');
    if (pin === 'potato') caps.add('potato');
    // Drawing reads the raw hand landmarks directly rather than through a fastener.
    if (spec.type === 'drawing') caps.add('hands');
    if (spec.type === 'label') {
      caps.add(spec.source === 'potato' ? 'potato' : 'faceLabels');
      if (spec.source !== 'potato') caps.add('face');
    }
  }
  return caps;
}

// What each toggle needs, derived from its own objects rather than listed a second time —
// a hand-written table beside capsFor() is two sources of truth that drift the first time
// a preset changes what it is pinned to.
const CAPS_OF = Object.fromEntries(
  Object.entries(TOGGLES).map(([id, t]) => [id, [...capsFor(t.objects)]]));

// Every id this module can put on stage. `captureCurrentScene` asks before writing a
// scene back to disk, so a visitor's puppets never end up in the repo.
const OWNED = new Set(Object.values(TOGGLES).flatMap((t) => Object.keys(t.objects)));

// What a scene starts with before anyone touches a switch, so the rig is already puppeting
// when a visitor arrives instead of being a webcam with a menu beside it. A scene can
// override this with its own `toggles` array.
const DEFAULT_ON = Object.entries(TOGGLES).filter(([, t]) => t.default).map(([id]) => id);

const MAX_UPLOAD_PX = 512;   // a phone photo as a data URL is ~4MB; the whole budget is 5

export class Showcase {
  constructor({ player, edit, tracking, detector, faces, showName, toggles }) {
    this.player = player;
    this.edit = edit;
    this.detector = detector;
    this.key = `shmuppetry:${showName}`;
    // The show config decides which toggles exist, so this panel can be tested on
    // localhost rather than only existing where authoring is unavailable.
    this.ids = (toggles ?? []).filter((id) => id in TOGGLES);
    // Each entry is (start it, ask how it is doing). All three modules already guard
    // their own load() against a second call and expose idle | loading | ready | failed,
    // so nothing here has to change them.
    this.caps = {
      hands: { load: () => tracking.load('hands'), state: () => tracking.state.hands },
      face: { load: () => tracking.load('face'), state: () => tracking.state.face },
      potato: { load: () => detector.load(), state: () => detector.state },
      faceLabels: { load: () => faces.load(), state: () => faces.state },
    };
    this._pending = {};
    this._saveTimer = null;
    this.store = this._read();
  }

  // ── Storage ─────────────────────────────────────────────────────────────
  _read() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? 'null');
      if (raw?.v === 1) return raw;
    } catch { /* corrupt or unavailable — start clean rather than break the page */ }
    return { v: 1, scenes: {}, images: {} };
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.key, JSON.stringify(this.store));
      } catch {
        // Almost certainly the quota, and almost certainly an image. Toggles and text are
        // tiny and worth more than the art, so drop the art and keep them.
        this.store.images = {};
        try { localStorage.setItem(this.key, JSON.stringify(this.store)); } catch { /* give up quietly */ }
        console.warn('[showcase] storage full — uploaded images dropped');
      }
    }, 400);
  }

  // Keyed by scene ID, not index, so reordering the script does not scramble a visitor's
  // saved state.
  _rec(create = false) {
    const id = String(this.player.scene?.id ?? '');
    if (!id) return null;
    if (!this.store.scenes[id] && create) this.store.scenes[id] = {};
    return this.store.scenes[id] ?? null;
  }

  // `on` absent means untouched, so the defaults apply. An EMPTY array is different: it
  // means the visitor turned everything off here, and must not spring back to the
  // defaults on the next scene change.
  onFor(scene) {
    const stored = this.store.scenes[String(scene?.id)]?.on;
    return (stored ?? scene?.toggles ?? DEFAULT_ON).filter((id) => this.ids.includes(id));
  }

  isOn(toggleId) { return this.onFor(this.player.scene).includes(toggleId); }

  // Which stock option a toggle's dropdown is on, defaulting to the first.
  pickOf(toggleId) {
    const c = TOGGLES[toggleId]?.choice;
    if (!c) return null;
    return this._rec()?.pick?.[toggleId] ?? c.options[0].src;
  }

  setPick(toggleId, src) {
    const rec = this._rec(true);
    const c = TOGGLES[toggleId]?.choice;
    if (!rec || !c) return;
    (rec.pick ??= {})[toggleId] = src;
    // Choosing a stock puppet means "use this one" — so it clears any art the visitor
    // uploaded into those slots, which would otherwise keep winning and make the menu
    // look broken.
    for (const id of c.targets) delete this.store.images[id];
    this._save();
    this.refresh();
  }

  // Is this object mine rather than the script's? Asked by captureCurrentScene.
  owns(id) { return OWNED.has(id); }

  // Open the file picker aimed at one object. Called from the inspector, so replacing art
  // works for ANY image on stage — a toggle's puppet or the scene's own curtain.
  pickFor(objId) { this._uploadTo = objId; this.fileInput?.click(); }

  setToggle(toggleId, on) {
    const rec = this._rec(true);
    if (!rec) return;
    // Seeded from what is currently on — including the defaults — so flipping one switch
    // does not silently clear the others.
    const set = new Set(this.onFor(this.player.scene));
    on ? set.add(toggleId) : set.delete(toggleId);
    rec.on = [...set];
    this._save();
    this.refresh();
    if (on) this._await(toggleId);
  }

  resetScene() {
    const id = String(this.player.scene?.id ?? '');
    delete this.store.scenes[id];
    this._save();
    this.refresh();
  }

  // Re-run the current scene through decorate(). The same move revert() already makes.
  refresh() { this.player.goto(this.player.index); this.paint(); }

  // ── Hook 1: contribute to the resolved stage, before sync ───────────────
  decorate(scene) {
    const out = { ...scene.objects };
    const rec = this.store.scenes[String(scene.id)] ?? {};

    for (const toggleId of this.onFor(scene)) {
      const t = TOGGLES[toggleId];
      if (!t || !this.ids.includes(toggleId)) continue;
      // The whole option, not just its src — an option may override the mount and the
      // size along with the art.
      const opts = t.choice?.options ?? [];
      const picked = opts.find((o) => o.src === (rec.pick?.[toggleId] ?? opts[0]?.src));
      for (const [id, preset] of Object.entries(t.objects)) {
        out[id] = { ...preset };
        if (picked && t.choice.targets.includes(id)) {
          const { label, ...over } = picked;
          Object.assign(out[id], over);
        }
      }
    }

    // A visitor can replace the art on anything, including objects the script put there,
    // so this runs over the whole stage rather than only over the toggles above.
    for (const [id, url] of Object.entries(this.store.images)) {
      const spec = out[id];
      if (!spec || spec.type !== 'image') continue;
      if (spec.srcs) out[id] = { ...spec, srcs: [url, ...spec.srcs.filter((e) => e !== url)] };
      else out[id] = { ...spec, src: url };
    }

    // Text overrides merge into the SPEC, not onto the live object — apply() deletes any
    // key the incoming spec omits, so an override written onto the instance would last
    // exactly until the next scene change.
    for (const [id, patch] of Object.entries(rec.text ?? {})) {
      if (out[id]?.type === 'text') out[id] = { ...out[id], ...patch };
    }
    return out;
  }

  // ── Hook 2: the things an object spec cannot express ────────────────────
  afterScene(scene) {
    // The detector is a scene FLAG, re-applied by goto on every scene change, so the
    // toggle has to have the last word. The showcase scenes never set the flag.
    const on = this.isOn('potato');
    if (on && this.detector) { this.detector.enabled = true; this.detector.manual = true; }

    // goto() rewrites body.className wholesale, which wipes this class while edit.editing
    // is still true — the box stays editable but stops looking editable.
    document.body.classList.toggle('editing', !!this.edit?.editing);

    for (const cap of capsFor(this.decorate(scene))) this.ensure(cap);
  }

  // ── Lazy capability loading ─────────────────────────────────────────────
  // Polling rather than promise-ifying the three modules' load() methods: those sit on
  // the config-driven boot path too, and ten lines here risk nothing there.
  ensure(cap) {
    const entry = this.caps[cap];
    if (!entry) return Promise.resolve('failed');
    return (this._pending[cap] ??= new Promise((resolve) => {
      entry.load();
      const tick = () => {
        const s = entry.state();
        if (s === 'ready' || s === 'failed') resolve(s);
        else setTimeout(tick, 150);
      };
      tick();
    }));
  }

  _capsReady(toggleId) {
    return (CAPS_OF[toggleId] ?? []).every((c) => this.caps[c]?.state() === 'ready');
  }

  _capsFailed(toggleId) {
    return (CAPS_OF[toggleId] ?? []).some((c) => this.caps[c]?.state() === 'failed');
  }

  async _await(toggleId) {
    await Promise.all((CAPS_OF[toggleId] ?? []).map((c) => this.ensure(c)));
    this.paint();
  }

  // ── Text capture ────────────────────────────────────────────────────────
  // Stores only what DIFFERS from the scene as authored, so a later edit to script.json
  // still shows through on every line the visitor never touched.
  captureText() {
    const scene = this.player.scene;
    if (!scene) return;
    const rec = this._rec(true);
    if (!rec) return;
    const text = {};
    for (const o of this.player.pool.objects) {
      if (o.type !== 'text') continue;
      const base = scene.objects[o.id] ?? {};
      const patch = {};
      if ((o.text ?? '') !== (base.text ?? '')) patch.text = o.text ?? '';
      if ((o.speaker ?? null) !== (base.speaker ?? null)) patch.speaker = o.speaker ?? null;
      if (Object.keys(patch).length) text[o.id] = patch;
    }
    if (Object.keys(text).length) rec.text = text; else delete rec.text;
    this._save();
  }

  // ── Image upload ────────────────────────────────────────────────────────
  async importImage(objId, file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = rej;
        el.src = url;
      });
      const scale = Math.min(1, MAX_UPLOAD_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      // PNG, not JPEG: a puppet with no transparency is a rectangle stuck to your hand.
      this.store.images[objId] = c.toDataURL('image/png');
      this._save();
      // `index` is runtime state that survives sync, so a stale one would now point at a
      // different entry than the visitor was looking at.
      const live = this.player.pool.live.get(objId);
      if (live) live.index = 0;
      this.refresh();
    } catch {
      console.warn('[showcase] could not read that image');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ── Panel UI ────────────────────────────────────────────────────────────
  mount(host, fileInput) {
    this.host = host;
    this.fileInput = fileInput;
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';                 // so re-picking the same file fires again
      if (file && this._uploadTo) this.importImage(this._uploadTo, file);
    });
    this.paint();
  }

  paint() {
    const host = this.host;
    if (!host) return;
    host.innerHTML = '';
    for (const id of this.ids) {
      const t = TOGGLES[id];
      const on = this.isOn(id);
      const failed = this._capsFailed(id);
      const waiting = on && !failed && !this._capsReady(id);

      const row = document.createElement('div');
      row.className = 'panel-row';
      const label = document.createElement('label');
      label.className = 'wide';
      label.textContent = t.label;
      row.appendChild(label);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `toggle${on ? ' on' : ''}${waiting ? ' loading' : ''}`;
      btn.textContent = failed ? 'n/a' : waiting ? '…' : on ? 'on' : 'off';
      btn.disabled = failed;
      btn.addEventListener('click', () => this.setToggle(id, !this.isOn(id)));
      row.appendChild(btn);
      host.appendChild(row);

      // Gestures are invisible until someone tells you about them, so a toggle whose
      // controls are POSES carries a plain-language line — 2.5.0 did this on every
      // feature row and it is most of what made the panel legible.
      if (on && t.hint) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent = t.hint;
        host.appendChild(hint);
      }

      // The menu only appears once the toggle is on: offering a choice of puppet for
      // something that is not on stage is a control that appears to do nothing.
      if (on && t.choice) {
        const sub = document.createElement('div');
        sub.className = 'panel-row sub';
        const cap = document.createElement('label');
        cap.textContent = t.choice.label;
        sub.appendChild(cap);
        const sel = document.createElement('select');
        for (const o of t.choice.options) {
          const opt = document.createElement('option');
          opt.value = String(o.src);
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        sel.value = String(this.pickOf(id));
        sel.addEventListener('change', () => this.setPick(id, Number(sel.value)));
        sub.appendChild(sel);
        host.appendChild(sub);
      }
    }
  }
}
