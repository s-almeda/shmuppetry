#!/usr/bin/env node
// ── Paper tile generator ──────────────────────────────────────────────────
// Run ONCE; the output is committed. This is not a tool page — it exists as provenance
// for how assets/textures/paper-tile.png was made, so it can be re-run with different
// numbers if the paper ever needs to change.
//
//   node scripts/make-paper.js
//
// Produces a tile that is:
//   · SEAMLESS by construction — value noise on a WRAPPING lattice, so the left edge is
//     literally the same lattice row as the right. Not a scan with its seam patched.
//   · GREYSCALE — paper grain carries no colour information worth 3 channels.
//   · MEAN ~128 — so `overlay` adds texture without shifting exposure. Overlay lightens
//     above mid-grey and darkens below it, which is what lets ONE pass replace the old
//     brighten-then-darken pair.
//   · SMALL — 128px square. Noise barely deflates, so the file is roughly its pixel
//     count; there is no point paying for resolution nobody sees at 20% opacity.
//
// Also writes paper-tile-preview.png: the tile laid 3×3, so seams are obvious.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;

// Grain character. FIBRE adds the faint directional streaking real paper has; without it
// the result reads as television static rather than as a sheet.
const OCTAVES = [
  { cells: 4, amp: 1.0 },    // broad blotching, the unevenness of a sheet
  { cells: 8, amp: 0.5 },
  { cells: 16, amp: 0.28 },
  { cells: 32, amp: 0.16 },
  { cells: 64, amp: 0.09 },  // fine tooth
];
const FIBRE = { cells: 96, amp: 0.35, stretch: 6 };
const CONTRAST = 26;   // final standard deviation, in 0–255 units

// Deterministic hash → the tile is reproducible, so re-running gives the same paper.
function rand(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);

// Value noise on a lattice that WRAPS at `cells`, which is what makes the tile seamless:
// sampling past the last cell returns to the first.
function noise(u, v, cells, seed) {
  const x = u * cells, y = v * cells;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const wrap = (n) => ((n % cells) + cells) % cells;
  const x1 = wrap(x0 + 1), y1 = wrap(y0 + 1), xa = wrap(x0), ya = wrap(y0);
  const a = rand(xa, ya, seed), b = rand(x1, ya, seed);
  const c = rand(xa, y1, seed), d = rand(x1, y1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function build() {
  const n = SIZE * SIZE;
  const raw = new Float64Array(n);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      let value = 0;
      OCTAVES.forEach((o, i) => { value += (noise(u, v, o.cells, i + 1) - 0.5) * o.amp; });
      // Fibres: the same noise sampled with a stretched axis, so it streaks.
      value += (noise(u * FIBRE.stretch, v, FIBRE.cells, 99) - 0.5) * FIBRE.amp;
      raw[y * SIZE + x] = value;
    }
  }

  // Normalise: mean to exactly 0, then scale to the target contrast, then centre on 128.
  // Doing this numerically rather than by eye is the whole reason `overlay` stays neutral.
  const mean = raw.reduce((t, v) => t + v, 0) / n;
  let variance = 0;
  for (const v of raw) variance += (v - mean) ** 2;
  const sd = Math.sqrt(variance / n) || 1;

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(128 + ((raw[i] - mean) / sd) * CONTRAST)));
  }
  return out;
}

// ── Minimal greyscale PNG writer ──────────────────────────────────────────
// Colour type 0 (greyscale), 8-bit. No image library: zlib is in the standard library and
// a PNG is four chunks with a CRC each.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(pixels, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 0;    // colour type: greyscale
  // Each scanline is prefixed with a filter byte; 0 = none. Noise defeats the predictive
  // filters anyway, so there is nothing to gain from the others.
  const rows = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (w + 1)] = 0;
    Buffer.from(pixels.subarray(y * w, (y + 1) * w)).copy(rows, y * (w + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Run ───────────────────────────────────────────────────────────────────
const tile = build();
const dir = path.join(ROOT, 'assets', 'textures');
fs.mkdirSync(dir, { recursive: true });

const file = path.join(dir, 'paper-tile.png');
fs.writeFileSync(file, png(tile, SIZE, SIZE));

// 3×3 preview, so seams are visible at a glance rather than only once it is on a cutout.
const P = SIZE * 3;
const preview = new Uint8Array(P * P);
for (let y = 0; y < P; y++) {
  for (let x = 0; x < P; x++) preview[y * P + x] = tile[(y % SIZE) * SIZE + (x % SIZE)];
}
const previewFile = path.join(dir, 'paper-tile-preview.png');
fs.writeFileSync(previewFile, png(preview, P, P));

// Report the numbers the tile is supposed to hit, so a bad one is obvious without opening it.
const mean = tile.reduce((t, v) => t + v, 0) / tile.length;
let variance = 0;
for (const v of tile) variance += (v - mean) ** 2;
console.log(`${path.relative(ROOT, file)}  ${SIZE}×${SIZE}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
console.log(`  mean ${mean.toFixed(1)} (want ~128 — off means overlay will shift exposure)`);
console.log(`  sd   ${Math.sqrt(variance / tile.length).toFixed(1)} (grain strength)`);
console.log(`  range ${Math.min(...tile)}–${Math.max(...tile)}`);
console.log(`${path.relative(ROOT, previewFile)}  3×3 tiled — check for seams`);
