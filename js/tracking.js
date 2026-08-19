// ── Tracking → Fasteners ──────────────────────────────────────────────────
// A FASTENER is a pushpin: a named point on the puppeteer that an object can be pinned
// to. An object with `"fasten": "rightHand"` follows that point, with its own x/y as an
// offset on top (§2.4, anchors only).
//
// Two trackers, loaded independently and never awaited by the boot sequence — the wasm
// bundle and models are the biggest download here, so the show starts without them and
// fastened objects appear when tracking lands (§9.5). A show that only needs hands never
// downloads the face model.

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest';
const MODELS = {
  hands: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

// MediaPipe's handedness label → the performer's hand. Lifted from 2.5.0 along with its
// note: if this feels swapped on your hardware, swap these two.
const PERFORMER_LEFT = 'Left';
const PERFORMER_RIGHT = 'Right';

export const HAND_PARTS = ['leftHand', 'rightHand'];
export const FACE_PARTS = ['face', 'leftEye', 'rightEye', 'mouth'];

// Turn MediaPipe's connection list (unordered {start,end} edges) into ordered rings of
// landmark indices. Some sets contain more than one cycle — the lips set has an outer
// contour AND the inner mouth opening — so return them all and choose later.
//
// They cannot be told apart by point count: both lip rings have the same number. Picking
// the longer one landed on the INNER ring, which is why an open mouth was cut across from
// corner to corner. The outer ring is the one with the larger area, and that can only be
// measured against live landmarks.
function rings(connections) {
  // UNDIRECTED adjacency. MediaPipe's connection lists have no consistent direction, so a
  // landmark can appear as `start` in two of them. Keying a Map by `start` keeps only the
  // last and silently drops edges — the walk then produces a partial path that closes
  // arbitrarily, which is what cut the top half off the mouth.
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const c of connections) { link(c.start, c.end); link(c.end, c.start); }

  const seen = new Set();
  const out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const cycle = [start];
    seen.add(start);
    let cur = start, prev = null;
    for (;;) {
      const next = (adj.get(cur) ?? []).find((v) => v !== prev && !seen.has(v));
      if (next === undefined) break;
      cycle.push(next);
      seen.add(next);
      prev = cur;
      cur = next;
    }
    if (cycle.length > 2) out.push(cycle);
  }
  return out;
}

// Shoelace area, used to pick the outer ring of a multi-ring set.
function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export class Tracking {
  constructor(stage, camera) {
    this.stage = stage;
    this.camera = camera;
    this.state = { hands: 'idle', face: 'idle' };   // idle | loading | ready | failed
    this.hands = {};        // 'leftHand' | 'rightHand' → 21 raw landmarks
    this.face = null;       // 478 raw landmarks
    this.rings = {};        // region name → ordered landmark indices
    this._models = {};
    this._lastAt = -1;
  }

  ready(kind) { return this.state[kind] === 'ready'; }

  load(kind) {
    if (this.state[kind] !== 'idle') return;
    this.state[kind] = 'loading';
    import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`)
      .then(async (mp) => {
        const fileset = await mp.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
        const base = { baseOptions: { modelAssetPath: MODELS[kind], delegate: 'GPU' }, runningMode: 'VIDEO' };
        if (kind === 'hands') {
          this._models.hands = await mp.HandLandmarker.createFromOptions(fileset, { ...base, numHands: 2 });
        } else {
          this._models.face = await mp.FaceLandmarker.createFromOptions(fileset, { ...base, numFaces: 1 });
          const F = mp.FaceLandmarker;
          this.rings = {
            face: rings(F.FACE_LANDMARKS_FACE_OVAL),
            leftEye: rings(F.FACE_LANDMARKS_LEFT_EYE),
            rightEye: rings(F.FACE_LANDMARKS_RIGHT_EYE),
            mouth: rings(F.FACE_LANDMARKS_LIPS),
          };
          // A broken cycle is silent otherwise — it just draws a wrong shape. Log the
          // sizes so a partial ring is obvious.
          console.log('[tracking] face contours:', Object.fromEntries(
            Object.entries(this.rings).map(([k, v]) => [k, v.map((c) => c.length)])));
        }
        this.state[kind] = 'ready';
      })
      .catch((err) => {
        // A capability that fails is logged and skipped; the show keeps running.
        this.state[kind] = 'failed';
        console.warn(`[tracking] ${kind} failed to load`, err);
      });
  }

  // Called once per frame, before objects draw.
  update(now) {
    const video = this.camera.video;
    if (!this.camera.live) return;
    if (now === this._lastAt) return;   // detectForVideo needs a rising timestamp
    this._lastAt = now;

    if (this._models.hands) {
      try {
        const r = this._models.hands.detectForVideo(video, now);
        this.hands = {};
        (r.landmarks ?? []).forEach((points, i) => {
          const label = r.handedness?.[i]?.[0]?.categoryName;
          if (label === PERFORMER_LEFT) this.hands.leftHand = points;
          else if (label === PERFORMER_RIGHT) this.hands.rightHand = points;
        });
      } catch (err) { console.warn('[tracking] hand detect failed', err); }
    }

    if (this._models.face) {
      try {
        const r = this._models.face.detectForVideo(video, now);
        this.face = r.faceLandmarks?.[0] ?? null;
      } catch (err) { console.warn('[tracking] face detect failed', err); }
    }
  }

  // All 21 hand landmarks in STAGE space.
  points(name) {
    const h = this.hands[name];
    if (!h) return null;
    const v = this.camera.video;
    return h.map((p) => this.stage.videoNormToStage(p.x, p.y, v));
  }

  // A face region's contour, in STAGE space and in ring order. The face needs none of the
  // hand's colour segmentation: the landmark contour IS the silhouette, and a face does
  // not rotate or occlude itself the way a hand does.
  contour(part) {
    const candidates = this.rings[part];
    if (!candidates?.length || !this.face) return null;
    const v = this.camera.video;
    const toStage = (cycle) => cycle.map((i) => {
      const p = this.face[i];
      return this.stage.videoNormToStage(p.x, p.y, v);
    });
    if (candidates.length === 1) return toStage(candidates[0]);
    // Multi-ring set (the lips): take the OUTER contour, i.e. the one enclosing more area.
    return candidates.map(toStage).reduce((best, r) => (area(r) > area(best) ? r : best));
  }

  // Resolve a fastener to a point in STAGE space, plus a size to scale pinned art by.
  // Returns null when the part isn't visible — a pinned object with nothing to pin to
  // simply isn't on stage this frame.
  fastener(name) {
    if (FACE_PARTS.includes(name)) return this._faceFastener(name);
    const h = this.hands[name];
    if (!h) return null;
    const stage = this.stage, v = this.camera.video;
    // Landmark 0 is the wrist, 9 the middle-finger base, 12 the middle fingertip. Palm =
    // midpoint of 0 and 9; size = wrist-to-fingertip span, as in 2.5.0.
    const palm = stage.videoNormToStage((h[0].x + h[9].x) / 2, (h[0].y + h[9].y) / 2, v);
    const wrist = stage.videoNormToStage(h[0].x, h[0].y, v);
    const tip = stage.videoNormToStage(h[12].x, h[12].y, v);
    const dx = (tip.x - wrist.x) * stage.aspect;
    return { x: palm.x, y: palm.y, size: Math.hypot(dx, tip.y - wrist.y) };
  }

  _faceFastener(part) {
    const pts = this.contour(part);
    if (!pts?.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    // Size in fractions of stage HEIGHT, so it means the same as every other size.
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(y1 - y0, (x1 - x0) / this.stage.aspect) };
  }
}
