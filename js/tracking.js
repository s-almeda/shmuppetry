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

// Fingertip mounts — scene 30 puts a finger puppet on each finger. Flat names rather than
// `leftHand.index`, because a dot already means "in that OBJECT's space" and the two would
// be indistinguishable.
//
// MediaPipe tips: thumb 4, index 8, middle 12, ring 16, pinky 20. The joint below each is
// what gives a puppet its size and its angle, so it sits along the finger rather than
// upright on a tilted hand.
const FINGERTIPS = {
  Thumb: [3, 4], Index: [6, 8], Middle: [10, 12], Ring: [14, 16], Pinky: [18, 20],
};
export const FINGER_PARTS = ['leftHand', 'rightHand'].flatMap((h) =>
  Object.keys(FINGERTIPS).map((f) => h.replace('Hand', '') + f));
export const FACE_PARTS = ['face', 'leftEye', 'rightEye', 'mouth'];

// ── Face mounts (§2.2) ────────────────────────────────────────────────────
// A mount is not just a point. HAT and BEARD both sit near the face's vertical axis but
// attach OPPOSITELY: a hat rests its bottom edge on the top of the head, a beard hangs
// its top edge off the chin. So a mount carries a point, WHICH EDGE of the art meets it,
// and what its size is measured against. Getting this wrong is what forced 2.5.0 into
// per-asset headXOffset/headYOffset nudges.
//
// Sizes are widths, because that is how head-worn things actually scale — a hat matches
// head width, a beard matches jaw width.
const MESH = {
  crown: 10, chin: 152, noseTip: 1,
  eyeL: 33, eyeR: 263,        // outer eye corners — also the head-roll reference
  cheekL: 234, cheekR: 454,   // face width
  jawL: 172, jawR: 397,       // jaw width
};

// Mounts on the MOUTH rather than the face. The BricolMage hangs a hat off the top lip
// and a little body off the bottom one, so both edges need a mount with the right
// attachment: the hat rests its bottom edge on the upper lip, the body hangs its top edge
// from the lower one — the same opposite-attachment problem as hat vs beard (§2.2).
//
// Derived from the lips CONTOUR rather than fixed landmarks, so they track the mouth as it
// opens instead of sitting at a guessed offset. Usable nested — `fasten: "mouth.mouthTop"`
// resolves in the mouth cutout's own space, so the hat follows it as you move and rotate it.
export const CONTOUR_MOUNTS = {
  mouthTop: { part: 'mouth', edge: 'top', anchor: 'bottom' },
  mouthBottom: { part: 'mouth', edge: 'bottom', anchor: 'top' },
};

export const FACE_MOUNTS = {
  hat:     { at: [MESH.crown], anchor: 'bottom', width: ['cheekL', 'cheekR'], scale: 1 },
  glasses: { at: [MESH.eyeL, MESH.eyeR], anchor: 'center', width: ['cheekL', 'cheekR'], scale: 1 },
  nose:    { at: [MESH.noseTip], anchor: 'center', width: ['cheekL', 'cheekR'], scale: 0.35 },
  beard:   { at: [MESH.chin], anchor: 'top', width: ['jawL', 'jawR'], scale: 1 },
};

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
    this.mesh = [];         // face tesselation as [a, b] edge pairs; filled when face loads
    this._models = {};
    this._lastAt = -1;
    // When frozen, detection stops and the last landmarks stand. Everything downstream —
    // cutouts, mounts, fasteners — freezes without needing to know about it.
    this.frozen = false;
    this.detector = null;      // set by main.js when the potato capability loads
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
          // The full mesh wireframe, kept as RAW EDGE PAIRS rather than run through
          // rings(): the tesselation is a triangle soup with ~2600 edges and no cycles to
          // find, so the ring walk would churn through it and return nothing useful.
          // Only the `landmarks` object reads this, and only to stroke each edge once.
          this.mesh = (F.FACE_LANDMARKS_TESSELATION ?? []).map((c) => [c.start, c.end]);
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

  // ── Scanning a still image ──────────────────────────────────────────────
  // Find the face in a piece of ART, so `align: "face"` can put that face on the live one.
  // Authoring-time only: the result is written into assets/meta.json and a performance
  // never runs this, so nothing extra loads on stage.
  //
  // This deliberately uses MEDIAPIPE rather than the face-api nets facelabel.js already
  // has loaded. The two report different crops — face-api's detector box is tighter than
  // the face oval — and the live fastener measures the oval. Mixing them would mis-scale
  // every mask by a consistent, baffling amount, so the scan has to compute the box the
  // same way `_faceFastener` does.
  //
  // A second FaceLandmarker is genuinely required: runningMode is fixed at construction
  // and one instance cannot serve both VIDEO and IMAGE.
  async _imageModel() {
    if (this._models.faceImage) return this._models.faceImage;
    const mp = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
    const fileset = await mp.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    this._models.faceImage = await mp.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS.face, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    // The rings come off the same class, so a scan works even if the VIDEO model was
    // never loaded — which is the case on a show that has no `face` capability.
    if (!this.rings.face) {
      const F = mp.FaceLandmarker;
      this.rings = {
        face: rings(F.FACE_LANDMARKS_FACE_OVAL),
        leftEye: rings(F.FACE_LANDMARKS_LEFT_EYE),
        rightEye: rings(F.FACE_LANDMARKS_RIGHT_EYE),
        mouth: rings(F.FACE_LANDMARKS_LIPS),
      };
    }
    return this._models.faceImage;
  }

  // → { x, y, w, h, roll } normalised 0..1 of the image, or null if no face was found.
  // Coordinates are the image's OWN, never the stage's: the record travels with the art
  // and must not depend on the window it happened to be scanned in.
  async scanImage(el) {
    let model;
    try {
      model = await this._imageModel();
    } catch (err) {
      console.warn('[tracking] image model failed to load', err);
      return null;
    }
    const pts = model.detect(el)?.faceLandmarks?.[0];
    if (!pts) return null;

    // The face-oval AABB, the same reduction _faceFastener performs — but in image space,
    // so no aspect correction: x and y are both fractions of the image's own dimensions.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of this.rings.face ?? []) {
      for (const i of ring) {
        const p = pts[i];
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    if (!Number.isFinite(x0)) return null;

    // Roll from the outer eye corners, as _roll does. The art is not mirrored, so unlike
    // the stage path there is no left/right reordering to undo — but the image's pixel
    // aspect still has to be folded in or a wide canvas reads as a tilted face.
    const a = pts[MESH.eyeL], b = pts[MESH.eyeR];
    const nat = { w: el.naturalWidth || el.width, h: el.naturalHeight || el.height };
    const roll = (Math.atan2((b.y - a.y) * nat.h, (b.x - a.x) * nat.w) * 180) / Math.PI;

    const r = (n) => Math.round(n * 1e4) / 1e4;
    return { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0), roll: r(roll) };
  }

  // Called once per frame, before objects draw.
  update(now) {
    const video = this.camera.video;
    if (!this.camera.live || this.frozen) return;
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
    // The potato is another fastener source, resolved through the same door as hands and
    // face mounts so no object needs to know it is special.
    if (name === 'potato') return this.detector?.fastener() ?? null;
    if (CONTOUR_MOUNTS[name]) return this._contourMount(name);
    const finger = this._fingerFastener(name);
    if (finger !== undefined) return finger;
    if (FACE_MOUNTS[name]) return this._mountFastener(name);
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

  // Head roll, from the line between the outer eye corners. Computed in STAGE space, so
  // the mirror is already accounted for and a tilted head tilts its hat the right way.
  _roll(P) {
    let a = P(MESH.eyeL), b = P(MESH.eyeR);
    // Order by STAGE x, not by landmark index. The stage is mirrored, so the landmark
    // MediaPipe calls "left" lands on the right — and measuring right-to-left makes dx
    // negative, which turns a level head into atan2(0, -1) = 180°. Everything mounted on
    // the face was upside down.
    if (a.x > b.x) [a, b] = [b, a];
    return (Math.atan2(b.y - a.y, (b.x - a.x) * this.stage.aspect) * 180) / Math.PI;
  }

  _mountFastener(name) {
    if (!this.face) return null;
    const m = FACE_MOUNTS[name];
    const v = this.camera.video;
    const P = (i) => this.stage.videoNormToStage(this.face[i].x, this.face[i].y, v);

    const pts = m.at.map(P);
    const x = pts.reduce((t, q) => t + q.x, 0) / pts.length;
    const y = pts.reduce((t, q) => t + q.y, 0) / pts.length;

    const a = P(MESH[m.width[0]]), b = P(MESH[m.width[1]]);
    // In fractions of stage HEIGHT, so it means the same as every other size.
    const width = Math.hypot((b.x - a.x) * this.stage.aspect, b.y - a.y) * m.scale;

    return { x, y, size: width, angle: this._roll(P), anchor: m.anchor, fit: 'width' };
  }

  // `leftIndex`, `rightThumb`, … Returns undefined when the name is not a fingertip, so
  // the caller can fall through to the other kinds.
  _fingerFastener(name) {
    const m = name.match(/^(left|right)(Thumb|Index|Middle|Ring|Pinky)$/);
    if (!m) return undefined;
    const h = this.hands[`${m[1]}Hand`];
    if (!h) return null;
    const [below, tip] = FINGERTIPS[m[2]];
    const v = this.camera.video;
    const a = this.stage.videoNormToStage(h[below].x, h[below].y, v);
    const b = this.stage.videoNormToStage(h[tip].x, h[tip].y, v);
    const dx = (b.x - a.x) * this.stage.aspect, dy = b.y - a.y;
    return {
      x: b.x,
      y: b.y,
      // The last segment's length: a puppet on a finger held near the camera gets bigger,
      // which is the same rule every other fastener uses.
      size: Math.hypot(dx, dy) * 2,
      // Along the finger, so a puppet stands up the finger rather than up the screen.
      angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90,
      anchor: 'center',
    };
  }

  // A mount on one edge of a tracked contour, sized to that contour's width.
  _contourMount(name) {
    const m = CONTOUR_MOUNTS[name];
    const pts = this.contour(m.part);
    if (!pts?.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const P = (i) => this.stage.videoNormToStage(this.face[i].x, this.face[i].y, this.camera.video);
    return {
      x: (x0 + x1) / 2,
      y: m.edge === 'top' ? y0 : y1,
      size: (x1 - x0) / this.stage.aspect,
      angle: this._roll(P),
      anchor: m.anchor,
      fit: 'width',
    };
  }

  _faceFastener(part) {
    const pts = this.contour(part);
    if (!pts?.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const v = this.camera.video;
    const P = (i) => this.stage.videoNormToStage(this.face[i].x, this.face[i].y, v);
    // Size in fractions of stage HEIGHT, so it means the same as every other size.
    return {
      x: (x0 + x1) / 2, y: (y0 + y1) / 2,
      size: Math.max(y1 - y0, (x1 - x0) / this.stage.aspect),
      angle: this._roll(P), anchor: 'center',
    };
  }
}
