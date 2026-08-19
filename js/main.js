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

const params = new URLSearchParams(location.search);
const showName = params.get('show') || 'demo';
// ?scene=4 opens straight on a scene. Safe to jump anywhere: the script resolves from
// scene 0 up front, so scene 4 is identical however you arrived at it.
const startScene = Math.max(0, (parseInt(params.get('scene'), 10) || 1) - 1);

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), canvas: $('stage-canvas'), domLayer: $('dom-layer'),
  boot: $('boot'), bootMsg: $('boot-msg'), bootBar: $('boot-bar'),
  bootStage: $('boot-stage'), bootLoading: $('boot-loading'), startBtn: $('start-btn'),
  panel: $('panel'), skin: $('skin'), dirty: $('dirty-banner'), titleSub: $('titleSub'),
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
    // ventriloquy and wondered why nothing moved. No audio capability yet, so: off.
    el.statusMic.textContent = 'mic off';
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
    document.title = `shmuppetry — ${config.title}`;
    if (el.titleSub) el.titleSub.textContent = config.title;
  }

  const stage = new Stage({ el: el.stage, canvas: el.canvas, mirror: config.mirror !== false });
  stage.sync();

  boot(35, 'indexing assets…');
  const assets = new AssetLibrary(await loadJSON('./assets/manifest.json'));

  const renderer = new Renderer(stage);

  // Hand tracking, loaded only if the show asks for it — and never awaited. The wasm
  // bundle and model are the biggest download here, so the show starts without them and
  // fastened objects appear when tracking lands (§9.5, §2.6).
  tracking = new Tracking(stage, camera);
  const silhouette = new Silhouette(camera);
  if (config.capabilities?.includes('hands')) tracking.load();
  renderer.beforeFrame = (now) => tracking.update(now);

  // Dependencies passed explicitly — NOT a grab-bag that modules mutate to hand
  // capability back to the core, which is what 2.5.0's featureCtx became (§6).
  const deps = { stage, camera, assets, tracking, silhouette, paper: config.paper, domLayer: el.domLayer };
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
  const player = new Player({ make, renderer, onSceneChange: (s) => { panel.onSceneChange(s); edit.onSceneChange(); } });
  const panel = new Panel({ el: el.panel, player, edit, tabLabel: config.panelTab ?? null });
  edit.player = player;
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
    if (!ok && camera.state === 'denied') el.bootMsg.textContent = 'camera blocked — the show still runs without it.';
    el.boot.classList.add('hidden');
    setTimeout(() => { el.boot.hidden = true; }, 400);
    markStarted();
    player.goto(startScene);
  });

  if (params.has('nocam')) { el.boot.classList.add('hidden'); el.boot.hidden = true; }

  window.shmuppetry = { stage, renderer, player, camera, assets, panel, edit, tracking, silhouette };
}

main().catch((err) => {
  console.error('[boot] failed', err);
  booted = true;
  el.bootLoading.hidden = true;
  el.startBtn.hidden = true;
  el.bootMsg.textContent = 'something went wrong — check the console.';
});
