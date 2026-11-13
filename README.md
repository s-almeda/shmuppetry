# shmuppetry 3.0

shm's puppet theatre presentation rig! 

building upon [shmuppetry 2.5.0](https://github.com/s-almeda/shmspace) but making it more flexibly object-oriented-y. the architecture is built around the metaphor of a **stage**, on which any number of **objects** (like props, actors) can appear at a scripted position (specified as an x, y, and z (for layering) coordinate and with transforms (rotation, flip) applied) 

There is also support for creating and controlling assets via webcam+CV-driven puppet shenanigans!! webcam feed(s) are an object that can appear on stage, as are the objects we can cut out of a webcam feed using hand and face tracking CV + image segmentation. And (to support the actual puppeteering) any on stage object can have its position manipulated/derived from the coordinate of a recognized hand/face object captured by the webcam (this is true whether the webcam feed image is being displayed on "stage" or not)

A presentation is written as a **script** (ex: ``script.json``). A script is made of **scenes**, which are themselves each a JSON object with a list of what is on stage, including (optionally) a **character name** and their **dialogue** which will appear in the dialogue text box (but any arbitrary text appearing wherever is also possible). 
Nov 2026 update: shm added the capability to import slides from keynote, which can be interspersed between puppet scenes. 

The rig also wears skins. (by default, it uses my favorite css framework, **xp.css** from unpkg)

## credits

- Thank you to Peter Sobot for **[keynote-parser](https://github.com/psobot/keynote-parser)**  (and Sean Patrick O'Brien for [his work documenting the iWork File Format](https://github.com/obriensp/iWorkFileFormat/blob/master/Docs/index.md))---we use this in `scripts/import-keynote.py` to import `.key` files into readable YAML and then into puppet rig compatible slides!

-------
### some of the text below is claude produced. pardon my slop.
## running the rig

```
node server/dev-server.js        # → http://localhost:8000
node scripts/check.mjs           # smoke check — run this before a show
```

`check.mjs` loads every module, resolves every scene of every show, constructs every object and asserts `serialize()` is a fixed point.


For the public demo version (live and accessible via shmuh.co/shmuppetry), any static host works; GitHub Pages serves from `/<repo>/`;
```
node scripts/build-manifests.js  # bakes the asset listing for static hosting
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

Any object with a `cycleKey` steps its own `srcs` list on that key — the scripts use `]` —
and `Shift` steps it backward. The binding is per-object, so two puppets can cycle on
different keys. `p` toggles the potato detector's manual fallback.

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

An image can also be a **ventriloquy puppet** — `talkSrc` swaps the frame while you speak and
`bounce` hops it, both driven by mic level. They are two ordinary fields rather than a
separate puppet system, so the thing still takes `fasten` and can ride your hand:

```json
{ "type": "image", "fasten": "leftHand", "src": 330, "talkSrc": 331, "bounce": 0.07 }
```

Camera and mic are separate permission grants, so a show that needs both sets
`"micOnStart": true` in its config and *"it's showtime!"* asks for them together.

That is the whole persistence model. 2.5.0 had five different ones — toggles sticky, `stage`
sticky-but-absolute, `potato` reset every scene, `drawingClear` one-shot, `leftPuppet` reset
but `puppetSize` sticky — each defensible alone and unlearnable together.

Coordinates are **normalized**: `x`/`y` are `0..1` of the stage, and `size` is a fraction of
stage *height*, so a composition holds its proportions at every window size and aspect.
Named positions (`CENTER`, `LEFT`, `RIGHT`, …) take structured offsets: `{ "at": "LEFT", "dx": 0.05 }`.

`cue` is a line for **you**, shown in the presenter view as what Space is about to do —
`{ "id": 7, "cue": "cycle ] through the flags", "objects": { … } }`. Like `_note` it does
not inherit. Without one, the presenter view works the hint out from the diff.

### presenter view

`control.html?show=<name>` is a second window for the laptop screen while the rig runs
fullscreen on the projector: a live mirror of the rig tab (click **mirror the rig tab** and
pick it in Chrome's share dialog) plus what the next Space will change and where every
cycling series is. It loads no models, and keys still go to the rig window.

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

### metadata

`assets/meta.json` holds what a file cannot say about itself, keyed by the same number:

```json
"301": { "title": "Self-Portrait in a Straw Hat", "artist": "Élisabeth Vigée Le Brun",
         "year": 1782, "medium": "oil on canvas", "source": "National Gallery, London",
         "face": { "x": 0.35, "y": 0.18, "w": 0.28, "h": 0.3, "roll": -2.4 } }
```

Keyed by number rather than path, so renaming the file keeps its record. Two things read it:

- **A textbox with `metaFrom` and `template`** fills `{title}`, `{artist}`, … from whatever art
  the named image object is *currently* showing — so a provenance card follows a `srcs`
  series as you cycle it, instead of being retyped into every scene. An empty field
  collapses rather than leaving a stray comma behind.
- **`align: "face"` art** uses the `face` box. Plain `fasten: "face"` centres the whole
  picture, which is right for a hat and wrong for a portrait whose face sits in the upper
  third; `align` puts the art's own face on the tracked one, at its scale and roll. A mask
  *series* is therefore just an ordinary `srcs` list — each entry finds its own box.

A series can also be stepped by **breaking the tracking** rather than by a key —
`cycleOn: "reacquire"` advances every time the fastener drops and comes back, so swiping a
hand past your face changes the mask, and the cut hides inside the moment your face is
occluded anyway. `breakMs` (default 120) is how long it must be gone to count; a single
dropped detection is normal and never fires it.

Select an image in the panel and the **asset N · metadata** group edits its record, with
**scan face** to find the box and sliders to nudge it. Scanning runs MediaPipe in `IMAGE`
mode — deliberately not the face-api nets `facelabel.js` already has loaded, because the two
report different crops and the live fastener measures the face oval. Nothing extra loads at
showtime: the scan happens while authoring and the result is what ships.

The metadata file **is** committed, even though the art is not. Provenance is the part worth
keeping.

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

## slides

A talk can be one script: puppet scenes and slides interleaved, no app switch. A slide is
an ordinary scene with `"slide": true` whose objects are `text` (style `slide`), `image`,
`video` and `shape`. Keynote is authoring only — `scripts/import-keynote.py` reads a
`.key` once and writes these scenes; after that the deck lives here.

- **Magic Move**: `"transition": { "effect": "magicMove", "dur": 0.7 }` on a scene tweens
  every object that keeps its id from the previous scene. Same id = linked. A kept id with
  a new `src` crossfades; ids that leave fade out; new ids fade in.
- **Transitions**: `fade`, `dissolve`, `wipe`, `move`, `push`, each with `dir` and `dur`.
  No `transition` is a hard cut, so puppet shows behave exactly as before.
- **Builds**: `"in": { "effect": "wipe", "dir": "right", "dur": 0.6, "step": 2 }` and
  `"out": …` on any object. Effects: fade, dissolve, move, fadeMove, wipe, pulse, pop,
  scale, keyboard (typewriter), lineDraw (shapes). Space / → play the next step before the
  next scene; ← undoes one; Shift+arrows skip straight between scenes. `dir` is the
  direction of travel: `up`, `down`, `left`, `right`, `upLeft`, `upRight`, `downLeft`,
  `downRight`.
- **Actions**: builds that CHANGE something already on stage, on the same steps.
  On an object: `"actions": [{ "step": 2, "set": { "src": 331, "x": 0.3 }, "dur": 0.4 }]`
  — numbers glide, a new picture crossfades, anything else switches. Or an emphasis that
  changes nothing: `{ "step": 3, "effect": "pulse", "amount": 1.1 }` (also `jiggle`,
  `blink`). On the scene itself, for its flags: `"actions": [{ "step": 1, "set":
  { "freeze": true } }]`. The next scene inherits the result; ← undoes it. Edit mode
  shows the scene as written, with every action undone.
- **Editor**: `editor.html?show=<name>` — timeline on the left (puppet runs collapse into
  one box), the real stage in the middle, inspector on the right. Drag to move, corner
  handle to resize, double-click text to type, rename an id to link it. ⌘S saves the
  whole script through the dev server; ⌘D duplicates a slide.
- **Import**: `sh scripts/try-keynote-parser.sh` once (installs keynote-parser into
  `.venv-kp`), then `.venv-kp/bin/python3 scripts/import-keynote.py deck.key <show>`.
  `--into --after <sceneId>` splices into an existing show; `--png` flattens slides with
  tables/charts via Keynote; `--dry` prints without writing. The report lists what was
  approximated. `shows/slidetest` exercises every feature by hand.

