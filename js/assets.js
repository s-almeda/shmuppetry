// ── Assets ────────────────────────────────────────────────────────────────
// Assets are addressed by the NUMBER IN THE FILENAME — `0002_star.svg` is asset 2 —
// never by position in a listing. 2.5.0 indexed by array position, so inserting or
// renaming one file silently renumbered every scene that referenced it (§2.9).

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

// Placement baked into the filename — `001_beret_hat.png` mounts at the hat. Carried
// over from 2.5.0, where it was one of the few things that genuinely worked (§7):
// the asset says where it goes, so a scene only has to name the asset.
const MOUNTS = ['hat', 'glasses', 'nose', 'beard', 'mouth'];
export function parseMount(file) {
  const base = String(file).replace(/\.[^.]+$/, '').toLowerCase();
  return MOUNTS.find((m) => base.endsWith('_' + m)) ?? null;
}

// Returns an <img> or a looping muted <video> from one call, so every code path that
// takes an asset handles both without caring which it got (§8.7).
export function makeMediaEl(src) {
  const remote = /^https?:\/\//i.test(src);
  if (VIDEO_EXT.test(src)) {
    const v = document.createElement('video');
    if (remote) v.crossOrigin = 'anonymous';
    Object.assign(v, { src, loop: true, muted: true, autoplay: true, playsInline: true });
    v.play().catch(() => {});
    return v;
  }
  const img = new Image();
  // Only meaningful if the host sends Access-Control-Allow-Origin. Without it a remote
  // image still displays but taints the canvas, breaking the pixel reads the cutout
  // work will eventually want.
  if (remote) img.crossOrigin = 'anonymous';
  img.src = src;
  return img;
}

// <img> exposes .complete; <video> exposes .readyState. Require real dimensions too —
// .complete is true for a failed load.
export const isReady = (el) =>
  !!(el && (el.complete || el.readyState >= 2) && (el.naturalWidth || el.videoWidth));

export const naturalSize = (el) => ({
  w: el.naturalWidth ?? el.videoWidth,
  h: el.naturalHeight ?? el.videoHeight,
});

// Prepare a scanned texture for blending: greyscale, with its mean shifted to exactly
// mid-grey. `overlay` lightens above 128 and darkens below it, so a scan with an overall
// tone would push the whole image lighter or darker instead of just adding texture.
//
// Contrast is left alone deliberately — that IS the wrinkles and folds. Only the overall
// exposure is neutralised, so the structure of the paper survives intact.
export function neutralize(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);

  const image = g.getImageData(0, 0, c.width, c.height);
  const px = image.data;
  const n = c.width * c.height;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    lum[i] = l;
    sum += l;
  }
  const mean = sum / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, Math.round(128 + (lum[i] - mean))));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  return c;
}

export class AssetLibrary {
  constructor(manifest) {
    this.base = manifest?.base ?? './assets/';
    this.byNumber = new Map();
    this.cache = new Map();
    for (const file of manifest?.files ?? []) {
      const n = parseInt(file.match(/(\d+)/)?.[1], 10);
      if (Number.isNaN(n)) { console.warn(`[assets] "${file}" has no number in its name — not addressable`); continue; }
      this.byNumber.set(n, file);
    }
  }

  // The mount baked into an asset's filename, if it has one.
  mount(ref) {
    const file = typeof ref === 'number' ? this.byNumber.get(ref) : ref;
    return file ? parseMount(file) : null;
  }

  // Accepts a manifest number (2) or a direct path/URL, so a one-off asset never needs
  // a manifest entry to be usable.
  src(ref) {
    const file = typeof ref === 'number' ? this.byNumber.get(ref) : ref;
    if (file == null) { console.warn(`[assets] no asset numbered ${ref}`); return null; }
    return /^(https?:)?\/\/|^\.{1,2}\//.test(file) ? file : this.base + file;
  }

  // Cached by resolved src, so the same art on two objects is one download, one decode.
  get(ref) {
    const src = this.src(ref);
    if (!src) return null;
    if (!this.cache.has(src)) this.cache.set(src, makeMediaEl(src));
    return this.cache.get(src);
  }
}
