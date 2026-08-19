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

  setEditing(on) {
    this.editing = !!on && this.available;
    document.body.classList.toggle('editing', this.editing);
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

  markDirty() { this._setDirty(true); }

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

    try {
      const res = await fetch(`./api/shows/${encodeURIComponent(this.showName)}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.player.script, null, 2),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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

export class Panel {
  constructor({ el, player, edit, tabLabel = null }) {
    this.el = el;
    this.player = player;
    this.edit = edit;
    this.tabLabel = tabLabel;   // omit → no tab at all (performance rigs)
    this.selectedId = null;
    this._inspectorFor = null;
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
          <div class="hint" id="p-note" hidden></div>
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
            </select>
          </div>
        </div>
        <div class="group" id="p-inspector-section" hidden>
          <b id="p-inspector-title">object</b>
          <div id="p-inspector"></div>
        </div>
        <div class="group" id="p-edit-section" hidden>
          <div class="panel-row">
            <label style="flex:1"><input type="checkbox" id="p-editing" /> edit text in place</label>
          </div>
          <div class="panel-row" style="gap:3px" id="p-save-row" hidden>
            <button id="p-save" type="button">save scene</button>
            <button id="p-revert" type="button">revert</button>
          </div>
          <div class="panel-row"><button id="p-copy" type="button">copy JSON</button></div>
        </div>
      </fieldset>`;

    this.$ = (id) => this.el.querySelector(id);

    this.edit.onDirtyChange = (dirty) => { this.$('#p-save-row').hidden = !dirty; };
    this.$('#p-editing').addEventListener('change', (e) => this.edit.setEditing(e.target.checked));
    this.$('#p-save').addEventListener('click', () => this.edit.save());
    this.$('#p-revert').addEventListener('click', () => this.edit.revert());
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

  onSceneChange(scene) {
    this.$('#p-num').value = String(this.player.index + 1);
    this.$('#p-count').textContent = `/ ${this.player.length}`;
    const note = this.$('#p-note');
    note.textContent = scene?._note ?? '';
    note.hidden = !scene?._note;

    this.renderObjectList();
    // Keep the selection across a scene change if the object is still on stage —
    // otherwise adjusting one thing across several scenes means re-selecting it each
    // time, which is most of what authoring actually is.
    if (this.selectedId && !this.player.pool.live.has(this.selectedId)) this.select(null);
    else if (this.selectedId) this.renderInspector();

    this.$('#p-edit-section').hidden = !this.edit.available;
    this.$('#p-save-row').hidden = !this.edit.dirty;
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
        <input type="checkbox" ${obj.visible === false ? '' : 'checked'} title="visible" />
        <span class="name">${obj.id}</span>
        <span class="type">${obj.type}</span>
        <button class="remove" type="button" title="remove from this scene">−</button>`;
      row.querySelector('input').addEventListener('change', (e) => {
        obj.visible = e.target.checked;
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
    this.$('#p-inspector-title').textContent = `${obj.id} · ${obj.type}`;

    // Rebuild only when the selection changes, so dragging a slider doesn't destroy
    // the element being dragged.
    if (this._inspectorFor === obj.id) return;
    this._inspectorFor = obj.id;
    host.innerHTML = '';

    for (const field of obj.fields ?? []) {
      const row = document.createElement('div');
      row.className = 'panel-row';
      const label = document.createElement('label');
      label.textContent = field.label ?? field.key;
      row.appendChild(label);

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const opt of field.options) {
          const o = document.createElement('option');
          o.value = o.textContent = opt;
          input.appendChild(o);
        }
        input.value = obj[field.key] ?? field.options[0];
      } else if (field.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!obj[field.key];
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = obj[field.key] ?? '';
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : field.type === 'text' ? 'text' : 'range';
        if (input.type === 'range' || input.type === 'number') {
          input.min = field.min;
          input.max = field.max;
          input.step = field.step;
        }
        input.value = obj[field.key] ?? '';
      }
      row.appendChild(input);

      let readout = null;
      if (field.type === 'range') {
        readout = document.createElement('span');
        readout.className = 'val';
        readout.textContent = fmt(obj[field.key]);
        row.appendChild(readout);
      }

      const commit = () => {
        const numeric = field.type === 'range' || field.type === 'number';
        obj[field.key] = field.type === 'checkbox' ? input.checked
          : numeric ? parseFloat(input.value) : input.value;
        if (readout) readout.textContent = fmt(obj[field.key]);
        this.edit.markDirty();
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
      host.appendChild(row);
    }
  }

}

function fmt(v) {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v ?? '');
}
