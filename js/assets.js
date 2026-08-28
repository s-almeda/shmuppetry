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

// Substitute `{key}` from a metadata record. Same shape as facelabel.js's fill(): a key
// that is missing or empty collapses to nothing rather than printing "undefined", so a
// painting with no known year reflows instead of leaving a stray comma behind.
//
// Punctuation orphaned by an empty field is swept up afterwards — that is the whole reason
// this is not a one-line replace. A card reading "Vigée Le Brun, " is worse than one
// reading "Vigée Le Brun".
export function fillMeta(template, meta) {
  if (template == null) return '';
  return String(template)
    .replace(/\{(\w+)\}/g, (_, k) => {
      const v = meta?.[k];
      return v == null || v === '' ? '' : String(v);
    })
    // Collapse the gaps an empty field leaves, per LINE — a provenance card is written as
    // several lines and they must not run together.
    .split('\n')
    .map((line) => line
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*([,;·—–-])\s*(?=$|[,;·—–-])/g, '')   // separator with nothing after it
      .replace(/^\s*[,;·—–-]\s*/, '')                    // …or nothing before it
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .trim())
    .filter((line, i, all) => line !== '' || (i > 0 && i < all.length - 1 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

export class AssetLibrary {
  // `meta` is the parsed assets/meta.json — provenance, plus the `face` box that
  // `align: "face"` art is registered by. Optional: a show with no metadata boots
  // identically, every lookup simply returns null.
  constructor(manifest, meta = null) {
    this.base = manifest?.base ?? './assets/';
    this.byNumber = new Map();
    this.numberOf = new Map();   // reverse: manifest path → number
    this.byMeta = new Map();
    this.cache = new Map();
    for (const file of manifest?.files ?? []) {
      const n = parseInt(file.match(/(\d+)/)?.[1], 10);
      if (Number.isNaN(n)) { console.warn(`[assets] "${file}" has no number in its name — not addressable`); continue; }
      this.byNumber.set(n, file);
      this.numberOf.set(file, n);
    }
    for (const [k, v] of Object.entries(meta ?? {})) {
      if (k.startsWith('_')) continue;          // `_note` and friends, as everywhere else
      const n = parseInt(k, 10);
      if (Number.isNaN(n)) { console.warn(`[assets] meta key "${k}" is not a number — ignored`); continue; }
      this.byMeta.set(n, v);
    }
  }

  // The asset NUMBER for a number or a path. Returns null for anything unaddressable —
  // a data:/blob: upload has no number, and the digits inside a base64 payload must never
  // be mistaken for one.
  numberFor(ref) {
    if (typeof ref === 'number') return Number.isFinite(ref) ? ref : null;
    if (typeof ref !== 'string') return null;
    if (/^data:|^blob:/i.test(ref)) return null;
    const bare = ref.replace(this.base, '');
    if (this.numberOf.has(bare)) return this.numberOf.get(bare);
    const n = parseInt(bare.split('/').pop()?.match(/(\d+)/)?.[1], 10);
    return Number.isNaN(n) ? null : n;
  }

  // The metadata record for an asset, or null. Keyed by number rather than path, so
  // renaming `301_portrait.png` to `301_vigee_lebrun.png` keeps its provenance.
  meta(ref) {
    const n = this.numberFor(ref);
    return n == null ? null : this.byMeta.get(n) ?? null;
  }

  // Metadata is authored live in the panel, so the record has to be creatable in place.
  ensureMeta(ref) {
    const n = this.numberFor(ref);
    if (n == null) return null;
    if (!this.byMeta.has(n)) this.byMeta.set(n, {});
    return this.byMeta.get(n);
  }

  // The whole store, back in meta.json's on-disk shape, for the save route.
  serializeMeta() {
    const out = {
      _note: 'Asset metadata, keyed by the number in the filename — the same addressing as manifest.json. `face` records are written by the panel’s scan button; everything else is yours.',
    };
    for (const n of [...this.byMeta.keys()].sort((a, b) => a - b)) {
      const rec = this.byMeta.get(n);
      if (rec && Object.keys(rec).length) out[String(n)] = rec;
    }
    return out;
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
    // `data:` and `blob:` are how a visitor's own uploaded puppet arrives. Without them
    // here an upload becomes "./assets/data:image/png;base64,…" and silently 404s. No
    // real asset filename can begin with either scheme, so this cannot shadow one.
    return /^(https?:)?\/\/|^data:|^blob:|^\.{1,2}\//.test(file) ? file : this.base + file;
  }

  // Cached by resolved src, so the same art on two objects is one download, one decode.
  get(ref) {
    const src = this.src(ref);
    if (!src) return null;
    if (!this.cache.has(src)) this.cache.set(src, makeMediaEl(src));
    return this.cache.get(src);
  }
}
