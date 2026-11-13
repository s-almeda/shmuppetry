// ── Slide editor ──────────────────────────────────────────────────────────
// editor.html?show=<name>. The whole show in a timeline on the left — runs of puppet
// scenes collapsed into one box, slides one per row — the REAL stage in the middle, and
// an inspector on the right. Objects are dragged on the stage; everything else is the
// panel's generic field renderer reading each object's own `fields`.
//
// The player, renderer and objects are the rig's own: nothing here draws a slide, it
// only moves things and writes the script back. Saves go through the dev server's
// whole-script route, so this is local-only like the panel's save button.

import { Stage, Renderer } from './stage.js';
import { AssetLibrary } from './assets.js';
import { Player } from './scene.js';
import { Panel, EditMode } from './panel.js';
import { TYPES } from './objects.js';
import { EFFECTS, DIRS } from './builds.js';

const params = new URLSearchParams(location.search);
const showName = params.get('show') || 'demo';
document.title = `editor — ${showName}`;
const $ = (id) => document.getElementById(id);

const loadJSON = async (url, fallback = null) => {
  try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : fallback; }
  catch { return fallback; }
};

const SHAPES = {
  line: { type: 'shape', path: 'M 0 0.5 L 1 0.5', size: 0.02, aspect: 15, stroke: '#222222', strokeWidth: 0.006 },
  arrow: { type: 'shape', path: 'M 0 0.5 L 1 0.5', size: 0.02, aspect: 15, stroke: '#222222', strokeWidth: 0.006, arrowEnd: true },
  rect: { type: 'shape', path: 'M 0 0 H 1 V 1 H 0 Z', size: 0.3, aspect: 1.5, stroke: '#222222', strokeWidth: 0.005, fill: null },
  ellipse: { type: 'shape', path: 'M 0.5 0 C 0.776 0, 1 0.224, 1 0.5 C 1 0.776, 0.776 1, 0.5 1 C 0.224 1, 0 0.776, 0 0.5 C 0 0.224, 0.224 0, 0.5 0 Z', size: 0.3, aspect: 1, stroke: '#222222', strokeWidth: 0.005, fill: null },
};

async function main() {
  const config = await loadJSON(`./shows/${showName}/config.json`, {});
  const script = await loadJSON(`./shows/${showName}/script.json`);
  if (!script) { $('status').textContent = `couldn't load shows/${showName}/script.json`; return; }
  const [manifest, meta] = await Promise.all([loadJSON('./assets/manifest.json'), loadJSON('./assets/meta.json', {})]);
  const assets = new AssetLibrary(manifest, meta);
  $('rail-title').textContent = config.title ?? showName;

  // ── Stage ───────────────────────────────────────────────────────────────
  const el = { stage: $('stage'), canvas: $('stage-canvas'), domLayer: $('dom-layer'), overlay: $('overlay'), wrap: $('stage-wrap') };
  const aspect = config.aspect || 16 / 9;
  const fit = () => {
    const w = el.wrap.clientWidth - 24, h = el.wrap.clientHeight - 24;
    const W = Math.min(w, h * aspect), H = W / aspect;
    el.stage.style.width = `${Math.floor(W)}px`; el.stage.style.height = `${Math.floor(H)}px`;
  };
  fit(); window.addEventListener('resize', fit);
  new ResizeObserver(fit).observe(el.wrap);
  const stage = new Stage({ el: el.stage, canvas: el.canvas, mirror: config.mirror !== false });
  const renderer = new Renderer(stage);

  const edit = new EditMode({ showName, banner: document.createElement('div') });
  const deps = { stage, assets, renderer, paper: config.paper ?? {}, domLayer: el.domLayer, edit, camera: null, tracking: null };
  const domDeps = Object.create(deps);
  domDeps.dom = true;
  const make = (spec, opts) => {
    const Type = TYPES[spec.type];
    if (!Type) { console.warn(`[editor] unknown object type "${spec.type}" (${spec.id})`); return null; }
    // Slide objects get the same deps with `dom: true` (objects.js placeBox). A prototype
    // rather than a copy, so `find`, `list` and `tweens`, wired up later, still reach them.
    return new Type(spec, opts?.dom ? domDeps : deps);
  };
  const player = new Player({ make, renderer, stage, domLayer: el.domLayer, bodyBase: document.body.className,
    onSceneChange: () => { renderScenePanel(); renderRail(); } });
  deps.find = (id) => player.pool.live.get(id);
  deps.list = () => player.pool.objects;
  deps.tweens = player.tweens;
  edit.player = player;
  edit.available = await edit.probe();
  player.load(script);
  renderer.beforeFrame = (now) => player.tick(now);
  renderer.start();

  // ── State ───────────────────────────────────────────────────────────────
  let dirty = false;
  let selected = null;        // object id
  const setDirty = (v) => {
    dirty = v; $('save').disabled = !v || !edit.available; $('save').classList.toggle('dirty', v);
    if (v) history.touch();
  };

  // ── Undo ────────────────────────────────────────────────────────────────
  // Snapshots of the whole script, taken once an edit SETTLES (a slider drag or a run of
  // arrow-key nudges is one step, not forty). Whole-script rather than per-operation
  // because every edit path — fields, drags, builds, layers, timeline — ends up in the
  // script, so one mechanism covers them all with nothing to forget when adding a control.
  const history = {
    past: [], future: [], timer: null, restoring: false,
    // A snapshot is the script as a string (0.2ms for the largest show) plus where you
    // were. Comparing strings is how a no-op edit is kept out of the history.
    snap() { return { script: JSON.stringify(player.script), index: player.index, selected }; },
    // Record now: called once things have settled, and before an undo so nothing pending is lost.
    flush() {
      clearTimeout(this.timer); this.timer = null;
      if (this.restoring || previewing) return;
      commitLive();
      const s = this.snap();
      if (this.past.at(-1)?.script === s.script) return;
      this.past.push(s);
      if (this.past.length > 100) this.past.shift();
      this.future = [];
      this.buttons();
    },
    touch() { if (this.restoring) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 350); },
    undo() {
      this.flush();
      if (this.past.length < 2) return;
      this.future.push(this.past.pop());
      this.restore(this.past.at(-1));
    },
    redo() {
      this.flush();
      const s = this.future.pop();
      if (!s) return;
      this.past.push(s);
      this.restore(s);
    },
    restore(st) {
      this.restoring = true;
      endPreview();
      player.script.splice(0, player.script.length, ...JSON.parse(st.script));
      player.reresolve();
      player.goto(Math.min(st.index, player.script.length - 1), { instant: true });
      player.builds.revealAll();
      selected = st.selected && player.pool.live.has(st.selected) ? st.selected : null;
      setDirty(true);
      this.restoring = false;
      renderObjectPanel(); renderBuildOrder(); renderRail();
      thumbs.clear(); refreshThumbs(true);
      this.buttons();
    },
    buttons() { $('undo').disabled = this.past.length < 2; $('redo').disabled = !this.future.length; },
  };
  const status = (msg) => { $('status').textContent = msg; };
  if (!edit.available) status('no dev server — run `node server/dev-server.js` to save');

  const cur = () => player.script[player.index];
  const isSlide = (s) => !!s?.slide;

  // Push the live stage back into the authored script. Slides are written absolute
  // (`reset: true` plus every object), so a slide never inherits from the scene before it
  // and reordering the timeline cannot change what it shows.
  const commitLive = () => {
    const i = player.index;
    if (i < 0 || !isSlide(player.script[i]) || previewing) return;   // mid-animation values are not the slide
    const objects = player.pool.serialize();
    for (const o of Object.values(objects)) { delete o.fasten; }   // slides never fasten
    player.script[i] = { ...player.script[i], reset: true, objects };
    player.reresolve();
  };

  // ── Edit view vs preview ────────────────────────────────────────────────
  // Editing shows EVERY object on the slide — ones that build in later and ones that
  // build out — because you can't place what you can't see. Preview plays the slide as the
  // audience gets it: the transition in, then Space steps the builds.
  let previewing = false;
  const endPreview = () => {
    if (!previewing) return;
    previewing = false;
    document.body.classList.remove('previewing');
    player.builds.revealAll();
    status('');
  };
  const startPreview = () => {
    endPreview();
    commitLive();
    const i = player.index;
    if (i > 0) player.goto(i - 1, { instant: true });
    player.goto(i);
    previewing = true;
    document.body.classList.add('previewing');
    status(player.builds.total ? `preview · Space plays builds (0/${player.builds.total}) · Esc to edit` : 'preview · Esc to edit');
  };

  const gotoScene = (i, opts = {}) => {
    endPreview();
    commitLive();
    player.goto(i, { instant: true, ...opts });
    player.builds.revealAll();
    selected = null;
    renderObjectPanel();
    renderBuildOrder();
    history.replaceState(null, '', `?show=${encodeURIComponent(showName)}&scene=${player.index + 1}`);
    $('open-rig').href = `./index.html?show=${encodeURIComponent(showName)}&scene=${player.index + 1}&nocam`;
  };

  // ── Timeline thumbnails ─────────────────────────────────────────────────
  // Each slide is drawn OFFSCREEN from its resolved stage with every build played, so
  // every row has a picture without visiting it. Canvas objects draw themselves with
  // their own render(); text is DOM in the real stage, so here it is painted with
  // fillText, which is close enough to recognise a slide by. Videos are a dark frame —
  // constructing one would pause or seek the shared <video> the stage is playing.
  const thumbs = new Map();       // scene index → dataURL
  const TW = 240, TH = Math.round(TW / aspect);
  const thumbDeps = { ...deps, domLayer: document.createElement('div'), tweens: null, edit: null };
  const thumbMake = (spec) => (TYPES[spec.type] ? new TYPES[spec.type](spec, thumbDeps) : null);
  const drawThumb = (i) => {
    const scene = player.resolved[i];
    if (!scene?.slide) return true;
    const c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, TW, TH);
    const fake = { w: TW, h: TH, dpr: 1, aspect, canvas: c, drawVideoInto() { return false; } };
    let complete = true;
    const specs = Object.entries(scene.objects).map(([id, o]) => ({ id, ...o }))
      .filter((o) => o.visible !== false && !o.isMask).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    for (const spec of specs) {
      try {
        if (spec.type === 'text') { paintText(g, spec, fake); continue; }
        if (spec.type === 'video' || spec.type === 'webcam') {
          const h = (spec.size ?? 0.4) * TH, w = h * 16 / 9;
          g.fillStyle = '#333'; g.fillRect(spec.x * TW - w / 2, spec.y * TH - h / 2, w, h);
          continue;
        }
        const o = thumbMake(spec);
        if (!o?.draw) continue;
        if (spec.type === 'image' && !(o.el && (o.el.complete || o.el.readyState >= 2) && (o.el.naturalWidth || o.el.videoWidth))) complete = false;
        o.draw(g, fake, 0);
        o.dispose?.();
      } catch (err) { console.warn('[editor] thumb', i, spec.id, err); }
    }
    thumbs.set(i, c.toDataURL('image/jpeg', 0.7));
    const img = $('timeline').querySelector(`li[data-index="${i}"] img.thumb`);
    if (img) { img.src = thumbs.get(i); img.hidden = false; }
    return complete;
  };
  // Images decode asynchronously, so keep redrawing the ones that were missing art until
  // everything has landed (or a minute has passed — a broken file must not loop forever).
  let pendingThumbs = new Set();
  const refreshThumbs = (all = false) => {
    const todo = all ? player.resolved.map((_, i) => i) : [...pendingThumbs];
    pendingThumbs = new Set();
    for (const i of todo) if (!drawThumb(i)) pendingThumbs.add(i);
  };
  const thumbStart = performance.now();
  setInterval(() => {
    if (pendingThumbs.size && performance.now() - thumbStart < 60000) refreshThumbs();
    // The slide on stage may have been edited: keep its own thumbnail current.
    if (dirty && !previewing && player.index >= 0) { commitLive(); drawThumb(player.index); }
  }, 1000);

  function renderRail() {
    const ol = $('timeline');
    ol.innerHTML = '';
    const scenes = player.script;
    let i = 0;
    while (i < scenes.length) {
      if (!isSlide(scenes[i])) {
        // Collapse the run of puppet scenes into one box.
        let j = i;
        while (j < scenes.length && !isSlide(scenes[j])) j++;
        const li = document.createElement('li');
        li.className = 'puppet' + (player.index >= i && player.index < j ? ' current' : '');
        li.dataset.index = String(i);
        const ids = `${scenes[i].id ?? i + 1}–${scenes[j - 1].id ?? j}`;
        li.innerHTML = `<span class="n">${i + 1}</span><span class="t">puppet scenes ${ids}</span>` +
          `<span class="sub">${j - i} scene${j - i === 1 ? '' : 's'} · edited in the rig</span>`;
        // Capture this row's own bounds: `i` is the loop counter shared by every row, so a
        // handler reading it at click time sees the value after the loop has finished.
        const from = i, to = j;
        li.addEventListener('click', () => gotoScene(player.index >= from && player.index < to ? player.index : from));
        ol.appendChild(li);
        i = j;
        continue;
      }
      const s = scenes[i];
      const li = document.createElement('li');
      li.className = player.index === i ? 'current' : '';
      li.dataset.index = String(i);
      const texts = Object.values(s.objects ?? {}).filter((o) => o?.type === 'text' && o.text).map((o) => o.text.replace(/\s+/g, ' '));
      const t = s.transition ? `${s.transition.effect}${s.transition.dir ? ' ' + s.transition.dir : ''}` : '';
      li.innerHTML = `<span class="n">${i + 1}</span><span class="t">${esc(s._note ?? `slide ${s.id ?? i + 1}`)}</span>` +
        (t ? `<span class="trans">↓ ${esc(t)}</span>` : '') +
        `<img class="thumb" alt=""${thumbs.has(i) ? ` src="${thumbs.get(i)}"` : ' hidden'} />` +
        `<span class="sub">${esc(texts.slice(0, 2).join(' · ') || Object.keys(s.objects ?? {}).join(', '))}</span>`;
      const at = i;
      li.addEventListener('click', () => gotoScene(at));
      ol.appendChild(li);
      i++;
    }
    ol.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
  }

  const nextId = () => Math.max(0, ...player.script.map((s) => s.id ?? 0)) + 1;
  const mutate = (fn) => {
    commitLive();
    const i = fn();
    player.reresolve();
    setDirty(true);
    player.goto(Math.max(0, Math.min(i, player.script.length - 1)), { instant: true });
    player.builds.revealAll();
    selected = null; renderObjectPanel(); renderBuildOrder();
    thumbs.clear(); renderRail(); refreshThumbs(true);   // indices shifted
  };
  $('add-slide').addEventListener('click', () => mutate(() => {
    const i = player.index;
    const bg = player.script[i]?.objects?.bg;
    const scene = { id: nextId(), reset: true, slide: true, _note: 'new slide', objects: bg ? { bg: JSON.parse(JSON.stringify(bg)) } : {} };
    player.script.splice(i + 1, 0, scene);
    return i + 1;
  }));
  const dup = () => mutate(() => {
    const i = player.index;
    const copy = JSON.parse(JSON.stringify(player.script[i]));
    copy.id = nextId();
    if (isSlide(copy) && !copy.transition) copy.transition = { effect: 'magicMove', dur: 0.7 };
    player.script.splice(i + 1, 0, copy);
    return i + 1;
  });
  $('dup-slide').addEventListener('click', dup);
  $('del-scene').addEventListener('click', () => {
    if (player.script.length <= 1 || !confirm('delete this scene?')) return;
    mutate(() => { const i = player.index; player.script.splice(i, 1); return i; });
  });
  const move = (by) => mutate(() => {
    const i = player.index, j = i + by;
    if (j < 0 || j >= player.script.length) return i;
    [player.script[i], player.script[j]] = [player.script[j], player.script[i]];
    return j;
  });
  $('up').addEventListener('click', () => move(-1));
  $('down').addEventListener('click', () => move(1));

  // ── Save ────────────────────────────────────────────────────────────────
  const save = async () => {
    commitLive();
    if (!edit.available) return;
    try {
      const res = await fetch(`./api/shows/${encodeURIComponent(showName)}/script`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(player.script, null, 2),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setDirty(false); status(`saved ${player.script.length} scenes`);
    } catch (err) { console.error('[editor] save failed', err); status('save failed — see console'); }
  };
  $('save').addEventListener('click', save);

  // ── Scene panel ─────────────────────────────────────────────────────────
  const dirSel = (sel) => { sel.innerHTML = ''; for (const d of Object.keys(DIRS)) { const o = document.createElement('option'); o.value = o.textContent = d; sel.appendChild(o); } };
  dirSel($('s-tdir'));
  function renderScenePanel() {
    const s = cur(); if (!s) return;
    $('scene-title').textContent = `scene ${player.index + 1} · id ${s.id}`;
    $('s-slide').textContent = isSlide(s) ? 'on' : 'off'; $('s-slide').classList.toggle('on', isSlide(s));
    $('s-note').value = s._note ?? '';
    $('s-teffect').value = s.transition?.effect ?? '';
    $('s-tdir').value = s.transition?.dir ?? 'right';
    $('s-tdur').value = s.transition?.dur ?? '';
    $('s-tdir').disabled = !['wipe', 'move', 'push'].includes(s.transition?.effect);
    $('add-slide').disabled = false;
    $('dup-slide').disabled = !isSlide(s);
  }
  const sceneEdit = (fn) => { fn(cur()); player.reresolve(); setDirty(true); renderScenePanel(); renderRail(); };
  $('s-slide').addEventListener('click', () => sceneEdit((s) => { s.slide = !s.slide; if (s.slide) s.reset = true; }));
  $('s-note').addEventListener('change', () => sceneEdit((s) => { s._note = $('s-note').value || undefined; }));
  const tEdit = () => sceneEdit((s) => {
    const eff = $('s-teffect').value;
    if (!eff) { delete s.transition; return; }
    s.transition = { effect: eff, dur: parseFloat($('s-tdur').value) || undefined };
    if (['wipe', 'move', 'push'].includes(eff)) s.transition.dir = $('s-tdir').value;
    if (!s.transition.dur) delete s.transition.dur;
  });
  $('s-teffect').addEventListener('change', tEdit); $('s-tdir').addEventListener('change', tEdit); $('s-tdur').addEventListener('change', tEdit);
  $('preview').addEventListener('click', () => (previewing ? endPreview() : startPreview()));

  // ── Object panel ────────────────────────────────────────────────────────
  const fieldCtx = { showcase: null };   // Panel.renderFields reads only this off `this`
  const renderFields = Panel.prototype.renderFields.bind(fieldCtx);
  let syncFields = null;
  function renderObjectPanel() {
    const obj = selected ? player.pool.live.get(selected) : null;
    $('object-section').hidden = !obj;
    if (!obj) return;
    $('object-title').textContent = `${obj.type}`;
    $('o-id').value = obj.id;
    for (const host of document.querySelectorAll('.rows.build')) renderBuild(host, obj, host.dataset.kind);
    syncFields = renderFields($('fields'), obj, () => { setDirty(true); renderer.setObjects(player.pool.objects); renderLayers(); });
  }
  function renderBuild(host, obj, kind) {
    host.innerHTML = '';
    const b = obj[kind] ?? null;
    const row = (label, input) => { const r = document.createElement('div'); r.className = 'panel-row'; const l = document.createElement('label'); l.textContent = label; r.append(l, input); host.appendChild(r); return input; };
    const eff = document.createElement('select');
    for (const e of ['', ...Object.keys(EFFECTS)]) { const o = document.createElement('option'); o.value = e; o.textContent = e || '(none)'; eff.appendChild(o); }
    eff.value = b?.effect ?? '';
    const dir = document.createElement('select'); dirSel(dir); dir.value = b?.dir ?? (b?.effect === 'fadeMove' ? 'up' : 'right');
    const dur = document.createElement('input'); dur.type = 'number'; dur.min = 0; dur.max = 5; dur.step = 0.1; dur.value = b?.dur ?? 0.5;
    const step = document.createElement('input'); step.type = 'number'; step.min = 0; step.max = 99; step.step = 1;
    step.value = b?.step ?? nextStep();
    step.title = 'which click plays this — 0 = as the slide arrives';
    const delay = document.createElement('input'); delay.type = 'number'; delay.min = 0; delay.max = 30; delay.step = 0.1; delay.value = b?.delay ?? 0;
    delay.title = 'seconds after its click before it starts — sequences builds within one click';
    row('effect', eff); row('direction', dir); row('seconds', dur); row('step', step); row('delay', delay);
    const apply = () => {
      if (!eff.value) { delete obj[kind]; }
      else {
        const st = parseInt(step.value, 10);
        obj[kind] = { effect: eff.value, dur: parseFloat(dur.value) || 0.5, step: Number.isFinite(st) ? Math.max(0, st) : nextStep() };
        if (['wipe', 'move', 'fadeMove'].includes(eff.value)) obj[kind].dir = dir.value;
        const d = parseFloat(delay.value);
        if (d > 0) obj[kind].delay = d;
      }
      dir.disabled = !['wipe', 'move', 'fadeMove'].includes(eff.value);
      setDirty(true);
      renderBuildOrder();
    };
    dir.disabled = !['wipe', 'move', 'fadeMove'].includes(eff.value);
    for (const i of [eff, dir, dur, step, delay]) i.addEventListener('change', apply);
  }
  // ── Build order ─────────────────────────────────────────────────────────
  // Every build on the slide in play order. Steps are click numbers; ▲ ▼ move a build one
  // click earlier or later, and the numbering is compacted afterwards so it always reads
  // 1, 2, 3 (with 0 kept for builds that play on arrival).
  const buildsOnSlide = () => {
    const out = [];
    for (const o of player.pool.objects) for (const kind of ['in', 'out']) if (o[kind]) out.push({ o, kind, b: o[kind] });
    return out.sort((a, b) => (a.b.step ?? 1) - (b.b.step ?? 1) || (a.b.delay ?? 0) - (b.b.delay ?? 0) || (a.kind === 'in' ? -1 : 1));
  };
  const nextStep = () => Math.max(0, ...buildsOnSlide().map((x) => x.b.step ?? 1)) + 1;
  const compactSteps = () => {
    const items = buildsOnSlide();
    // 0 stays 0 (plays on arrival); every other step is renumbered 1, 2, 3… in order.
    const clicks = [...new Set(items.map((x) => x.b.step ?? 1).filter((st) => st > 0))].sort((a, b) => a - b);
    const map = new Map(clicks.map((st, n) => [st, n + 1]));
    for (const x of items) x.b.step = (x.b.step ?? 1) > 0 ? map.get(x.b.step ?? 1) : 0;
  };
  const describe = (o) => (o.type === 'text' ? `“${String(o.text).replace(/\s+/g, ' ').slice(0, 28)}”` : `${o.type} ${o.id}`);
  // ── Layers ──────────────────────────────────────────────────────────────
  // Top-first list of the slide's objects by z. Moving a layer rewrites z as 1, 2, 3… in
  // list order, so the list and the z field in the inspector are the same thing. The
  // background stays pinned at the bottom.
  const layerObjs = () => player.pool.objects.filter((o) => o.id !== 'bg')
    .sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || String(a.id).localeCompare(String(b.id)));
  const restack = (ordered) => {   // ordered: top first
    const n = ordered.length;
    ordered.forEach((o, k) => { o.z = n - k; });
    renderer.setObjects(player.pool.objects);
    setDirty(true); syncFields?.(); renderLayers();
  };
  const moveLayer = (o, how) => {
    const list = layerObjs();
    const i = list.indexOf(o);
    if (i < 0) return;
    list.splice(i, 1);
    const j = how === 'front' ? 0 : how === 'back' ? list.length : Math.max(0, Math.min(list.length, i + (how === 'up' ? -1 : 1)));
    list.splice(j, 0, o);
    restack(list);
  };
  function renderLayers() {
    const ol = $('layers');
    ol.innerHTML = '';
    if (!isSlide(cur())) return;
    for (const o of layerObjs()) {
      const li = document.createElement('li');
      if (o.id === selected) li.classList.add('sel');
      if (o.type === 'text') li.classList.add('dom');
      li.innerHTML = `<span class="what">${esc(describe(o))} <small>z ${Math.round(o.z ?? 0)}</small></span>` +
        `<span class="ctl"><button type="button" data-m="up" title="bring forward">▲</button><button type="button" data-m="down" title="send backward">▼</button></span>`;
      li.addEventListener('click', (e) => {
        const m = e.target.dataset?.m;
        if (m) { e.stopPropagation(); moveLayer(o, m); return; }
        selected = o.id; renderObjectPanel(); renderBuildOrder();
      });
      ol.appendChild(li);
    }
    if (player.pool.live.has('bg')) {
      const li = document.createElement('li'); li.className = 'fixed';
      li.innerHTML = '<span class="what">background</span><span></span>';
      ol.appendChild(li);
    }
  }

  function renderBuildOrder() {
    renderLayers();
    const ol = $('build-order');
    ol.innerHTML = '';
    const items = buildsOnSlide();
    if (!items.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = isSlide(cur()) ? 'no builds — select an object and give it a build in' : 'puppet scene';
      ol.appendChild(li); return;
    }
    let last = null;
    for (const x of items) {
      const li = document.createElement('li');
      const st = x.b.step ?? 1;
      if (st !== last) li.classList.add('step-start');
      if (x.o.id === selected) li.classList.add('sel');
      li.innerHTML = `<span class="step">${st !== last ? (st === 0 ? 'auto' : st) : ''}</span>` +
        `<span class="what">${x.kind === 'out' ? '⇥ ' : ''}${esc(x.b.effect)}${x.b.dir ? ' ' + esc(x.b.dir) : ''}${x.b.delay ? ` +${x.b.delay}s` : ''} <small>${esc(describe(x.o))}</small></span>` +
        `<span class="ctl"><button type="button" data-d="-1" title="one click earlier">▲</button><button type="button" data-d="1" title="one click later">▼</button></span>`;
      last = st;
      li.addEventListener('click', (e) => {
        const d = e.target.dataset?.d;
        if (d) {
          e.stopPropagation();
          x.b.step = Math.max(0, st + Number(d));
          // Moving into a step that another build already owns joins it; moving past the
          // end opens a new one. Compaction closes any gap that leaves behind.
          compactSteps(); setDirty(true); renderBuildOrder(); renderObjectPanel();
          return;
        }
        selected = x.o.id; renderObjectPanel(); renderBuildOrder();
      });
      ol.appendChild(li);
    }
  }

  // Renaming the id is how you link an object for Magic Move: same id on the next slide.
  $('o-id').addEventListener('change', () => {
    const obj = selected && player.pool.live.get(selected);
    const id = $('o-id').value.trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!obj || !id || id === obj.id || player.pool.live.has(id)) { if (obj) $('o-id').value = obj.id; return; }
    player.pool.live.delete(obj.id); obj.id = id; player.pool.live.set(id, obj);
    selected = id; setDirty(true); renderObjectPanel();
  });

  // ── Add objects ─────────────────────────────────────────────────────────
  const pick = $('asset-pick');
  for (const [n, file] of [...assets.byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    const o = document.createElement('option'); o.value = String(n); o.textContent = `${n} · ${file}`; pick.appendChild(o);
  }
  const addObject = (kind) => {
    if (!isSlide(cur())) { status('puppet scenes are edited in the rig'); return; }
    let spec;
    if (kind === 'text') spec = { type: 'text', style: 'slide', instant: true, text: 'text', font: 'Helvetica Neue', size: 0.06, color: '#222222', align: 'center', valign: 'middle', x: 0.5, y: 0.5, width: 0.5 };
    else if (kind === 'image' || kind === 'video') {
      const n = parseInt(pick.value, 10);
      if (!n) { status('pick an asset first'); return; }
      spec = { type: kind, src: n, fasten: null, x: 0.5, y: 0.5, size: 0.4, ...(kind === 'video' ? { play: 'auto', loop: true } : {}) };
    } else spec = { ...SHAPES[kind], x: 0.5, y: 0.5, fasten: null };
    spec.z = Math.max(0, ...player.pool.objects.map((o) => o.z ?? 0)) + 1;
    const obj = player.pool.add({ id: kind, ...spec });
    if (!obj) return;
    renderer.setObjects(player.pool.objects);
    selected = obj.id; setDirty(true); renderObjectPanel(); renderBuildOrder();
  };
  for (const b of document.querySelectorAll('#toolbar [data-add]')) b.addEventListener('click', () => addObject(b.dataset.add));

  // ── Hit testing & dragging ──────────────────────────────────────────────
  // Canvas objects report their box via bounds(); text boxes are DOM, so their element
  // rect is the box. Both land in stage px.
  const boxOf = (o) => {
    if (o.type === 'text') {
      const r = o._el?.getBoundingClientRect(), s = el.stage.getBoundingClientRect();
      if (!r || o._el.hidden) return null;
      return { cx: r.left - s.left + r.width / 2, cy: r.top - s.top + r.height / 2, w: r.width, h: r.height, rot: 0 };
    }
    const b = o.bounds?.(stage); if (!b) return null;
    const sc = o.scale ?? 1;
    return { cx: o.x * stage.w, cy: o.y * stage.h + (b.dy + b.h / 2) * sc, w: b.w * sc, h: b.h * sc, rot: ((o.rotation ?? 0) * Math.PI) / 180 };
  };
  const hit = (px, py) => {
    const list = player.pool.objects.filter((o) => o.visible !== false && !o._hidden && o.id !== 'bg')
      .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
    for (const o of list) {
      const b = boxOf(o); if (!b) continue;
      const dx = px - b.cx, dy = py - b.cy;
      const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (Math.abs(lx) <= Math.max(b.w, 12) / 2 && Math.abs(ly) <= Math.max(b.h, 12) / 2) return o;
    }
    return null;
  };
  const HANDLE = 9;
  const handleAt = (px, py) => {
    const o = selected && player.pool.live.get(selected); if (!o) return null;
    const b = boxOf(o); if (!b) return null;
    const corners = { se: [b.cx + b.w / 2, b.cy + b.h / 2] };
    if (o.type === 'text') corners.e = [b.cx + b.w / 2, b.cy];
    for (const [k, [x, y]] of Object.entries(corners)) if (Math.abs(px - x) <= HANDLE && Math.abs(py - y) <= HANDLE) return k;
    return null;
  };
  let drag = null;
  const pos = (e) => { const r = el.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  el.stage.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('editing')) return;
    if (!isSlide(cur())) return;
    const [px, py] = pos(e);
    const h = handleAt(px, py);
    const o = h ? player.pool.live.get(selected) : hit(px, py);
    endPreview();
    selected = o?.id ?? null;
    renderObjectPanel(); renderBuildOrder();
    if (!o) return;
    const b = boxOf(o);
    drag = { o, h, px, py, x: o.x, y: o.y, size: o.size, width: o.width, w: b?.w ?? 1, h0: b?.h ?? 1 };
    el.stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [px, py] = pos(e);
    const { o } = drag;
    if (drag.h === 'se') {
      // Scale about the box: the handle's distance from the centre, relative to where it was.
      const k = Math.max(0.05, (drag.h0 + (py - drag.py) * 2) / drag.h0);
      if (o.type === 'text') { o.size = Math.max(0.005, (drag.size ?? 0.05) * k); o.width = Math.max(0.03, (drag.width ?? 0.5) * ((drag.w + (px - drag.px) * 2) / drag.w)); }
      else o.size = Math.max(0.01, (drag.size ?? 0.3) * k);
    } else if (drag.h === 'e') {
      o.width = Math.max(0.03, (drag.width ?? 0.5) * ((drag.w + (px - drag.px) * 2) / drag.w));
    } else {
      o.x = drag.x + (px - drag.px) / stage.w;
      o.y = drag.y + (py - drag.py) / stage.h;
    }
    setDirty(true); syncFields?.();
  });
  const endDrag = () => { if (drag) { drag = null; history.flush(); } };
  el.stage.addEventListener('pointerup', endDrag); el.stage.addEventListener('pointercancel', endDrag);
  el.stage.addEventListener('dblclick', (e) => {
    const o = hit(...pos(e));
    if (o?.type !== 'text') return;
    selected = o.id; renderObjectPanel();
    edit.setEditing(true);
    o._body?.focus();
    const stop = () => { edit.setEditing(false); o._body?.removeEventListener('blur', stop); setDirty(true); };
    o._body?.addEventListener('blur', stop);
  });

  // Step badges are a toggle, off by default: on a busy slide they cover the art.
  let showBadges = false;
  try { showBadges = localStorage.getItem('shmEditor.badges') === '1'; } catch { /* storage blocked */ }
  const paintBadgeBtn = () => { $('badges').classList.toggle('on', showBadges); $('badges').textContent = showBadges ? 'steps: on' : 'steps: off'; };
  $('badges').addEventListener('click', () => {
    showBadges = !showBadges; paintBadgeBtn();
    try { localStorage.setItem('shmEditor.badges', showBadges ? '1' : '0'); } catch { /* ignore */ }
  });
  paintBadgeBtn();

  // Selection overlay: the box and its handles, redrawn every frame.
  const og = el.overlay.getContext('2d');
  const drawOverlay = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(stage.w * dpr), H = Math.round(stage.h * dpr);
    // A canvas does not stretch to `inset: 0` — it displays at its pixel size — so its CSS
    // size must be set too, or on a 2x screen the overlay is drawn at twice the stage size
    // and every selection box lands away from its object. Same trap Stage.sync handles.
    if (el.overlay.width !== W || el.overlay.height !== H) {
      el.overlay.width = W; el.overlay.height = H;
      el.overlay.style.width = `${stage.w}px`; el.overlay.style.height = `${stage.h}px`;
    }
    og.setTransform(dpr, 0, 0, dpr, 0, 0); og.clearRect(0, 0, stage.w, stage.h);
    // Step badges: which click brings each object in (and takes it out), so the build
    // order is readable on the slide itself.
    if (!previewing && showBadges) {
      og.font = '600 11px -apple-system, system-ui, sans-serif';
      og.textBaseline = 'middle';
      for (const ob of player.pool.objects) {
        if (!ob.in && !ob.out) continue;
        const bb = boxOf(ob); if (!bb) continue;
        const label = [ob.in ? `${ob.in.step === 0 ? 'auto' : ob.in.step}${ob.in.delay ? '+' : ''}` : null, ob.out ? `⇥${ob.out.step}` : null].filter(Boolean).join(' ');
        const tw = og.measureText(label).width + 10;
        const x = Math.max(2, Math.min(stage.w - tw - 2, bb.cx - bb.w / 2)), y = Math.max(9, bb.cy - bb.h / 2);
        og.fillStyle = ob.id === selected ? '#1b6fd1' : 'rgba(27,111,209,0.8)';
        og.beginPath(); og.roundRect?.(x, y - 8, tw, 16, 8); og.fill();
        og.fillStyle = '#fff'; og.fillText(label, x + 5, y);
      }
    }
    const o = selected && player.pool.live.get(selected);
    const b = !previewing && o && boxOf(o);
    if (b) {
      og.save(); og.translate(b.cx, b.cy); og.rotate(b.rot);
      og.strokeStyle = '#1b6fd1'; og.lineWidth = 1.5; og.setLineDash([5, 4]);
      og.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h); og.setLineDash([]);
      og.fillStyle = '#fff';
      const sq = (x, y) => { og.fillRect(x - 5, y - 5, 10, 10); og.strokeRect(x - 5, y - 5, 10, 10); };
      sq(b.w / 2, b.h / 2);
      if (o.type === 'text') sq(b.w / 2, 0);
      og.restore();
    }
    requestAnimationFrame(drawOverlay);
  };
  requestAnimationFrame(drawOverlay);

  // ── Keys ────────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const o = selected && player.pool.live.get(selected);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); return; }
    // ⌘] / ⌘[ — Keynote's own shortcuts. e.code, because Shift turns ']' into '}'.
    if ((e.metaKey || e.ctrlKey) && (e.code === 'BracketRight' || e.code === 'BracketLeft') && o) {
      e.preventDefault();
      const fwd = e.code === 'BracketRight';
      moveLayer(o, e.shiftKey ? (fwd ? 'front' : 'back') : (fwd ? 'up' : 'down'));
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(); return; }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!previewing) { startPreview(); break; }
        if (!player.builds.next()) { endPreview(); break; }
        status(`preview · Space plays builds (${player.builds.at}/${player.builds.total}) · Esc to edit`);
        break;
      case 'ArrowRight': if (e.shiftKey) { e.preventDefault(); gotoScene(player.index + 1); } else if (o) { o.x += 0.005; setDirty(true); } break;
      case 'ArrowLeft': if (e.shiftKey) { e.preventDefault(); gotoScene(player.index - 1); } else if (o) { o.x -= 0.005; setDirty(true); } break;
      case 'ArrowUp': if (o) { e.preventDefault(); o.y -= 0.005; setDirty(true); } break;
      case 'ArrowDown': if (o) { e.preventDefault(); o.y += 0.005; setDirty(true); } break;
      case 'Backspace': case 'Delete':
        if (o && o.id !== 'bg') { player.removeObject(o.id); selected = null; setDirty(true); renderObjectPanel(); renderBuildOrder(); }
        break;
      case 'Escape': if (previewing) { endPreview(); break; } selected = null; renderObjectPanel(); renderBuildOrder(); break;
      default: return;
    }
    syncFields?.();
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ── Go ──────────────────────────────────────────────────────────────────
  const start = Math.max(0, (parseInt(params.get('scene'), 10) || 1) - 1);
  $('undo').addEventListener('click', () => history.undo());
  $('redo').addEventListener('click', () => history.redo());
  gotoScene(start);
  history.past = [history.snap()]; history.buttons();
  renderRail();
  refreshThumbs(true);
  window.shmEditor = { player, stage, renderer, assets, save };
}

// Slide text for thumbnails: word-wrapped fillText at the box's font, size and alignment.
function paintText(g, o, st) {
  const px = (o.size ?? 0.036) * st.h;
  const fam = String(o.font ?? 'Helvetica Neue').split(',').map((f) => `"${f.trim()}"`).join(', ');
  g.save();
  g.font = `${o.italic ? 'italic ' : ''}${o.weight ?? 400} ${px}px ${fam}, sans-serif`;
  g.fillStyle = o.color ?? '#000';
  g.globalAlpha = o.opacity ?? 1;
  const maxW = (o.width ?? 0.9) * st.w;
  const lines = [];
  for (const para of String(o.text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (g.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  // Same shrink-to-fit rule as the stage, roughly: scale the block to the box height.
  const lh = px * (o.lineHeight ?? 1.2);
  let k = 1;
  if (o.fitHeight && lines.length * lh > o.fitHeight * st.h) k = (o.fitHeight * st.h) / (lines.length * lh);
  if (k < 1) g.font = g.font.replace(`${px}px`, `${px * k}px`);
  const total = lines.length * lh * k;
  const top = o.valign === 'middle' ? o.y * st.h - total / 2 : o.valign === 'bottom' ? o.y * st.h - total : o.y * st.h;
  const align = o.align ?? 'left';
  g.textAlign = align; g.textBaseline = 'top';
  const x = align === 'center' ? o.x * st.w : align === 'right' ? o.x * st.w + maxW / 2 : o.x * st.w - maxW / 2;
  lines.forEach((ln, n) => g.fillText(ln, x, top + n * lh * k));
  g.restore();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

main().catch((err) => { console.error('[editor] failed', err); $('status').textContent = 'something went wrong — check the console.'; });
