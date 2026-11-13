#!/usr/bin/env node
// ── Smoke check ───────────────────────────────────────────────────────────
// `node scripts/check.mjs`
//
// Not a test suite — a five-second answer to "did I just break the rig?", runnable before
// a show. It catches the failures that are otherwise invisible until the browser: a module
// that no longer loads, a scene that stops resolving, an object that throws on
// construction, and a serialize() that is not a fixed point.
//
// That last one is the reason this file exists. "save scene" writes serialize() output
// straight back into script.json, so if serialize is not stable, saving the same scene
// twice produces two different files — and you find out days later, from a diff.
//
// It runs the real modules under a minimal DOM shim. Anything needing a canvas, a camera
// or a model is out of scope by construction: those need eyes on a browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── DOM shim ──────────────────────────────────────────────────────────────
// Just enough for modules to LOAD and objects to CONSTRUCT. Deliberately not a real DOM:
// if a check starts needing one, that check belongs in a browser instead.
const stub = () => ({
  style: { setProperty() {} },
  classList: { toggle() {}, add() {}, remove() {} },
  appendChild() {}, addEventListener() {}, removeEventListener() {},
  querySelector: () => stub(), setAttribute() {}, remove() {},
  getContext: () => null, textContent: '',
  // makeMediaEl() returns a real <video> for .mp4/.webm/.mov and calls .play().catch() on
  // it straight away, so a stub without these throws the moment any scene puts a video in
  // an image object — including one entry of a `srcs` deck, where the video may not even
  // be the entry on screen. The failure looked like a broken scene rather than a missing
  // shim method, which is exactly the kind of false alarm this file exists to avoid.
  play: () => Promise.resolve(), pause() {}, load() {},
  set innerHTML(v) {}, get innerHTML() { return ''; },
});
globalThis.document = {
  createElement: stub, getElementById: () => null, querySelector: () => null,
  addEventListener() {}, head: stub(), body: { classList: { toggle() {} } },
};
globalThis.window = globalThis;
globalThis.Image = class {};
globalThis.location = { search: '', hostname: 'localhost' };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: {} }, configurable: true });
globalThis.fetch = async () => ({ ok: false, json: async () => null });

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m    ${msg}`);
const bad = (msg) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`); };

// ── 1. every module resolves ──────────────────────────────────────────────
// `node --check` only parses. This resolves the module graph, so importing a name that is
// not exported fails here rather than in the browser console mid-show.
console.log('\nmodules');
const MODULES = ['assets', 'stage', 'scene', 'objects', 'panel', 'tracking',
                 'silhouette', 'detector', 'mic', 'facelabel', 'showcase', 'drawing',
                 'tween', 'builds', 'transition'];
for (const m of MODULES) {
  try { await import(`${ROOT}/js/${m}.js`); ok(`js/${m}.js`); }
  catch (e) { bad(`js/${m}.js — ${e.message}`); }
}
if (failures) { console.log('\nmodules failed to load; skipping the rest.\n'); process.exit(1); }

const { resolveScript } = await import(`${ROOT}/js/scene.js`);
const { TYPES } = await import(`${ROOT}/js/objects.js`);
const { AssetLibrary, fillMeta } = await import(`${ROOT}/js/assets.js`);

const readJSON = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

// ── 2. every show resolves, builds, and round-trips ───────────────────────
console.log('\nshows');
const assets = new AssetLibrary(readJSON(`${ROOT}/assets/manifest.json`, {}),
                                readJSON(`${ROOT}/assets/meta.json`, {}));
// Assets are gitignored per-show, so a missing file is expected here and says nothing
// about correctness. Silence it — an unmissable wall of warnings trains you to ignore
// the output, which defeats the point of running this at all.
const warn = console.warn;
console.warn = (m, ...r) => { if (!/^\[assets\] no asset numbered/.test(String(m))) warn(m, ...r); };

const deps = { assets, domLayer: stub(), paper: {}, find: () => null, list: () => [] };
const shows = fs.readdirSync(`${ROOT}/shows`, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name);

let totalScenes = 0, totalObjects = 0;
for (const show of shows) {
  const script = readJSON(`${ROOT}/shows/${show}/script.json`);
  if (!script) { bad(`${show} — no readable script.json`); continue; }
  let resolved, problems = 0;
  try { resolved = resolveScript(script); }
  catch (e) { bad(`${show} — resolveScript threw: ${e.message}`); continue; }
  if (resolved.length !== script.length) {
    bad(`${show} — ${script.length} scenes in, ${resolved.length} out`); problems++;
  }
  let objects = 0;
  for (const scene of resolved) {
    for (const [id, spec] of Object.entries(scene.objects ?? {})) {
      if (!spec) continue;
      const Type = TYPES[spec.type];
      if (!Type) { bad(`${show} scene ${scene.id} · ${id} — unknown type "${spec.type}"`); problems++; continue; }
      objects++;
      let obj, a, b;
      try { obj = new Type({ ...spec, id }, deps); a = obj.serialize(); }
      catch (e) { bad(`${show} scene ${scene.id} · ${id} (${spec.type}) — ${e.message}`); problems++; continue; }
      // apply(serialize(x)) must serialize identically, or saving a scene twice moves it.
      try { obj.apply({ ...a, id }); b = obj.serialize(); }
      catch (e) { bad(`${show} scene ${scene.id} · ${id} — re-apply threw: ${e.message}`); problems++; continue; }
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        bad(`${show} scene ${scene.id} · ${id} — serialize not stable on [${keys}]`);
        problems++;
      }
    }
  }
  totalScenes += resolved.length; totalObjects += objects;
  if (!problems) ok(`${show} — ${resolved.length} scenes, ${objects} objects round-trip`);
}
console.warn = warn;

// ── 2b. slide objects as page elements ────────────────────────────────────
// Slide scenes build image/video/shape objects with `dom: true` deps. Construction and
// serialize() must behave identically in that mode, or saving from the editor drifts.
console.log('\nslide objects');
{
  const domDeps = Object.create(deps); domDeps.dom = true;
  let n = 0, bads = 0;
  for (const show of shows) {
    for (const scene of resolveScript(readJSON(`${ROOT}/shows/${show}/script.json`, []))) {
      if (!scene.slide) continue;
      for (const [id, spec] of Object.entries(scene.objects ?? {})) {
        const Type = TYPES[spec?.type];
        if (!Type?.domCapable) continue;
        try {
          const a = new Type({ ...spec, id }, deps).serialize();
          const o = new Type({ ...spec, id }, domDeps);
          const b = o.serialize();
          if (!o.isDom) { bad(`${show} scene ${scene.id} · ${id} — not in DOM mode`); bads++; }
          if (JSON.stringify(a) !== JSON.stringify(b)) { bad(`${show} scene ${scene.id} · ${id} — serialize differs in DOM mode`); bads++; }
          n++;
        } catch (e) { bad(`${show} scene ${scene.id} · ${id} (dom) — ${e.message}`); bads++; }
      }
    }
  }
  if (!bads) ok(`${n} slide objects serialize identically as page elements`);
}

// ── 3. asset addressing ───────────────────────────────────────────────────
// Duplicate numbers are the quiet one: the manifest is sorted, so the later path wins and
// a scene silently shows the wrong art.
console.log('\nassets');
{
  const seen = new Map(), dupes = [];
  for (const f of readJSON(`${ROOT}/assets/manifest.json`, {}).files ?? []) {
    const n = parseInt(path.basename(f).match(/(\d+)/)?.[1], 10);
    if (Number.isNaN(n)) continue;
    if (seen.has(n)) dupes.push(`${n}: "${seen.get(n)}" and "${f}"`);
    else seen.set(n, f);
  }
  dupes.length ? dupes.forEach((d) => bad(`duplicate asset number ${d}`))
               : ok(`${seen.size} assets, no duplicate numbers`);

  // An asset number a scene references but the manifest does not have renders NOTHING and
  // logs one line at load. Catching it here is the difference between finding out now and
  // finding out on stage. Uses the on-disk walk, not the committed manifest, because show
  // art is gitignored — the committed one legitimately lists almost none of it.
  const onDisk = new Set();
  const walk = (dir, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '.backups') walk(path.join(dir, e.name), rel); continue; }
      if (!/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a)$/i.test(e.name)) continue;
      if (rel.startsWith('textures/')) continue;         // referenced by path, never numbered
      const n = parseInt(e.name.match(/(\d+)/)?.[1], 10);
      if (!Number.isNaN(n)) onDisk.add(n);
    }
  };
  walk(`${ROOT}/assets`);

  for (const show of shows) {
    const script = readJSON(`${ROOT}/shows/${show}/script.json`, []);
    const missing = new Map();
    for (const scene of script) {
      for (const [id, o] of Object.entries(scene.objects ?? {})) {
        if (!o) continue;
        const refs = [o.src, o.talkSrc, ...(o.srcs ?? []).map((e) => (e && typeof e === 'object' ? e.src : e))];
        for (const r of refs) {
          if (typeof r !== 'number' || onDisk.has(r)) continue;
          if (!missing.has(r)) missing.set(r, []);
          missing.get(r).push(`${scene.id}·${id}`);
        }
      }
    }
    for (const [n, where] of missing) bad(`${show} — asset ${n} not on disk (${where.join(', ')})`);
    if (!missing.size) ok(`${show} — every asset reference resolves`);
  }

  const meta = readJSON(`${ROOT}/assets/meta.json`, {});
  const bogus = Object.keys(meta).filter((k) => !k.startsWith('_') && Number.isNaN(parseInt(k, 10)));
  bogus.length ? bad(`meta.json keys that are not numbers: ${bogus}`)
               : ok(`meta.json — ${Object.keys(meta).filter((k) => !k.startsWith('_')).length} records`);

  // A face box out of range draws the art somewhere off-screen, which reads as "the mask
  // is broken" rather than "the numbers are wrong".
  for (const [k, rec] of Object.entries(meta)) {
    const f = rec?.face;
    if (!f) continue;
    if (!(f.w > 0 && f.h > 0) || [f.x, f.y, f.w, f.h].some((v) => v < -1 || v > 2)) {
      bad(`meta.json ${k} — face box out of range ${JSON.stringify(f)}`);
    }
  }
}

// ── 4. metadata templating ────────────────────────────────────────────────
// A missing field must collapse, not print "undefined" or strand a comma on a title card.
console.log('\ntemplating');
{
  const T = '{title}\n{artist}, {year}\n{medium}';
  const cases = [
    [{ title: 'A', artist: 'B', year: 1, medium: 'C' }, 'A\nB, 1\nC'],
    [{ title: 'A', artist: 'B', medium: 'C' }, 'A\nB\nC'],
    [{ title: 'A' }, 'A'],
    [null, ''],
  ];
  let bads = 0;
  for (const [meta, want] of cases) {
    const got = fillMeta(T, meta);
    if (got !== want) { bad(`fillMeta(${JSON.stringify(meta)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); bads++; }
  }
  if (!bads) ok(`${cases.length} template cases, empty fields collapse cleanly`);
}

// ── 5. break-to-cycle timing ──────────────────────────────────────────────
// `cycleOn: "reacquire"` has to survive a dropped detection but fire on a real swipe, and
// the gap between those two is small enough to be worth pinning down.
console.log('\nbreak-to-cycle');
{
  const mk = (spec) => new TYPES.image(
    { id: 'm', type: 'image', fasten: 'face', srcs: [1, 2, 3], cycleOn: 'reacquire', ...spec },
    { assets: { get: () => null, mount: () => null, meta: () => null }, mic: null });
  const run = (o, steps) => { for (const [live, dt] of steps) { o._pinLive = live; o.update(dt, 0, null); } return o.index ?? 0; };
  const F = 16;                                   // ~one frame at 60fps
  const lost = (n) => Array(n).fill([false, F]);
  const cases = [
    ['a single dropped frame does not cycle', mk({}), [[true, F], [false, F], [true, F]], 0],
    ['a ~200ms break cycles once', mk({}), [[true, F], ...lost(12), [true, F]], 1],
    ['three breaks wrap around', mk({}), [[true, F], ...lost(12), [true, F], ...lost(12), [true, F], ...lost(12), [true, F]], 0],
    ['staying broken does not repeat', mk({}), [[true, F], ...lost(60)], 0],
    ['breakMs 500 ignores a 200ms break', mk({ breakMs: 500 }), [[true, F], ...lost(12), [true, F]], 0],
    ['breakMs 500 accepts a 600ms break', mk({ breakMs: 500 }), [[true, F], ...lost(38), [true, F]], 1],
    ['cycleOn unset never cycles', mk({ cycleOn: undefined }), [[true, F], ...lost(30), [true, F]], 0],
  ];
  let bads = 0;
  for (const [name, obj, steps, want] of cases) {
    const got = run(obj, steps);
    if (got !== want) { bad(`${name} — index ${got}, expected ${want}`); bads++; }
  }
  // Booting with no face in frame must not count as a reacquire.
  const boot = mk({}); boot.update(F, 0, null); boot.update(F, 0, null);
  if ((boot.index ?? 0) !== 0) { bad('an undefined pin cycles on boot'); bads++; }
  if (!bads) ok(`${cases.length + 1} timing cases`);
}

console.log(failures
  ? `\n\x1b[31m${failures} problem(s).\x1b[0m\n`
  : `\n\x1b[32mall good\x1b[0m — ${shows.length} shows, ${totalScenes} scenes, ${totalObjects} objects.\n`);
process.exit(failures ? 1 : 0);
