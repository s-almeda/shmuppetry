// ── Hand tracking → Fasteners ─────────────────────────────────────────────
// A FASTENER is a pushpin: a named point on the puppeteer that an object can be
// pinned to. An object with `"fasten": "rightHand"` follows that point, with its own
// x/y as an offset on top (§2.4, anchors only).
//
// Loaded lazily and never awaited by the boot sequence — the wasm bundle and model are
// the biggest download here, so the show starts without them and the fastened objects
// simply appear when tracking lands (§9.5).

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// MediaPipe's handedness label → the performer's hand. Lifted from 2.5.0 along with its
// note: if this feels swapped on your hardware, swap these two.
const PERFORMER_LEFT = 'Left';
const PERFORMER_RIGHT = 'Right';

export class Tracking {
  constructor(stage, camera) {
    this.stage = stage;
    this.camera = camera;
    this.state = 'idle';        // idle | loading | ready | failed
    this.landmarker = null;
    this.hands = {};            // 'leftHand' | 'rightHand' → 21 raw landmarks
    this._lastAt = -1;
  }

  load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs')
      .then(async ({ HandLandmarker, FilesetResolver }) => {
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
        });
        this.state = 'ready';
      })
      .catch((err) => {
        // A capability that fails is logged and skipped; the show keeps running.
        this.state = 'failed';
        console.warn('[tracking] hand landmarker failed to load', err);
      });
  }

  // Called once per frame, before objects draw.
  update(now) {
    const video = this.camera.video;
    if (this.state !== 'ready' || !this.camera.live) return;
    if (now === this._lastAt) return;   // detectForVideo needs a rising timestamp
    this._lastAt = now;
    let result;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch (err) {
      console.warn('[tracking] detect failed', err);
      return;
    }
    this.hands = {};
    (result.landmarks ?? []).forEach((points, i) => {
      const label = result.handedness?.[i]?.[0]?.categoryName;
      if (label === PERFORMER_LEFT) this.hands.leftHand = points;
      else if (label === PERFORMER_RIGHT) this.hands.rightHand = points;
    });
  }

  // All 21 landmarks in STAGE space. The cut path for a disembodied hand is built from
  // these (§2.3) — no extra model, the points are already here.
  points(name) {
    const h = this.hands[name];
    if (!h) return null;
    const v = this.camera.video;
    return h.map((p) => this.stage.videoNormToStage(p.x, p.y, v));
  }

  // Resolve a fastener to a point in STAGE space, plus a size to scale pinned art by.
  // Returns null when that hand isn't visible — a pinned object with nothing to pin to
  // simply isn't on stage this frame.
  //
  // Landmark 0 is the wrist, 9 the middle-finger base, 12 the middle fingertip. Palm =
  // midpoint of 0 and 9; size = wrist-to-fingertip span, as in 2.5.0.
  fastener(name) {
    const h = this.hands[name];
    if (!h) return null;
    const stage = this.stage;
    const v = this.camera.video;
    const palm = stage.videoNormToStage((h[0].x + h[9].x) / 2, (h[0].y + h[9].y) / 2, v);
    const wrist = stage.videoNormToStage(h[0].x, h[0].y, v);
    const tip = stage.videoNormToStage(h[12].x, h[12].y, v);
    // Size in fractions of stage HEIGHT, so it means the same thing as every other size.
    const dx = (tip.x - wrist.x) * stage.aspect;
    const size = Math.hypot(dx, tip.y - wrist.y);
    return { x: palm.x, y: palm.y, size };
  }
}
