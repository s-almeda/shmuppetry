// ── Silhouette ────────────────────────────────────────────────────────────
// Segments the hand from the webcam frame, producing a MASK rather than a polygon.
//
// Implements "Lightweight real-time hand segmentation leveraging MediaPipe landmark
// detection" (Virtual Reality, 2023) — https://doi.org/10.1007/s10055-023-00858-0
//
//   1. landmarks → draw the hand skeleton                       → M1
//   2. strongly dilate M1                                       → M2  (region bound)
//   3. convert the frame to CIELab, keep only pixels under M1
//   4. sample those pixels, take Q1..Q3 of a* and b*            → Mab (in-range pixels)
//   5. closing then opening of (Mab ∪ M1)                       → M3  (fill, denoise)
//   6. M3 ∩ M2                                                  → the hand
//
// Why this beats measuring widths along rays, which is what this file used to do:
//
// - The colour range is DERIVED, not tuned. Quartiles of the pixels under the skeleton
//   describe how this hand actually varies across itself, in this light, this frame. A
//   single reference pixel plus a threshold never could, and that threshold was the
//   parameter we spent the longest failing to tune.
// - a*/b* carry no luminance, so shading across the palm and creases between fingers do
//   not read as edges.
// - A region can express concavities and holes; a ray finds one boundary per direction.
//   The closing step is what properly resolves the gaps between fingers.
// - M2 is the leak guard, and it is hand-shaped rather than a fixed radius: nothing
//   outside a dilated skeleton can survive, so the face behind your hand cannot bleed in.
//
// REQUIRED BEHAVIOUR: a closed hand merges into one shape and a fist is a single blob
// (a paper cutout of a closed hand has merged fingers). The closing step and M2 both
// push toward that, so it comes out of the pipeline rather than needing a special case.

export const PALM = [0, 1, 2, 5, 9, 13, 17];
export const FINGERS = [
  [1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
];
// Bones drawn for M1, including the palm so the skeleton samples palm colour too.
const BONES = [
  ...FINGERS.flatMap((c) => c.slice(0, -1).map((a, i) => [a, c[i + 1]])),
  [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
];

const BUFFER_EDGE = 160;   // long edge of the working buffer; everything is per-pixel here
const SAMPLES = 150;       // colour samples under the skeleton (the paper says 1500,
                           // their published code uses 150)

const canvas2d = (w = 1, h = 1) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

export class Silhouette {
  constructor(camera) {
    this.camera = camera;
    this.frame = canvas2d();     // the cropped video
    this.skel = canvas2d();      // M1, drawn as strokes
    this.out = canvas2d();       // the finished mask, as alpha
    this.fctx = this.frame.getContext('2d', { willReadFrequently: true });
    this.sctx = this.skel.getContext('2d', { willReadFrequently: true });
    this.octx = this.out.getContext('2d');
    this.prev = new Map();       // hand → smoothed radii
  }

  drop(name) { this.prev.delete(name); }

  /**
   * @returns {{canvas: HTMLCanvasElement, rect: object}|null} mask as alpha, plus the
   *          video-space rect it covers.
   */
  compute(name, hand, p) {
    const video = this.camera.video;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !hand) return null;

    const pt = (i) => [hand[i].x * vw, hand[i].y * vh];
    const wrist = pt(0), midTip = pt(12);
    const span = Math.hypot(midTip[0] - wrist[0], midTip[1] - wrist[1]);
    if (span < 4) return null;

    // Crop to the hand, padded by the bound. Cropping is what keeps this cheap and
    // precise: everything below is per-pixel over this small buffer only.
    const pad = p.bound * span;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 21; i++) {
      const [x, y] = pt(i);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(vw, Math.ceil(x1 + pad)); y1 = Math.min(vh, Math.ceil(y1 + pad));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 8 || ch < 8) return null;

    const scale = BUFFER_EDGE / Math.max(cw, ch);
    const w = Math.max(8, Math.round(cw * scale));
    const h = Math.max(8, Math.round(ch * scale));
    const n = w * h;
    for (const c of [this.frame, this.skel, this.out]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }

    // ── 1. M1: the skeleton ───────────────────────────────────────────────
    const B = (i) => { const [x, y] = pt(i); return [(x - x0) * scale, (y - y0) * scale]; };
    const sg = this.sctx;
    sg.clearRect(0, 0, w, h);
    sg.strokeStyle = '#fff';
    sg.lineCap = sg.lineJoin = 'round';
    sg.lineWidth = Math.max(2, p.skeleton * span * scale);
    sg.beginPath();
    for (const [a, b] of BONES) { sg.moveTo(...B(a)); sg.lineTo(...B(b)); }
    sg.stroke();

    const skelPx = sg.getImageData(0, 0, w, h).data;
    let M1 = new Uint8Array(n);
    for (let i = 0; i < n; i++) M1[i] = skelPx[i * 4 + 3] > 40 ? 1 : 0;
    M1 = dilate(M1, w, h, 1);   // their 3×3 pre-dilation of the skeleton

    // ── 2. M2: strongly dilated M1 — the region the hand may occupy ───────
    // Their 21×21 kernel at 2 iterations is ~20px on a hand spanning ~250px, so `bound`
    // wants to be around 0.08–0.12 of hand span. Much looser than that and skin-coloured
    // things elsewhere in frame get room to survive.
    const M2 = dilate(M1, w, h, p.bound * span * scale);

    // ── 3. the frame in CIELab (a*, b* only — no luminance) ───────────────
    this.fctx.drawImage(video, x0, y0, cw, ch, 0, 0, w, h);
    const px = this.fctx.getImageData(0, 0, w, h).data;
    const A = new Float32Array(n), Bch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [a, b] = labAB(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      A[i] = a; Bch[i] = b;
    }

    // ── 4. quartiles of the pixels under the skeleton → the colour range ──
    const sa = [], sb = [];
    const stride = Math.max(1, Math.floor(n / (SAMPLES * 2)));
    for (let i = 0; i < n; i += stride) if (M1[i]) { sa.push(A[i]); sb.push(Bch[i]); }
    if (sa.length < 12) return null;
    const [aLo, aHi] = quartiles(sa, p.range);
    const [bLo, bHi] = quartiles(sb, p.range);

    const M3 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      M3[i] = (M1[i] || (A[i] >= aLo && A[i] <= aHi && Bch[i] >= bLo && Bch[i] <= bHi)) ? 1 : 0;
    }

    // ── 5. closing, then opening, then a final grow ───────────────────────
    // The published code dilates once more (7×7) after the opening, before clipping to
    // M2 — a step the paper's description omits. It recovers the hand's outer edge, which
    // the colour range tends to cut inside of.
    const k = Math.max(1, p.clean * span * scale);
    let mask = erode(dilate(M3, w, h, k), w, h, k);      // closing
    mask = dilate(erode(mask, w, h, k), w, h, k);        // opening
    if (p.grow) mask = dilate(mask, w, h, p.grow * span * scale);

    // ── 6. keep only the blob that touches the skeleton ───────────────────
    // The paper ANDs with M2, but M2 is generous by design, so anything skin-coloured
    // inside it survives — a face behind the hand comes through as detached blobs. A
    // flood fill seeded from the skeleton keeps only pixels actually CONNECTED to the
    // hand, which removes them outright.
    for (let i = 0; i < n; i++) mask[i] &= M2[i];
    mask = connectedTo(M1, mask, w, h);

    const img = this.octx.createImageData(w, h);
    for (let i = 0; i < n; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = mask[i] * 255;
    }
    this.octx.putImageData(img, 0, 0);

    // ── the polygon ───────────────────────────────────────────────────────
    // TRACE the mask's boundary, then resample it to a fixed number of points at equal
    // arc length. Not radial sampling from a centre: that assumes the shape is
    // star-shaped, and a hand with one finger raised over a closed fist is not — adjacent
    // angles hit wildly different distances and the outline zigzags across the palm.
    //
    // Equal arc-length resampling is what keeps this smoothable. The COUNT is fixed and
    // the ORDER is stable, so vertex k means the same part of the hand from frame to
    // frame and blending it with the last frame is meaningful.
    const contour = trace(mask, w, h);
    if (!contour || contour.length < 8) return null;

    const N = Math.max(8, Math.round(p.points ?? 40));
    let poly = resample(contour, N);

    // Anchor the parameterisation to the wrist, so vertex 0 is always the same place on
    // the hand. Without this the trace's arbitrary start point drifts and the smoothing
    // averages one part of the hand with another.
    const wristB = B(0);
    let best = 0, bestD = Infinity;
    for (let k = 0; k < N; k++) {
      const d = (poly[k][0] - wristB[0]) ** 2 + (poly[k][1] - wristB[1]) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    poly = poly.slice(best).concat(poly.slice(0, best));

    // Temporal smoothing, per vertex.
    let prev = this.prev.get(name);
    if (!prev || prev.length !== N) { prev = poly.map((q) => q.slice()); this.prev.set(name, prev); }
    const sm = p.smooth ?? 0;
    for (let k = 0; k < N; k++) {
      prev[k][0] = prev[k][0] * sm + poly[k][0] * (1 - sm);
      prev[k][1] = prev[k][1] * sm + poly[k][1] * (1 - sm);
    }

    // Buffer space → video pixels, which is what the renderer maps to the stage.
    const out = prev.map(([bx, by]) => [x0 + bx / scale, y0 + by / scale]);

    return { canvas: this.out, polygon: out, rect: { x0, y0, x1, y1, vw, vh } };
  }
}

// sRGB → CIELab, a* and b* only. Luminance is deliberately discarded: shading across the
// palm and creases between fingers must not read as colour differences.
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function labAB(r, g, b) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const R = lin(r), G = lin(g), Bl = lin(b);
  const x = f((R * 0.4124 + G * 0.3576 + Bl * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + Bl * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + Bl * 0.9505) / 1.08883);
  return [500 * (x - y), 200 * (y - z)];
}

// Q1..Q3 of the sampled values, optionally widened. Their code widens by a factor of
// 0.025 — i.e. essentially raw Q1..Q3 — so `widen` of 1 is the published behaviour, and
// anything much above it starts accepting background.
function quartiles(values, widen = 1) {
  values.sort((a, b) => a - b);
  const q1 = values[Math.floor(values.length * 0.25)];
  const q3 = values[Math.floor(values.length * 0.75)];
  const mid = (q1 + q3) / 2, half = ((q3 - q1) / 2) * widen;
  return [mid - half, mid + half];
}

// Moore-neighbour boundary tracing: walk the outside of the blob, one pixel at a time,
// always turning as tightly as possible. Returns the boundary in order.
const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
function trace(mask, w, h) {
  let start = -1;
  for (let i = 0; i < w * h; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return null;
  const sx = start % w, sy = (start / w) | 0;
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]);

  const contour = [[sx, sy]];
  let cx = sx, cy = sy;
  let bx = sx - 1, by = sy;          // the start is leftmost on its row, so this is background
  const limit = 4 * (w + h);         // a blob's boundary cannot be longer than this
  for (let step = 0; step < limit; step++) {
    let idx = N8.findIndex(([dx, dy]) => cx + dx === bx && cy + dy === by);
    if (idx < 0) idx = 0;
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const [dx, dy] = N8[(idx + k) % 8];
      const nx = cx + dx, ny = cy + dy;
      if (at(nx, ny)) {
        const [px, py] = N8[(idx + k - 1) % 8];
        bx = cx + px; by = cy + py;   // the background cell we came past
        cx = nx; cy = ny;
        moved = true;
        break;
      }
    }
    if (!moved) break;                // isolated pixel
    if (cx === sx && cy === sy) break;
    contour.push([cx, cy]);
  }
  return contour;
}

// Resample a closed contour to exactly `n` points, spaced evenly along its length. Fixed
// count and stable order are what make the result smoothable frame to frame.
export function resample(contour, n) {
  const m = contour.length;
  const cum = [0];
  for (let i = 1; i <= m; i++) {
    const a = contour[i - 1], b = contour[i % m];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[m];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (j < m && cum[j + 1] < target) j++;
    const a = contour[j], b = contour[(j + 1) % m];
    const segment = cum[j + 1] - cum[j] || 1;
    const t = (target - cum[j]) / segment;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Flood fill `mask` from every pixel of `seed`, keeping only the connected blob(s) that
// the seed touches. This is what removes skin-coloured blobs elsewhere in frame — they
// are not connected to the hand's skeleton, so they simply never get visited.
function connectedTo(seed, mask, w, h) {
  const out = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < seed.length; i++) if (seed[i] && mask[i]) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0 && mask[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && mask[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && mask[i - w] && !out[i - w]) { out[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && mask[i + w] && !out[i + w]) { out[i + w] = 1; stack.push(i + w); }
  }
  return out;
}

// Morphology via a chamfer distance transform, so the cost is independent of the radius —
// a naive square kernel at these radii would be far too slow per frame.
function distance(binary, w, h, inside) {
  const D = new Float32Array(w * h);
  const BIG = 1e9;
  for (let i = 0; i < D.length; i++) D[i] = (!!binary[i] === inside) ? 0 : BIG;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let d = D[i];
    if (x > 0) d = Math.min(d, D[i - 1] + 1);
    if (y > 0) d = Math.min(d, D[i - w] + 1);
    if (x > 0 && y > 0) d = Math.min(d, D[i - w - 1] + 1.414);
    if (x < w - 1 && y > 0) d = Math.min(d, D[i - w + 1] + 1.414);
    D[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let d = D[i];
    if (x < w - 1) d = Math.min(d, D[i + 1] + 1);
    if (y < h - 1) d = Math.min(d, D[i + w] + 1);
    if (x < w - 1 && y < h - 1) d = Math.min(d, D[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) d = Math.min(d, D[i + w - 1] + 1.414);
    D[i] = d;
  }
  return D;
}

function dilate(m, w, h, r) {
  const D = distance(m, w, h, true);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = D[i] <= r ? 1 : 0;
  return out;
}

function erode(m, w, h, r) {
  const D = distance(m, w, h, false);   // distance to the nearest background pixel
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = D[i] > r ? 1 : 0;
  return out;
}
