// ── Potato detection ──────────────────────────────────────────────────────
// A self-trained YOLOv8n run in the browser via onnxruntime-web. Ported from 2.5.0's
// js/features/potato.js — the letterbox maths and the output decode especially, which are
// fiddly, correct, and hard to re-derive (§8.2, §8.3).
//
// In 3.0 it is a FASTENER SOURCE, not an object type: `fasten: "potato"` pins any object
// to the detection, the same way `fasten: "rightHand"` pins to a hand. So a graphic on a
// potato needs no new machinery.
//
// THE MANUAL FALLBACK IS NOT OPTIONAL. 2.5.0 shipped it because detection fails under
// stage lighting, and a live show cannot depend on a model firing. Armed with `manual`,
// a keypress pins the same fastener to a hand instead.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Local disk on localhost — faster and works offline, which is how the show runs. In
// production the same weights come from jsDelivr off the public 2.5.0 repo, so 12MB never
// needs committing here.
const IS_LOCAL = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
const MODEL_URL = IS_LOCAL
  ? './assets/models/potato.onnx'
  : 'https://cdn.jsdelivr.net/gh/s-almeda/shmspace@v2.5.0/public/puppets/potato_model/potato.onnx';
const META_URL = './assets/models/potato.meta.json';

// 2.5.0's model had 7 classes with "Noise" at index 4. The decode derives the class count
// from the output shape, so a retrained single-class model works unchanged — the skip
// only applies when there are actually 7.
const NOISE_IDX = 4;

const RUN_EVERY = 2;      // inference every Nth frame; the box is smoothed between
const TRACK_LERP = 0.95;  // how hard the box chases the detection. High on purpose: a
                          // thrown potato moves fast and a laggy box reads as broken.

function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ORT_BASE + 'ort.min.js';
    s.onload = () => resolve(window.ort);
    s.onerror = () => reject(new Error('failed to load onnxruntime-web'));
    document.head.appendChild(s);
  });
}

export class Detector {
  constructor(stage, camera, tracking) {
    this.stage = stage;
    this.camera = camera;
    this.tracking = tracking;
    this.state = 'idle';      // idle | loading | ready | failed
    this.enabled = false;     // scenes turn detection on
    this.manual = false;      // armed fallback
    this.manualOn = false;    // fallback currently engaged
    this.manualHand = 'rightHand';
    // Low by default. On stage the model sees worse light than it trained in, and a
    // missed potato is a dead beat — a few false boxes are cheaper than no box.
    this.conf = 0.2;
    this.size = 480;          // overwritten from potato.meta.json
    this.det = null;          // smoothed box, stage-normalised
    this._raw = null;
    this._tick = 0;
    this._busy = false;
  }

  // Live controls, rendered by the panel's generic inspector.
  static fields = [
    { key: 'conf', label: 'conf', type: 'range', min: 0.02, max: 0.9, step: 0.01 },
    { key: 'manual', label: 'arm ‘p’', type: 'checkbox' },
    { key: 'enabled', label: 'detect', type: 'checkbox' },
  ];

  get fields() { return Detector.fields; }

  load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    Promise.all([
      loadOrt(),
      fetch(META_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(async ([ort, meta]) => {
        this.ort = ort;
        // imgsz comes from training. A hardcoded 640 against a 480 model produces garbage
        // boxes rather than an error, so it is read, not assumed.
        if (meta?.imgsz) this.size = meta.imgsz;
        ort.env.wasm.wasmPaths = ORT_BASE;
        ort.env.wasm.numThreads = 1;
        this.session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ['wasm'],
        });
        this.inputName = this.session.inputNames[0];
        this.outputName = this.session.outputNames[0];
        this.off = document.createElement('canvas');
        this.off.width = this.off.height = this.size;
        this.offCtx = this.off.getContext('2d', { willReadFrequently: true });
        this.state = 'ready';
        console.log(`[potato] ready — ${this.size}px input`);
      })
      .catch((err) => {
        // A failed capability is logged and skipped; the show keeps running without it.
        this.state = 'failed';
        console.warn('[potato] failed to load', err);
      });
  }

  // Called once per frame. Inference is async and runs on its own cadence; the smoothing
  // below runs every frame so the box keeps moving between detections.
  update() {
    if (this.det && this._raw) {
      this.det.x += (this._raw.x - this.det.x) * TRACK_LERP;
      this.det.y += (this._raw.y - this.det.y) * TRACK_LERP;
      this.det.size += (this._raw.size - this.det.size) * TRACK_LERP;
      this.det.score = this._raw.score;   // position is smoothed; confidence is not
    } else if (this._raw) {
      this.det = { ...this._raw };
    }
    if (!this.enabled || this.state !== 'ready' || !this.camera.live) return;
    if (++this._tick % RUN_EVERY || this._busy) return;
    this._infer();
  }

  async _infer() {
    this._busy = true;
    try {
      const video = this.camera.video;
      const S = this.size;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;

      // Letterbox the frame into S×S, preserving aspect and padding with black.
      const scale = Math.min(S / vw, S / vh);
      const nw = Math.round(vw * scale), nh = Math.round(vh * scale);
      const dx = Math.floor((S - nw) / 2), dy = Math.floor((S - nh) / 2);
      this.offCtx.fillStyle = '#000';
      this.offCtx.fillRect(0, 0, S, S);
      this.offCtx.drawImage(video, 0, 0, vw, vh, dx, dy, nw, nh);

      // → CHW float32 RGB, 0..1
      const { data } = this.offCtx.getImageData(0, 0, S, S);
      const area = S * S;
      const arr = new Float32Array(area * 3);
      for (let i = 0; i < area; i++) {
        arr[i] = data[i * 4] / 255;
        arr[area + i] = data[i * 4 + 1] / 255;
        arr[2 * area + i] = data[i * 4 + 2] / 255;
      }
      const tensor = new this.ort.Tensor('float32', arr, [1, 3, S, S]);
      const out = await this.session.run({ [this.inputName]: tensor });
      const o = out[this.outputName];
      const d = o.data, dims = o.dims;

      // YOLOv8 exports as [1, 4+nc, A] (channel-major) or [1, A, 4+nc]. The channel count
      // is the smaller axis; detecting which avoids caring how the model was exported.
      const channelMajor = dims[1] <= dims[2];
      const C = channelMajor ? dims[1] : dims[2];
      const A = channelMajor ? dims[2] : dims[1];
      const nc = C - 4;
      const at = channelMajor ? (ch, a) => d[ch * A + a] : (ch, a) => d[a * C + ch];

      let best = null;
      for (let a = 0; a < A; a++) {
        let score = -1;
        for (let c = 0; c < nc; c++) {
          if (nc === 7 && c === NOISE_IDX) continue;
          const s = at(4 + c, a);
          if (s > score) score = s;
        }
        if (score < this.conf) continue;
        if (!best || score > best.score) {
          best = { cx: at(0, a), cy: at(1, a), w: at(2, a), h: at(3, a), score };
        }
      }

      if (!best) { this._raw = null; this.det = null; return; }

      // Undo the letterbox back to video pixels, then hand BOTH the centre and an edge
      // through videoNormToStage — so the mirror is resolved once, at the boundary, like
      // everything else (§9.2), and the size comes out in the same units as every other
      // fastener.
      const toVideo = (x, y) => [(x - dx) / scale / vw, (y - dy) / scale / vh];
      const c = this.stage.videoNormToStage(...toVideo(best.cx, best.cy), video);
      const e = this.stage.videoNormToStage(...toVideo(best.cx + best.w / 2, best.cy + best.h / 2), video);
      this._raw = {
        x: c.x,
        y: c.y,
        size: Math.max(Math.abs(e.y - c.y) * 2, Math.abs(e.x - c.x) * 2 / this.stage.aspect),
        score: best.score,
      };
    } catch (err) {
      console.warn('[potato] inference failed', err);
    } finally {
      this._busy = false;
    }
  }

  // The fastener. Falls back to a hand when the manual override is engaged — which is the
  // whole point of it: a live show cannot wait for a model to notice a potato.
  fastener() {
    if (this.manualOn) {
      const hand = this.tracking?.fastener(this.manualHand);
      return hand ? { ...hand, size: hand.size * 0.8 } : null;
    }
    return this.det ? { x: this.det.x, y: this.det.y, size: this.det.size, angle: 0 } : null;
  }

  toggleManual() {
    if (!this.manual) return;
    this.manualOn = !this.manualOn;
    console.log(`[potato] manual fallback ${this.manualOn ? 'ON' : 'off'}`);
  }
}
