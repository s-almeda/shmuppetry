# shmuppetry 3.0

A paper puppet theatre that runs on a webcam.

A general **stage** on which any number of **objects** appear at positions, each with a
transform and a `z`. Scenes are JSON listing what is on stage. The webcam, the dialogue box,
background art, props, and later the cut-out pieces of the puppeteer's own body are all *the
same kind of thing* — a positioned object — rather than separate features with separate
toggles.

Ground-up rebuild of [shmuppetry 2.5.0](https://github.com/s-almeda/shmspace). The design
brief is [PORTING_TO_3.0.md](PORTING_TO_3.0.md); section references throughout the code point
back at it.

**Status: spine step 1.** Stage, transforms, one render loop, scene player, control panel,
with `image` / `webcam` / `text` as the only object types. Loads no ML models at all.
Steps 2 (bindings) and 3 (body parts + paper cutouts) are not built yet.

## run it

```
node server/dev-server.js        # → http://localhost:8000
```

No build step, no `npm install`. Plain ES modules and Node's standard library. The only
external thing the page loads is **xp.css** from unpkg, which is the default skin.

For the public read-only version, any static host works — the page is written to run from a
subdirectory, so GitHub Pages serving from `/<repo>/` is fine:

```
node scripts/build-manifests.js  # bake the asset listing for static hosting
```

### URL params

| param | effect |
|---|---|
| `?show=<name>` | load `shows/<name>/` (default: `demo`) |
| `?scene=<n>` | open on scene *n*. Safe to jump anywhere — the script resolves from scene 0 up front, so scene *n* is identical however you got there |
| `?nocam` | skip the camera prompt. For laying out a scene, or screenshotting without a camera |

### keys

`Space` finishes the current line if it is still typing, otherwise advances.
`→` / `←` step scenes. The panel (top right) and scene pill (top left) appear on hover.

## how a scene works

A script is an array of sparse scenes. **A scene resolves to the complete stage**: it inherits
the previous scene's resolved stage, applies its patch, and that is what you see.

```json
{ "id": 3,
  "objects": {
    "star": { "type": "image", "src": 2, "at": { "at": "RIGHT", "dx": 0.02 }, "size": 0.3, "z": 10 },
    "line": { "text": "so it can move." },
    "cam":  null
  } }
```

There are exactly two rules, and the runtime enforces them uniformly:

- **`null` removes** an object.
- **omitting anything changes nothing.**

Plus `"reset": true` to start from an empty stage instead of inheriting.

That is the whole persistence model. 2.5.0 had five different ones — toggles sticky, `stage`
sticky-but-absolute, `potato` reset every scene, `drawingClear` one-shot, `leftPuppet` reset
but `puppetSize` sticky — each defensible alone and unlearnable together.

Coordinates are **normalized**: `x`/`y` are `0..1` of the stage, and `size` is a fraction of
stage *height*, so a composition holds its proportions at every window size and aspect.
Named positions (`CENTER`, `LEFT`, `RIGHT`, …) take structured offsets: `{ "at": "LEFT", "dx": 0.05 }`.

`_note` is preserved everywhere and ignored by the engine. Use it. Writing the usage notes
into the artifact is why 2.5.0 was still legible months later.

## authoring

Edit mode appears only when the page is on **loopback and the dev server answers**. On a
static host neither holds, so the public version is read-only by construction — the write
routes simply do not exist, and every one of them rejects non-loopback requests anyway.

Hover the panel, pick an object, adjust it, **save scene**. Save writes the *fully resolved
absolute* scene back to `shows/<show>/script.json`, so a saved scene becomes self-contained.
Hand-authored scenes stay sparse until you save through the editor.

Every object serializes itself, so anything on stage round-trips — including object types
that don't exist yet. In 2.5.0 the save button knew a fixed list of fields, which is why most
feature state could never survive it.

## assets

Assets are addressed by the **number in the filename** — `0001_backdrop.svg` is asset `1`.
Never by position in a listing: 2.5.0 indexed by array position, so inserting or renaming one
file silently renumbered every scene that referenced it.

Show assets are **not in git** — shows are performed locally, so they never need hosting.
Only `assets/demo/` is committed, for the public page. The dev server generates
`assets/manifest.json` live from disk; `build-manifests.js` bakes the committed one. The
client requests the same path either way and cannot tell which it got.

## layout

```
index.html            window chrome + boot markup
js/
  main.js             boot, wiring, camera, status bar
  stage.js            coordinates, cover-fit, mirroring, the render loop
  scene.js            sparse → absolute resolution, object pool, player
  objects.js          StageObject · image · webcam · text
  panel.js            control panel, generic inspector, edit mode
  assets.js           number-keyed manifest, makeMediaEl
css/base.css          window chrome + panel (adapted from 2.5.0 puppet_rig.css)
css/skins/            swappable per-show look
shows/<name>/         script.json + config.json
server/dev-server.js  static files + loopback-guarded write routes
```

## a few things that are load-bearing

- **Mirroring is resolved once**, at the video→stage boundary in `stage.js`. Stage space is
  never mirrored. In 2.5.0 the webcam was CSS-mirrored, so every overlay canvas was too, so
  every text and image draw needed its own `ctx.scale(-1,1)` un-flip.
- **`canvas.width = x` clears the canvas**, even when `x` is unchanged. `getBoundingClientRect()`
  is fractional, so comparing it raw against the integer `canvas.width` differs every frame.
  `stage.sync()` rounds first and assigns only on a real change.
- **The typewriter runs on the frame clock**, not `setTimeout`. Heavy work must never be able
  to starve it — in 2.5.0 per-frame inference stuttered it badly enough that some scenes had
  to force instant dialogue.
- **Every path is relative.** GitHub Pages serves from `/<repo>/`, so an absolute path 404s
  there and only there — it works perfectly right up until deploy.
