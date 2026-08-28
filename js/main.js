// ── Boot ──────────────────────────────────────────────────────────────────
// The shell: wiring, the camera, and the status bar. 2.5.0's index.html was 2044 lines
// of everything (§10); if this file starts growing logic, it belongs in a module.

import { Stage, Renderer } from './stage.js';
import { AssetLibrary } from './assets.js';
import { Player } from './scene.js';
import { Panel, EditMode } from './panel.js';
import { TYPES } from './objects.js';
import { Tracking } from './tracking.js';
import { Silhouette } from './silhouette.js';
import { Detector } from './detector.js';
import { Mic } from './mic.js';
import { FaceAnalysis } from './facelabel.js';
import { Showcase } from './showcase.js';

const params = new URLSearchParams(location.search);
const showName = params.get('show') || 'demo';
// ?scene=4 opens straight on a scene. Safe to jump anywhere: the script resolves from
// scene 0 up front, so scene 4 is identical however you arrived at it.
const startScene = Math.max(0, (parseInt(params.get('scene'), 10) || 1) - 1);

// US-layout shifted punctuation, folded back to the unshifted key. Only needed because
// shift is the reverse-step modifier for `cycleKey`, so ']' and '}' have to mean the same
// binding. Letters fall through to toLowerCase() and need no table.
const UNSHIFTED = {
  '}': ']', '{': '[', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
  '~': '`', '|': '\\', '_': '-', '+': '=',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), canvas: $('stage-canvas'), domLayer: $('dom-layer'),
  boot: $('boot'), bootMsg: $('boot-msg'), bootBar: $('boot-bar'),
  bootStage: $('boot-stage'), bootLoading: $('boot-loading'), startBtn: $('start-btn'),
  panel: $('panel'), skin: $('skin'), dirty: $('dirty-banner'), titleMain: $('titleMain'),
  statusDate: $('status-date'), statusRuntime: $('status-runtime'),
  statusCamera: $('status-camera'), statusMic: $('status-mic'),
};

// ── Camera ────────────────────────────────────────────────────────────────
// One video element, shared by everything that needs the feed. Camera and mic are
// SEPARATE getUserMedia grants (§9.4) — in 2.5.0 people enabled ventriloquy and
// wondered why nothing moved, because the mic prompt was a second thing they never saw.
const camera = {
  video: Object.assign(document.createElement('video'), { autoplay: true, muted: true, playsInline: true }),
  state: 'off',
  get live() { return this.state === 'live' && this.video.readyState >= 2; },

  // Freezing must hold the PIXELS as well as the tracking. Holding only the landmarks
  // freezes a cutout's outline while live video keeps playing through it — the shape
  // stops, the face inside it does not.
  //
  // Everything that draws the feed reads `source`, so a snapshot swaps in without any
  // drawing code knowing. Captured at native resolution, so every cover-fit and
  // coordinate mapping downstream is unchanged.
  get source() { return this._still ?? this.video; },

  snap() {
    if (this._still || !this.live) return;
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    c.getContext('2d').drawImage(this.video, 0, 0);
    this._still = c;
  },

  release() { this._still = null; },
  async start() {
    if (this.state === 'live') return true;
    this.state = 'starting';
    try {
      this.video.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      await this.video.play();
      this.state = 'live';
      return true;
    } catch (err) {
      this.state = err?.name === 'NotAllowedError' ? 'denied' : 'error';
      console.warn('[camera] unavailable', err);
      return false;
    }
  },
};

// Offscreen but decoding — it is a texture source, never displayed directly.
camera.video.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';
document.body.appendChild(camera.video);

// ── Boot progress ─────────────────────────────────────────────────────────
// Only BLOCKING work sits behind the bar. 2.5.0 originally awaited everything before
// showing the start button, putting a 12MB download between a visitor and the camera —
// a control that is visible but not yet functional reads as broken (§9.5).
let booted = false;
const boot = (pct, label) => { el.bootBar.value = pct; if (label) el.bootStage.textContent = label; };
function bootDone() {
  if (booted) return;
  booted = true;
  el.bootLoading.hidden = true;
  el.startBtn.hidden = false;
}
// Never trap someone behind the bar because one fetch hung.
setTimeout(() => { if (!booted) { console.warn('[boot] timed out — starting anyway'); bootDone(); } }, 20000);

// The dev server serves these live from disk and build-manifests.js bakes identical
// shapes for static hosting, so the client never knows which it is talking to.
const loadJSON = (url, fallback = null) =>
  fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);

let tracking = null;
let player = null;
// Module-level for the same reason `player` is: the keydown handler below is bound during
// boot and closes over this, and a top-level `const` declared further down would be in its
// temporal dead zone until then — a ReferenceError that takes the whole rig with it (§9.7).
let panel = null;
let mic = { ready: false, denied: false };

function startStatusBar() {
  let startedAt = null;
  const fmt = (ms) => {
    const t = Math.floor(ms / 1000), m = Math.floor(t / 60);
    return `${m}:${String(t % 60).padStart(2, '0')}`;
  };
  const paint = () => {
    el.statusDate.textContent = new Date()
      .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      .toLowerCase();
    el.statusRuntime.textContent = startedAt === null ? '—' : fmt(performance.now() - startedAt);
    el.statusCamera.textContent = camera.live ? 'webcam on' : 'webcam off';
    // Camera and mic are separate getUserMedia grants (§9.4) — in 2.5.0 people turned on
    // ventriloquy and wondered why nothing moved, so mic state is surfaced.
    el.statusMic.textContent = mic.ready ? 'mic on' : mic.denied ? 'mic blocked' : 'mic off';
  };
  paint();
  setInterval(paint, 1000);
  return () => { startedAt ??= performance.now(); };
}

async function main() {
  boot(10, 'reading show config…');
  const config = await loadJSON(`./shows/${showName}/config.json`, {});
  if (config.skin) el.skin.href = `./css/skins/${config.skin}.css`;
  if (config.title) {
    // Don't prefix a title that already says it — the demo's own title is "shmuppetry rig
    // 3.0", which would otherwise stutter in the browser tab.
    document.title = /shmuppetry/i.test(config.title) ? config.title : `shmuppetry — ${config.title}`;
    // The titlebar itself. This used to write to #titleSub, which is commented out in
    // index.html — so a show's title was set and then never shown. Scene 12's
    // `chrome-marquee` body class replaces this text with the circus banner.
    if (el.titleMain) el.titleMain.textContent = config.title;
  }

  const stage = new Stage({ el: el.stage, canvas: el.canvas, mirror: config.mirror !== false });
  stage.sync();

  boot(35, 'indexing assets…');
  // meta.json is optional — a show with no provenance and no face-aligned art boots
  // identically without it, so a missing file is a fallback, never an error.
  const [manifest, meta] = await Promise.all([
    loadJSON('./assets/manifest.json'),
    loadJSON('./assets/meta.json', {}),
  ]);
  const assets = new AssetLibrary(manifest, meta);

  const renderer = new Renderer(stage);
  if (params.has('perf')) {
    renderer.perf = { frames: 0, total: 0, tracking: 0, update: 0, draw: 0, silhouette: 0 };
    console.log('[perf] measuring — one line per 60 frames');
  }

  // Hand tracking, loaded only if the show asks for it — and never awaited. The wasm
  // bundle and model are the biggest download here, so the show starts without them and
  // fastened objects appear when tracking lands (§9.5, §2.6).
  tracking = new Tracking(stage, camera);
  const silhouette = new Silhouette(camera);
  const detector = new Detector(stage, camera, tracking);
  mic = new Mic();
  const faces = new FaceAnalysis(stage, camera);
  tracking.detector = detector;
  for (const kind of ['hands', 'face']) {
    if (config.capabilities?.includes(kind)) tracking.load(kind);
  }
  if (config.capabilities?.includes('potato')) detector.load();
  if (config.capabilities?.includes('faceLabels')) faces.load();
  let lastNow = performance.now();
  renderer.beforeFrame = (now) => {
    mic.update(now - lastNow);
    lastNow = now;
    tracking.update(now);
    detector.update();
    faces.update(now);
  };

  // The manual fallback. Bound early and unconditionally so it is available the moment
  // the detector lets you down, which is the only time it matters.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key.toLowerCase() === 'p') detector.toggleManual();

    // Any object declaring `cycleKey` steps its source list. The script drives the hand
    // puppets with ']' while talking, so the binding is per-object rather than global —
    // two puppets can cycle on different keys.
    //
    // Shift steps BACKWARD, which means the shifted key has to be folded back to the one
    // the scene actually names: holding shift on ']' reports `e.key` as '}', and on 'q' as
    // 'Q', so a literal comparison could never match while stepping back. The reverse step
    // documented in shmidpoint scene 3 had never once worked.
    const key = e.shiftKey && e.key.length === 1
      ? (UNSHIFTED[e.key] ?? e.key.toLowerCase())
      : e.key;
    let cycled = false;
    for (const o of player?.pool.objects ?? []) {
      if (o.cycleKey === key) { o.cycle?.(e.shiftKey ? -1 : 1); cycled = true; }
    }
    // Cycling changes which asset is on stage, so the inspector — and the metadata editor
    // keyed on that asset — are now showing the previous one. Authoring a series is the
    // main reason to cycle at all, so this has to follow.
    if (cycled) panel?.renderInspector();
  });

  // Dependencies passed explicitly — NOT a grab-bag that modules mutate to hand
  // capability back to the core, which is what 2.5.0's featureCtx became (§6).
  const deps = { stage, camera, assets, tracking, silhouette, detector, mic, faces, renderer, paper: config.paper, domLayer: el.domLayer };
  const make = (spec) => {
    const Type = TYPES[spec.type];
    if (!Type) { console.warn(`[scene] unknown object type "${spec.type}" (${spec.id})`); return null; }
    return new Type(spec, deps);
  };

  boot(65, 'loading script…');
  const scenes = await loadJSON(`./shows/${showName}/script.json`);
  if (!scenes) {
    el.bootLoading.hidden = true;
    el.bootMsg.textContent = `couldn't load shows/${showName}/script.json`;
    booted = true;               // never offer a button that cannot work
    return;
  }

  const edit = new EditMode({ showName, banner: el.dirty });
  deps.edit = edit;
  player = new Player({
    make, renderer, tracking, camera,
    bodyBase: document.body.className,
    // showcase.afterScene runs FIRST: it re-asserts the detector flags and the .editing
    // class that goto() has just overwritten, before the panel paints from that state.
    onSceneChange: (s) => { showcase.afterScene(s); panel.onSceneChange(s); edit.onSceneChange(); },
  });
  const showcase = new Showcase({
    player, edit, tracking, detector, faces, showName, toggles: config.showcase,
  });
  // The two hooks: contribute objects to every resolved scene, and keep the visitor's
  // objects out of anything an author saves back to disk.
  player.decorate = (scene) => showcase.decorate(scene);
  player.ephemeral = (id) => showcase.owns(id);
  edit.onEdit = () => showcase.captureText();
  panel = new Panel({
    el: el.panel, player, edit, detector, showcase, assets, tracking, mic,
    tabLabel: config.panelTab ?? null,
  });
  edit.player = player;
  // Lets one object pin to another (`fasten: "face.hat"`), and lets the panel offer those
  // combinations. Wired after the player exists, since the pool lives there.
  deps.find = (id) => player.pool.live.get(id);
  deps.list = () => player.pool.objects;
  player.load(scenes);
  panel.mount();

  boot(90, 'checking for local server…');
  await edit.probe();

  player.bindKeys();
  renderer.start();
  const markStarted = startStatusBar();

  // Render the first scene BEFORE the camera is granted: WebcamFeed draws a placeholder,
  // so the stage is live and positionable while you decide about permission — and if
  // permission is refused the show still runs, minus one object.
  player.goto(startScene, { instant: true });
  bootDone();

  el.startBtn.addEventListener('click', async () => {
    el.startBtn.disabled = true;
    el.bootStage.hidden = false;
    const ok = await camera.start();
    const blocked = [];
    if (!ok && camera.state === 'denied') blocked.push('camera');

    // Camera and mic are SEPARATE getUserMedia grants (§9.4) — in 2.5.0 people turned on a
    // mic-driven puppet and wondered why nothing moved, because the second prompt was a
    // thing they never saw. A show that declares `micOnStart` asks for both here, off the
    // one click, so there is nothing left to discover mid-performance.
    if (config.micOnStart) {
      if (!(await mic.enable())) blocked.push('mic');
    }
    if (blocked.length) {
      el.bootMsg.textContent = `${blocked.join(' and ')} blocked — the show still runs without ${blocked.length > 1 ? 'them' : 'it'}.`;
    }
    el.boot.classList.add('hidden');
    setTimeout(() => { el.boot.hidden = true; }, 400);
    markStarted();
    player.goto(startScene);
  });

  if (params.has('nocam')) { el.boot.classList.add('hidden'); el.boot.hidden = true; }

  window.shmuppetry = { stage, renderer, player, camera, assets, panel, edit, showcase, tracking, silhouette, detector, mic, faces };
}

main().catch((err) => {
  console.error('[boot] failed', err);
  booted = true;
  el.bootLoading.hidden = true;
  el.startBtn.hidden = true;
  el.bootMsg.textContent = 'something went wrong — check the console.';
});
