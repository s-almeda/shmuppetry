// ── Assets ────────────────────────────────────────────────────────────────
// Assets are addressed by the NUMBER IN THE FILENAME — `0002_star.svg` is asset 2 —
// never by position in a listing. 2.5.0 indexed by array position, so inserting or
// renaming one file silently renumbered every scene that referenced it (§2.9).

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

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
