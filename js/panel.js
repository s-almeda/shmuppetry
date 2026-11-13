// ── Control panel (§2.7) ──────────────────────────────────────────────────
// Successor to 2.5.0's AnalysisPanel. Near-invisible until hover; changes scenes,
// toggles objects, adjusts them, and saves edits back into the scene JSON.
//
// The payoff of uniform objects is here: ONE generic inspector, driven by each object's
// declared `fields`, for any object type. 2.5.0 grew four separate hand-written panel
// blocks — hand puppets, head puppets, stage puppets, potato — that each needed
// individual wiring, and adding a capability meant writing panel HTML by hand.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class EditMode {
  constructor({ player, showName, banner }) {
    this.player = player;
    this.showName = showName;
    this.banner = banner;
    this.available = false;
    this.dirty = false;
    this.editing = false;   // in-place text editing, off until asked for
  }

  // Editing text is NOT gated on `available`. A visitor on the public site retypes the
  // dialogue and it is kept in their browser; only WRITING TO DISK is privileged, and
  // that is guarded three separate times below — _setDirty, save(), and the hidden
  // #p-edit-section — plus the dev server's own loopback check.
  setEditing(on) {
    this.editing = !!on;
    document.body.classList.toggle('editing', this.editing);
    this.onEditing?.(this.editing);
  }

  get isLoopback() { return LOOPBACK.has(location.hostname); }

  async probe() {
    if (!this.isLoopback) { this.available = false; return false; }
    try {
      const res = await fetch('./api/health', { method: 'GET', cache: 'no-store' });
      this.available = res.ok;
    } catch {
      this.available = false;
    }
    if (!this.available) {
      console.info('[edit] no local server — authoring disabled. Run `node server/dev-server.js` to enable it.');
    }
    return this.available;
  }

  // onEdit fires BEFORE _setDirty, which is gated on `available` — so the showcase can
  // capture a visitor's text edit on the public site where the dirty/save machinery
  // deliberately does nothing.
  markDirty() { this.onEdit?.(); this._setDirty(true); }

  onSceneChange() {
    // Moving to another scene discards nothing, but the banner tracked the scene you
    // were editing, so it stops being meaningful.
    this._setDirty(false);
  }

  // Save/revert only exist when there is something to save or revert.
  _setDirty(v) {
    if (!this.available) return;
    this.dirty = v;
    this.banner.hidden = !v;
    this.onDirtyChange?.(v);
  }

  async save() {
    if (!this.available) return false;
    const scene = this.player.captureCurrentScene();
    if (!scene) return false;

    // Write the fully resolved absolute scene into the script, then re-resolve from
    // scene 0 — a change here propagates into every later scene that inherits from it.
    this.player.script[this.player.index] = scene;
    this.player.reresolve();

    // ONE scene, not the whole script. The server splices it into whatever is on disk at
    // that instant, so a tab loaded before an outside edit can only clobber the scene it
    // was actually editing — it no longer rewinds the entire file to what it last saw.
    try {
      const res = await fetch(
        `./api/shows/${encodeURIComponent(this.showName)}/scene/${this.player.index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scene, null, 2),
        });
      if (!res.ok) {
        const detail = await res.text();
        // 409 means the file has a different number of scenes than this tab does, so the
        // index points somewhere else now. Say so plainly — it is the one case where
        // carrying on would write the right scene into the wrong slot.
        if (res.status === 409) {
          this.banner.hidden = false;
          this.banner.textContent = 'script changed on disk — reload before saving';
          console.warn('[edit]', detail);
          return false;
        }
        throw new Error(`${res.status} ${detail}`);
      }
      this._setDirty(false);
      console.log(`[edit] saved scene ${scene.id ?? this.player.index + 1}`);
      return true;
    } catch (err) {
      console.error('[edit] save failed', err);
      this.banner.hidden = false;
      this.banner.textContent = 'save failed — see console';
      return false;
    }
  }

  // Discard live changes by re-applying the resolved scene from the script.
  revert() {
    this.player.reresolve();
    this.player.goto(this.player.index, { instant: true });
    this._setDirty(false);
  }

  // Works with or without a server, and on the public page too — the escape hatch when
  // you want the JSON without writing a file.
  async copyToClipboard() {
    const scene = this.player.captureCurrentScene();
    const text = JSON.stringify(scene, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      console.log('[edit] scene JSON copied');
    } catch {
      console.log(text);   // clipboard needs a secure context; the console always works
    }
  }
}

// ── Asset metadata editor ───────────────────────────────────────────────────
// Provenance and the face box live in assets/meta.json, keyed by asset number, so they
// belong to the ART rather than to the scene — which is the whole point: the same painting
// carries its credit line into every scene and every show that uses it.
//
// A metadata record is a plain object, not a StageObject, but renderFields only ever needs
// a `fields` array and property access. So this is an ADAPTER: the nested `face` box is
// flattened onto it as face x/y/w/h/roll, and the generic renderer works unchanged.
const META_TEXT = ['title', 'artist', 'year', 'medium', 'source'];
const FACE_KEYS = { faceX: 'x', faceY: 'y', faceW: 'w', faceH: 'h', faceRoll: 'roll' };

function metaAdapter(rec, { src, assets, tracking, onSave }) {
  const a = {
    fields: [
      ...META_TEXT.map((key) => ({ key, label: key, type: 'text' })),
      { key: 'note', label: 'note', type: 'textarea' },
      { key: 'scan', label: 'scan', type: 'button', text: 'scan face',
        title: 'find the face in this image, so align:"face" can put it on yours' },
      { key: 'faceX', label: 'face x', type: 'range', min: 0, max: 1, step: 0.002 },
      { key: 'faceY', label: 'face y', type: 'range', min: 0, max: 1, step: 0.002 },
      { key: 'faceW', label: 'face w', type: 'range', min: 0.02, max: 1, step: 0.002 },
      { key: 'faceH', label: 'face h', type: 'range', min: 0.02, max: 1, step: 0.002 },
      { key: 'faceRoll', label: 'face roll°', type: 'range', min: -45, max: 45, step: 0.5 },
      { key: 'save', label: 'save', type: 'button', text: 'save metadata',
        title: 'write assets/meta.json' },
    ],

    async scan() {
      const el = assets.get(src);
      if (!el) return 'no image';
      // A freshly-picked asset may not have decoded yet, and detect() on a zero-sized
      // image fails in a way that reads as "no face here" rather than "not loaded yet".
      if (!(el.complete || el.readyState >= 2)) {
        await new Promise((r) => { el.onload = el.onloadeddata = r; setTimeout(r, 4000); });
      }
      const face = await tracking.scanImage(el);
      if (!face) {
        console.warn(`[meta] no face found in asset ${src} — set the box by hand with the sliders below`);
        rec.face ??= { x: 0.3, y: 0.2, w: 0.4, h: 0.45, roll: 0 };
        return 'not found';
      }
      rec.face = face;
      console.log(`[meta] asset ${src} face`, face);
      return 'scanned ✓';
    },

    async save() {
      try {
        const res = await fetch('./api/assets/meta', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(assets.serializeMeta(), null, 2),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        onSave?.();
        return 'saved ✓';
      } catch (err) {
        console.error('[meta] save failed', err);
        return 'failed';
      }
    },
  };

  // An emptied text field DELETES its key rather than storing '' — otherwise every asset
  // you so much as look at accumulates six empty strings in meta.json.
  for (const k of [...META_TEXT, 'note']) {
    Object.defineProperty(a, k, {
      get: () => rec[k] ?? '',
      set: (v) => { if (v === '' || v == null) delete rec[k]; else rec[k] = v; },
    });
  }
  for (const [k, f] of Object.entries(FACE_KEYS)) {
    Object.defineProperty(a, k, {
      get: () => rec.face?.[f] ?? 0,
      set: (v) => { if (Number.isFinite(v)) (rec.face ??= { x: 0, y: 0, w: 0.4, h: 0.45, roll: 0 })[f] = v; },
    });
  }
  return a;
}

export class Panel {
  constructor({ el, player, edit, detector = null, tabLabel = null, showcase = null,
                assets = null, tracking = null, mic = null }) {
    this.el = el;
    this.player = player;
    this.edit = edit;
    this.detector = detector;
    this.showcase = showcase;   // the public toggle group; null on a performance rig
    this.assets = assets;
    this.tracking = tracking;
    this.mic = mic;
    this.tabLabel = tabLabel;   // omit → no tab at all (performance rigs)
    this.selectedId = null;
    this._inspectorFor = null;
    this._metaFor = null;
  }

  mount() {
    // xp.css idiom, as in 2.5.0: a tablist "title tab" over a fieldset. Scene navigation
    // lives at the very top — it is the control you reach for most. Runtime state
    // (date, runtime, camera) is NOT here; it belongs in the window's status bar.
    const tab = this.tabLabel
      ? `<menu role="tablist"><button role="tab" aria-selected="true" type="button">${this.tabLabel}</button></menu>`
      : '';
    this.el.innerHTML = `
      ${tab}
      <fieldset>
        <div class="group">
          <div class="scene-nav">
            <button id="p-prev" type="button" title="previous scene (←)">‹</button>
            <input id="p-num" type="text" value="1" title="scene number" />
            <span class="count" id="p-count">/ 0</span>
            <button id="p-next" type="button" title="next scene (→)">›</button>
          </div>
        </div>
        <div class="group" id="p-showcase-section" hidden>
          <div id="p-toggles"></div>
          <div class="panel-row"><button id="p-showcase-reset" type="button">reset this scene</button></div>
          <input type="file" id="p-upload" accept="image/*" hidden />
        </div>
        <div class="group">
          <b>on stage</b>
          <div id="p-objects"></div>
          <div class="panel-row add-row">
            <select id="p-add-type">
              <option value="">+ add…</option>
              <option value="face">face</option>
              <option value="eye">eye</option>
              <option value="mouth">mouth</option>
              <option value="hand">hand</option>
              <option value="image">image</option>
              <option value="text">text</option>
              <option value="webcam">webcam</option>
              <option value="audio">audio</option>
            </select>
          </div>
        </div>
        <div class="group" id="p-inspector-section" hidden>
          <b id="p-inspector-title">object</b>
          <div id="p-preview" hidden></div>
          <div id="p-inspector"></div>
        </div>
        <div class="group" id="p-meta-section" hidden>
          <b id="p-meta-title">asset</b>
          <div id="p-meta"></div>
        </div>
        <div class="group" id="p-mic-section" hidden>
          <b>🎤 mic</b>
          <div class="mic-meter"><i id="p-mic-bar"></i><u id="p-mic-floor"></u></div>
          <div id="p-mic"></div>
        </div>
        <div class="group" id="p-potato-section" hidden>
          <b>🥔 potato</b>
          <div id="p-potato"></div>
        </div>
        <div class="group" id="p-edit-section" hidden>
          <div class="panel-row">
            <label style="flex:1">edit text in place</label><button class="toggle" id="p-editing" type="button">off</button>
          </div>
          <div class="panel-row"><button id="p-reset" type="button">reset stage</button></div>
          <div class="panel-row" style="gap:3px" id="p-save-row" hidden>
            <button id="p-save" type="button">save scene</button>
            <button id="p-revert" type="button">revert</button>
          </div>
          <div class="panel-row"><button id="p-copy" type="button">copy JSON</button></div>
        </div>
      </fieldset>`;

    this.$ = (id) => this.el.querySelector(id);

    this.edit.onDirtyChange = (dirty) => { this.$('#p-save-row').hidden = !dirty; };

    // The public group. Gated on the show CONFIG rather than on !edit.available, so it
    // can be worked on from localhost instead of only where authoring is switched off.
    if (this.showcase?.ids.length) {
      this.$('#p-showcase-section').hidden = false;
      this.showcase.mount(this.$('#p-toggles'), this.$('#p-upload'));
      this.$('#p-showcase-reset').addEventListener('click', () => {
        if (!confirm('Reset this scene?\n\nThe puppets you switched on and any text you retyped here go back to their defaults. Your uploaded images are kept.')) return;
        this.showcase.resetScene();
      });
      // Always on, with no switch: scene 1's opening line tells the visitor to click the
      // text and type, so a control that could turn that off only invites them to break
      // the invitation. The authoring panel still has its own toggle on localhost.
      this.setEditing(true);
    }
    this.$('#p-editing').addEventListener('click', () => this.setEditing(!this.edit.editing));
    this.$('#p-reset').addEventListener('click', () => {
      if (!confirm('Reset the stage?\n\nThis removes every object in this scene. It is not saved until you press "save scene", so you can still revert.')) return;
      this.player.resetScene();
      this.select(null);
      this.edit.markDirty();
      // resetScene() rebuilds the pool directly, bypassing decorate — so anything the
      // showcase contributed is gone until the next goto. Put it back now.
      this.showcase?.refresh();
      this.renderObjectList();
    });
    this.$('#p-save').addEventListener('click', () => this.edit.save());
    this.$('#p-revert').addEventListener('click', () => {
      if (!confirm('Revert this scene?\n\nEvery unsaved change since the last save is discarded.')) return;
      this.edit.revert();
    });
    this.$('#p-copy').addEventListener('click', () => this.edit.copyToClipboard());
    this.$('#p-prev').addEventListener('click', () => this.player.prev());
    this.$('#p-next').addEventListener('click', () => this.player.next());
    this.$('#p-add-type').addEventListener('change', (e) => {
      const type = e.target.value;
      e.target.value = '';
      if (!type) return;
      const obj = this.player.addObject(type);
      if (!obj) return;
      this.edit.markDirty();
      this.renderObjectList();
      this.select(obj.id);          // straight into the inspector, ready to adjust
    });
    this.$('#p-num').addEventListener('change', (e) => {
      this.player.goto(parseInt(e.target.value, 10) - 1);
    });
  }

  // Painted from the flag rather than from the button's own class, so the authoring
  // toggle still reads correctly when something else set the state — the showcase turns
  // editing on at mount without touching the button.
  setEditing(on) {
    this.edit.setEditing(on);
    const b = this.$('#p-editing');
    if (!b) return;
    b.classList.toggle('on', this.edit.editing);
    b.textContent = this.edit.editing ? 'on' : 'off';
  }

  onSceneChange(scene) {
    // Detector controls appear only when the capability is loaded AND the scene uses it —
    // a slider for something that is not running reads as broken (§9.5).
    const det = this.detector;
    const show = det && det.state === 'ready' && (det.enabled || det.manual);
    // Mic controls appear once the grant lands. Like the detector's, a slider for something
    // that is not running reads as broken (§9.5) — so it stays hidden until there is a
    // signal to tune against.
    if (this.mic) {
      const on = !!this.mic.ready;
      this.$('#p-mic-section').hidden = !on;
      if (on && !this._micWired) {
        this._micWired = true;
        this._syncMic = this.renderFields(this.$('#p-mic'), this.mic, () => this.mic.save());
        this._startMicMeter();
      }
    }

    this.$('#p-potato-section').hidden = !show;
    if (show && this._potatoFor !== det.state) {
      this._potatoFor = det.state;
      this.renderFields(this.$('#p-potato'), det);
    }

    this.$('#p-num').value = String(this.player.index + 1);
    this.$('#p-count').textContent = `/ ${this.player.length}`;
    // Toggles are per-scene, so the buttons have to be repainted from the new scene's
    // record — otherwise they show the previous scene's state, which is the same staleness
    // trap the inspector had.
    this.showcase?.paint();

    this.renderObjectList();
    // Keep the selection across a scene change if the object is still on stage —
    // otherwise adjusting one thing across several scenes means re-selecting it each
    // time, which is most of what authoring actually is.
    if (this.selectedId && !this.player.pool.live.has(this.selectedId)) this.select(null);
    else if (this.selectedId) this.renderInspector();

    this.$('#p-edit-section').hidden = !this.edit.available;
    this.$('#p-save-row').hidden = !this.edit.dirty;
  }

  // A level meter, because a threshold slider without one is guesswork — you cannot tell
  // whether your voice is clearing the line except by watching a puppet and inferring.
  // The bar is the RAW level on a fixed 0..0.35 scale (speech lives around 0.04–0.22), with
  // a tick marking where `quiet` sits, and it lights up while the puppets count you as
  // talking. Tune it by speaking normally and putting the tick just under the bar's floor.
  //
  // 12Hz on its own interval rather than in the render loop: this must not add work to a
  // frame, and a meter does not need 60 readings a second to be read by a human.
  _startMicMeter() {
    const bar = this.$('#p-mic-bar'), tick = this.$('#p-mic-floor');
    if (!bar) return;
    const SCALE = 0.35;                       // full width of the meter, in RMS
    clearInterval(this._micTimer);
    this._micTimer = setInterval(() => {
      if (this.el.hidden || this.$('#p-mic-section').hidden) return;
      const m = this.mic;
      bar.style.width = `${Math.min(100, (m.raw / SCALE) * 100)}%`;
      bar.classList.toggle('talking', m.level > 0);
      tick.style.left = `${Math.min(100, (m.floor / SCALE) * 100)}%`;
    }, 80);
  }

  renderObjectList() {
    const host = this.$('#p-objects');
    const objects = this.player.pool.objects.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    if (!objects.length) {
      host.innerHTML = '<span class="hint">(empty stage)</span>';
      return;
    }
    host.innerHTML = '';
    for (const obj of objects) {
      const row = document.createElement('div');
      row.className = `obj-row${obj.id === this.selectedId ? ' selected' : ''}`;
      row.innerHTML = `
        <button class="vis${obj.visible === false ? '' : ' on'}" type="button" title="show / hide">${obj.visible === false ? '' : '✓'}</button>
        <span class="name">${obj.id}</span>
        <span class="type">${obj.type}</span>
        <button class="remove" type="button" title="remove from this scene">−</button>`;
      row.querySelector('.vis').addEventListener('click', (e) => {
        obj.visible = obj.visible === false;
        e.target.classList.toggle('on', obj.visible);
        e.target.textContent = obj.visible ? '✓' : '';
        this.edit.markDirty();
      });
      row.querySelector('.name').addEventListener('click', () => this.select(obj.id));
      row.querySelector('.remove').addEventListener('click', () => {
        this.player.removeObject(obj.id);
        if (this.selectedId === obj.id) this.select(null);
        this.edit.markDirty();
        this.renderObjectList();
      });
      host.appendChild(row);
    }
  }

  select(id) {
    this.selectedId = id;
    this._inspectorFor = null;
    this.renderObjectList();
    this.renderInspector();
    this.flash(id ? this.player.pool.live.get(id) : null);
  }

  // A brief outline on stage around the object just picked in the on-stage list
  flash(obj) {
    const stage = obj?.deps?.stage;
    if (!stage?.el) return;
    const host = stage.el.getBoundingClientRect();
    let box = null;
    const el = obj._wrap ?? obj._el;            // page elements know their own rect
    if (el?.getBoundingClientRect && !el.hidden) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) box = { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height, rot: 0 };
    }
    if (!box) {
      let b = null;
      try { b = obj.bounds?.(stage) ?? obj._box?.(stage); } catch { /* not ready */ }
      const w = b?.w ?? 80, h = b?.h ?? 80, sc = obj.scale ?? 1;
      const at = obj._at ?? { x: obj.x ?? 0.5, y: obj.y ?? 0.5 };
      const cy = at.y * stage.h + ((b?.dy ?? -h / 2) + h / 2) * sc;
      box = { x: at.x * stage.w - (w * sc) / 2, y: cy - (h * sc) / 2, w: w * sc, h: h * sc, rot: obj.rotation ?? 0 };
    }
    this._flash?.remove();
    const mark = this._flash = document.createElement('div');
    mark.className = 'select-flash';
    Object.assign(mark.style, {
      left: `${box.x}px`, top: `${box.y}px`, width: `${Math.max(box.w, 8)}px`, height: `${Math.max(box.h, 8)}px`,
      transform: box.rot ? `rotate(${box.rot}deg)` : '',
    });
    mark.addEventListener('animationend', () => mark.remove());
    stage.el.appendChild(mark);
  }

  // A thumbnail of what the selected object is showing right now. Re-checked on every
  // inspector refresh, so cycling a series moves the picture along with it.
  renderPreview(obj) {
    const host = this.$('#p-preview');
    const ref = obj?.srcs?.length ? obj.srcs[obj.index ?? 0] : obj?.src;
    const url = ref != null && this.assets ? this.assets.src(ref) : null;
    const text = !url && obj?.type === 'text' ? String(obj.text ?? '').slice(0, 80) : '';
    const key = url ?? `t:${text}`;
    host.hidden = !url && !text;
    if (this._previewKey === key) return;
    this._previewKey = key;
    host.replaceChildren();
    if (url) {
      const isVideo = obj.type === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
      const el = document.createElement(isVideo ? 'video' : 'img');
      el.src = url;
      if (isVideo) { el.muted = true; el.preload = 'metadata'; }
      host.appendChild(el);
    } else if (text) host.textContent = `“${text}”`;
  }

  // The generic inspector. It knows nothing about what kind of object it is editing —
  // it reads `fields` off the instance. A new object type gets a full control surface
  // for free, which is the thing 2.5.0 could never do.
  renderInspector() {
    const section = this.$('#p-inspector-section');
    const host = this.$('#p-inspector');
    const obj = this.selectedId ? this.player.pool.live.get(this.selectedId) : null;
    if (!obj) { section.hidden = true; host.innerHTML = ''; return; }
    section.hidden = false;
    this.renderPreview(obj);
    this.$('#p-inspector-title').textContent = `${obj.id} · ${obj.type}`;

    // Rebuild only when the SELECTION changes, so dragging a slider never destroys the
    // element being dragged — but re-read the values every time, or stepping to another
    // scene leaves the whole inspector showing the previous scene's numbers.
    if (this._inspectorFor === obj.id) { this._syncInspector?.(); this.renderMeta(obj); return; }
    this._inspectorFor = obj.id;
    this._syncInspector = this.renderFields(host, obj, () => this.edit.markDirty());
    this.renderMeta(obj);
  }

  // The metadata editor for whatever art the selected image is currently showing. Keyed on
  // the SRC, not the object — cycling a series with ']' moves you to the next painting's
  // record without reselecting anything, which is the only way authoring a series is
  // bearable. Authoring-only: it writes to disk, so it is gated the same way saving is.
  renderMeta(obj) {
    const section = this.$('#p-meta-section');
    const src = obj?.type === 'image' ? obj.src : null;
    const n = this.edit.available && this.assets ? this.assets.numberFor(src) : null;
    if (n == null) {
      section.hidden = true;
      this._metaFor = null;
      return;
    }
    section.hidden = false;
    if (this._metaFor === n) { this._syncMeta?.(); return; }
    this._metaFor = n;
    this.$('#p-meta-title').textContent = `asset ${n} · metadata`;
    const adapter = metaAdapter(this.assets.ensureMeta(src), {
      src, assets: this.assets, tracking: this.tracking,
    });
    // Deliberately NOT edit.markDirty(): metadata is not scene state and the "save scene"
    // button would not write it. Its own save button is the only thing that persists it.
    this._syncMeta = this.renderFields(this.$('#p-meta'), adapter, () => {});
  }

  // The generic field renderer, driven by a `fields` array. Used for stage objects and for
  // instruments like the detector alike — writing a bespoke panel block per feature is
  // what 2.5.0 did, and it is why adding a capability there meant hand-writing HTML (§6).
  // Returns a `sync()` that re-reads every control's value off the object WITHOUT
  // rebuilding the DOM — needed because the same object stays selected across a scene
  // change, and a control still showing the previous scene's value is worse than no
  // control: a toggle reading "off" for something that is on inverts your next click.
  //
  // DROPDOWN WIDTH — how to keep a <select> inside the panel. Two separate things go wrong:
  //   1. The CLOSED control. A select's natural width is its longest option, and as a flex
  //      item it refuses to shrink below that, so it pokes out of the row. Give it
  //      `flex: 1 1 0; width: 0; min-width: 0` (css/base.css, `.panel-row select`): width 0
  //      discards the natural width and flex hands back exactly the room the row has.
  //   2. The OPEN list. That is a native OS menu — CSS cannot size it — and it is as wide
  //      as its longest option, starting at the control's left edge. The panel sits at the
  //      right of the screen, so one long name sends the menu off-screen. The only fix is
  //      SHORT OPTION TEXT: clip the label (~22 characters) and put the full name in the
  //      option's `title`. Optgroup labels count too.
  renderFields(host, obj, onChange = () => {}) {
    host.innerHTML = '';
    const syncs = [];
    for (const field of obj.fields ?? []) {
      const row = document.createElement('div');
      row.className = 'panel-row';
      const label = document.createElement('label');
      label.textContent = field.label ?? field.key;
      row.appendChild(label);

      // Booleans are a BUTTON, not a checkbox. xp.css paints a checkbox entirely through
      // pseudo-elements on a sibling label, positioned with hardcoded pixel offsets that
      // assume the label is laid out exactly as its demo does — any flex, font-size or
      // overflow in the surrounding row pulls the tick off the box.
      const isCheck = field.type === 'checkbox';
      let input;
      if (isCheck) {
        input = document.createElement('button');
        input.type = 'button';
        input.className = 'toggle';
        const paint = () => {
          const on = !!obj[field.key];
          input.textContent = on ? 'on' : 'off';
          input.classList.toggle('on', on);
          input.setAttribute('aria-pressed', String(on));
        };
        paint();
        syncs.push(paint);
        input.addEventListener('click', () => {
          obj[field.key] = !obj[field.key];
          paint();
          onChange();
        });
      } else if (field.type === 'select') {
        input = document.createElement('select');
        for (const opt of field.options) {
          const o = document.createElement('option');
          o.value = o.textContent = opt;
          input.appendChild(o);
        }
        input.value = obj[field.key] ?? field.options[0];
        syncs.push(() => { input.value = obj[field.key] ?? field.options[0]; });
      } else if (field.type === 'image') {
        // A text box for a number or path, plus an upload button when a showcase is
        // present to hold the art. This is why the toggle rows carry no upload buttons of
        // their own: click any image in the on-stage list and replace it here, whether it
        // is a toggle's puppet or something the script put there.
        input = document.createElement('input');
        input.type = 'text';
        input.value = obj[field.key] ?? '';
        syncs.push(() => { input.value = obj[field.key] ?? ''; });
        if (this.edit.available && !this.showcase?.ids.length) {
          // AUTHORING: a dropdown of every picture and video in the library — this show's
          // own folder first — instead of a box you type a number into. The last entry
          // uploads a new file into assets/<show>/ under the next free number and selects
          // it, so "save scene" keeps it. (A public showcase keeps a visitor's art in
          // their own browser instead; see below.)
          const NEW = '__new__';
          const file = document.createElement('input');
          file.type = 'file'; file.hidden = true; file.accept = 'image/*,video/*';
          const sel = document.createElement('select');
          sel.className = 'asset-select';
          const fill = () => {
            sel.replaceChildren(new Option('(none)', ''));
            const groups = new Map();
            for (const [n, f] of this.assets?.byNumber ?? []) {
              if (!/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov)$/i.test(f)) continue;
              const folder = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(top)';
              if (!groups.has(folder)) groups.set(folder, []);
              groups.get(folder).push([n, f.split('/').pop().replace(/^\d+[_-]*/, '').replace(/\.\w+$/, '')]);
            }
            const mine = this.edit.showName;
            const order = [...groups.keys()].sort((x, y) => (y === mine) - (x === mine) || x.localeCompare(y));
            for (const folder of order) {
              const g = document.createElement('optgroup');
              g.label = folder === mine ? `${folder} (this show)` : folder;
              for (const [n, name] of groups.get(folder).sort((x, y) => x[0] - y[0])) {
                // Clipped: see the DROPDOWN WIDTH note above renderFields.
                const o = new Option(`${n} · ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`, String(n));
                o.title = name;
                g.appendChild(o);
              }
              sel.appendChild(g);
            }
            sel.appendChild(new Option('+ add new…', NEW));
          };
          const show = () => {
            const v = obj[field.key] == null ? '' : String(obj[field.key]);
            // Something the library has no number for (a path, a visitor's upload): show it
            // as its own entry rather than silently reading "(none)".
            if (v && ![...sel.options].some((o) => o.value === v)) sel.insertBefore(new Option(v.length > 28 ? `${v.slice(0, 26)}…` : v, v), sel.options[1]);
            sel.value = v;
          };
          fill(); show();
          syncs.push(show);
          sel.addEventListener('change', () => {
            if (sel.value === NEW) { show(); file.click(); return; }
            setImage(obj, field.key, sel.value);
            onChange();
            this.renderPreview(obj);
          });
          file.addEventListener('change', async () => {
            const f = file.files?.[0]; file.value = '';
            if (!f) return;
            sel.disabled = true;
            try {
              const res = await fetch(`./api/shows/${encodeURIComponent(this.edit.showName)}/asset?name=${encodeURIComponent(f.name)}`, { method: 'PUT', body: f });
              if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
              const out = await res.json();
              this.assets?.register(out.number, out.file);
              setImage(obj, field.key, String(out.number));
              fill(); show();
              onChange();
              this.renderPreview(obj);
            } catch (err) {
              console.error('[panel] upload failed', err);
              sel.title = `upload failed: ${err.message ?? err}`;
              alert(`Upload failed.\n\n${err.message ?? err}\n\nIf the dev server was started before this feature was added, restart it.`);
            } finally { sel.disabled = false; }
          });
          row.append(sel, file);
          host.appendChild(row);
          continue;
        }
        if (this.showcase?.fileInput) {
          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'upload';
          pick.textContent = 'upload';
          pick.title = 'replace this with an image from your computer';
          pick.addEventListener('click', () => this.showcase.pickFor(obj.id));
          row.appendChild(input);
          row.appendChild(pick);
          input.addEventListener('change', () => { setImage(obj, field.key, input.value); onChange(); });
          host.appendChild(row);
          continue;
        }
      } else if (field.type === 'button') {
        // An ACTION rather than a value: it calls a method on the object instead of
        // writing a property, so a field list can offer "scan this" alongside the things
        // a scan produces. The label column is dropped rather than left empty — a button
        // that already says what it does does not also need naming, and the fixed 46px
        // label column would only push it off-centre.
        label.remove();
        input = document.createElement('button');
        input.type = 'button';
        input.className = 'action';
        input.textContent = field.text ?? field.label ?? field.key;
        if (field.title) input.title = field.title;
        input.addEventListener('click', async () => {
          input.disabled = true;
          const was = input.textContent;
          try {
            const msg = await obj[field.action ?? field.key]?.();
            if (msg) { input.textContent = msg; setTimeout(() => { input.textContent = was; }, 1600); }
          } finally {
            input.disabled = false;
          }
          onChange();
        });
        row.appendChild(input);
        host.appendChild(row);
        continue;
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = obj[field.key] ?? '';
        syncs.push(() => { input.value = obj[field.key] ?? ''; });
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : field.type === 'text' ? 'text' : 'range';
        if (input.type === 'range' || input.type === 'number') {
          input.min = field.min;
          input.max = field.max;
          input.step = field.step;
        }
        input.value = obj[field.key] ?? '';
        syncs.push(() => { input.value = obj[field.key] ?? ''; });
      }
      row.appendChild(input);

      let readout = null;
      if (field.type === 'range') {
        readout = document.createElement('span');
        readout.className = 'val';
        readout.textContent = fmt(obj[field.key]);
        row.appendChild(readout);
        syncs.push(() => { readout.textContent = fmt(obj[field.key]); });
      }

      if (!isCheck) {
        const commit = () => {
          const numeric = field.type === 'range' || field.type === 'number';
          if (field.type === 'image') setImage(obj, field.key, input.value);
          else if (field.key === 'fasten') { refasten(obj, input.value); for (const f of syncs) f(); }
          else obj[field.key] = numeric ? parseFloat(input.value) : input.value;
          if (readout) readout.textContent = fmt(obj[field.key]);
          onChange();
        };
        input.addEventListener('input', commit);
        input.addEventListener('change', commit);
      }
      host.appendChild(row);
    }
    return () => { for (const f of syncs) f(); };
  }

}

// A typed image source. "12" is asset NUMBER 12, not a file called 12, and the object
// only looks at `src` when a scene is applied — so it is told to load the new picture.
function setImage(obj, key, raw) {
  const v = String(raw).trim();
  obj[key] = v === '' ? null : /^\d+$/.test(v) ? parseInt(v, 10) : v;
  obj._load?.();
  // Art named for a mount ("001_beret_hat.png") pins itself to the head on load, and
  // that needs tracking the show may not have declared.
  if (obj.fasten) obj.deps?.tracking?.load?.(/Hand/.test(obj.fasten) ? 'hands' : 'face');
}

// Pinning or unpinning from the panel. `x`/`y` are a stage POSITION on a free object but
// an OFFSET from the pin on a fastened one, and an image's `size` is a share of the stage
// when free but a multiple of the hand when pinned. Changing only `fasten` would leave a
// centred picture half a stage away from your hand — off screen — at a third of its size.
// So crossing between the two resets them to that mode's defaults.
function refasten(obj, value) {
  const was = !!obj.fasten;
  obj.fasten = value || null;
  if (was !== !!obj.fasten) {
    obj.x = obj.y = obj.fasten ? 0 : 0.5;
    if (obj.type === 'image' || obj.type === 'video') obj.size = obj.fasten ? 1.1 : 0.5;
    obj._lastPin = null;
  }
  // Pinning needs tracking the show may never have declared (a no-op once loaded).
  if (obj.fasten) obj.deps?.tracking?.load?.(/Hand/.test(obj.fasten) ? 'hands' : 'face');
}

function fmt(v) {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v ?? '');
}
