# stochastic_final — production notes

**This show needs one asset: the cane.** Everything else in `script.json` is text, the
webcam, or a cutout of you.

| # | file | scene | what it is |
|---|---|---|---|
| 216 | `assets/shmidpoint/216_cane.png` | 27 | the hook, on your right hand |

Asset numbers are **global across every folder** under `assets/`, so a show can reach another
show's art by number without copying it — which is why `"src": 216` works from here. The cost
is a dependency: scene 27 goes blank if shmidpoint's folder ever leaves your disk. If you
would rather this show owned it, copy the file to `assets/stochastic_final/416_cane.png` and
change `src` to `416`.

The cane is a **wide** image (845×142, about 6:1), and for a hand-pinned puppet `size` is a
multiple of the *measured hand span* rather than a fraction of the stage — so `size: 1` puts
it at roughly two-thirds of the frame's width. Drag it in the panel.

## shape

| scenes | what |
|---|---|
| 1 | opens on camera — "I'd like to read you a poem" |
| 2–11 | **the poem**, one line added per scene, white on black |
| 12 | hard cut back to camera — "I've got a list of topics" |
| 13–25 | **the topic slips**, one `topic.text` change per scene |
| 23–24 | the five-faces beat, inside the topics |
| 26 | the worn label, no other textbox |
| 27 | curtain call — default xp.css box, cane on your right hand |
| 28 | the end card |

Scenes are **sparse** and should stay that way while you are writing: omitting a field
changes nothing, `null` removes, `"reset": true` starts from an empty stage. Saving a scene
through the panel fattens it into a fully-resolved absolute scene — that is expected and
harmless, but read the diff, because a save rewrites far more of the file than you changed.

## the poem — scenes 2–11

Each scene adds exactly one line and **restates nothing**.

```json
{ "id": 7, "objects": { "poem6": { "type": "text", "style": "poem",
    "x": 0.5, "y": 0.525, "z": 200, "width": 0.9, "instant": true, "text": "…" } } }
```

**The fade is CSS, and there is no fade feature in the engine.** The object pool keys on the
object's id: a line inherited from the previous scene keeps the very same DOM element and is
updated in place, while a line the scene *adds* is constructed fresh — and a CSS animation
runs on element creation. So the new line animates, the standing lines do not, and nothing in
JS has to know what "new" means. Stepping back disposes the removed line's element, so
stepping forward again fades it in a second time; the poem is rehearsable, not one-shot.

Two rules that follow from that, and matter:

- **Never re-state an existing line with different text in a later scene.** That is an
  *update*, not a creation, so it changes without fading. Give it a new id instead.
- **`"instant": true` on every line.** The typewriter re-runs whenever `text` changes, and a
  poem line that types itself out is one you wait on instead of read.

### layout

Ten lines, three stanzas. Spacing is `0.075` inside a stanza and wider between them — that
gap *is* the stanza break, so keep it if you re-space.

| stanza | lines | y |
|---|---|---|
| 1 | poem1–4 | 0.13, 0.205, 0.28, 0.355 |
| 2 | poem5–9 | 0.45, 0.525, 0.60, 0.675, 0.75 |
| 3 | poem10 | 0.845 |

Ten is about the most the frame holds at this spacing. The longest line — *"I make myself a
home in every seat I sit in three times,"* — is what sets the type size: at `0.95em` and
`width: 0.9` it stays on **one** line at 16:9 and wider. A much squarer window wraps it and
it will crowd poem2. If you ever perform on a narrow screen, drop `font-size` in the skin's
`.textbox-poem` rule rather than re-spacing every line's `y`.

To add a line: copy a block, give it the next unused id, step `y` by `0.075`.

## the topic slips — scenes 13–25

Scene 13 places the slip; **every scene after it changes one field and nothing else**:

```json
{ "id": 14, "objects": { "topic": { "text": "shmuppetry rig updates" } } }
```

That is why the slip does not move, flicker, or resize as you step through thirteen topics —
and why scenes 22, 23 and 24 are guaranteed to show *identical* text without it being typed
out three times and drifting apart.

`header` style: skinny centred cardstock at the top of the frame, Comic Sans, no speaker tab,
`instant: true`. It is a reminder to you that the audience can also read — not dialogue. Drop
`y` to `0.8` if you would rather it sat at the bottom, or give it a degree or two of `tilt` if
dead-straight reads too typeset.

## the five faces — scenes 23–24

```json
"face3": { "type": "bodyPart", "fasten": "face", "x": -0.26, "y": 0.20,
           "z": 20, "scale": 0.62, "rotation": 14 }
```

`fasten: "face"` means x/y are **offsets from your actual head**, so the whole flock follows
you as you move rather than sitting at fixed points on the stage. `part` defaults to whatever
you are pinned to, so each one cuts your face and wears your face.

Cheap, and worth knowing why: a face part is cut from the **landmark contour**, not from the
colour-segmentation pipeline the hands use. Five faces cost five polygon builds, not five
silhouette solves — this beat will not stutter the way five hand cutouts would.

Scene 24 nulls all five and says nothing about `topic`, so the text stands untouched while
the flock vanishes. That is the beat: the joke stops, the sentence does not.

Tune the scatter by dragging x/y in the panel and hitting **save scene**.

## the worn label — scene 26

```json
"hatlabel": { "type": "text", "style": "hathead", "fasten": "hat",
              "x": 0, "y": -0.02, "z": 60, "width": 0.24, "instant": true,
              "tilt": -1.5, "text": "very silly guy" }
```

A TextBox goes through the same `placeDom` an image does, which is why puppeting a line of
text needs no new machinery at all. Nudge `y` more negative to float it higher off your head.

## the skin

`css/skins/stochastic_final.css` adds three `style` values on top of the default treatment.
It **`@import`s `default.css` as its first rule** — the skin `<link>` is replaced wholesale by
`main.js` rather than stacked, so deleting that import takes the entire default treatment
with it, and `@import` is only legal before any other statement.

| style | scenes | what it is |
|---|---|---|
| `speech` | 1, 12 | the rig's own xp.css box — translucent beige, speaker as a tab. From `default.css`, not added here. |
| `header` | 13–25 | skinny centred cardstock slip, Comic Sans, no speaker tab, fits its own text |
| `hathead` | 26 | the same slip in lined white with a slight drop shadow, worn via `fasten: "hat"` |
| `poem` | 2–11 | one white line of plain Arial on black, nothing drawn around it, fades in |
| `papertalk` | — | a paper *dialogue* box in Comic Sans. Unused; one field away if a scene wants it. |
| `endcard` | 28 | "the end" — white Comic Sans, dead centre, nothing drawn around it |

**Nothing in this show is cursive.** `default.css`'s own `paper` style leads with
PlaywriteCU — the joined handwriting face — which is the BricolMage's voice in CNMAT_openlab
and shmidpoint. This skin never uses it: the font stack everywhere here is
`'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', sans-serif`, with a `sans-serif` generic
rather than `cursive` so even a machine missing all three cannot fall back to script.

`papertalk` exists because of that. It is `paper` — cardstock sheet, lined-paper scrap for
the speaker, four lines reserved so the box cannot grow under the audience mid-line — but in
Comic Sans. It is a **new style rather than an edit to `paper`** because `.textbox-paper`
lives in `default.css`, which two other shows load, and restyling it there would be a
costume change they never asked for.

The poem is deliberately bare: `background`, `border`, `box-shadow` and `text-shadow` are all
reset to nothing. Each of those is overriding something real — `.textbox .textbox-text`
paints a beige panel and a 1px rule, and xp.css frames `[role=tabpanel]`, which is what that
element is. The poem scenes remove the webcam, so the stage behind is truly black and white
type needs no shadow to separate from it; a glow there reads as an outline around the words.

The poem's text is **lowercase in `script.json` itself**, not forced with `text-transform`.
A CSS transform would leave the real text capitalised, so the panel's in-place editor and
any later copy-paste would disagree with what is on stage.

## capabilities

`config.json` declares **`face` and `hands`**. Everything listed there loads eagerly at boot,
and per-frame inference that nothing needs is exactly what starves the typewriter — so this
list is worth re-checking whenever a scene is cut.

- `face` — the five cutouts (23) and the worn label (26)
- `hands` — the cane (27), and that is its only use in the show

A fastener with no tracker behind it simply never pins: the cane would silently not exist
rather than erroring. Same trap in reverse if you paste the deck below back in.

## parked: the 13-image left-hand deck

Not used anywhere in the current script. Kept here because it works and you asked for it —
paste it into whichever scene it belongs to.

```json
"deck": { "type": "image", "fasten": "leftHand", "size": 1.1, "z": 30,
          "cycleKey": "]", "index": 0,
          "srcs": [401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413] }
```

Thirteen images riding your left hand, stepped manually with `]` (and `shift-]` backward).
The binding is per-object, so a second deck can live on `[` and the two never interfere. An
entry can also be an object of per-entry overrides — `{ "src": 404, "size": 1.6, "y": -0.1 }`
— because puppets are not interchangeable and a wide one and a tall one want different scales
on the same hand. Videos work as entries and restart each time they come round; add
`"audio": true` on the object if one should be heard.

Art goes in `assets/stochastic_final/` with an `NNN_` prefix. **Use the 400–499 band** —
asset numbers are global across every folder under `assets/`, and they already collide once
(`demo/013_miku.png` and `shmidpoint/013_miku.png` both claim 13). demo holds 1–25, 100 and
900–901; shmidpoint holds 201–216; CNMAT_openlab holds 300–360 and 901.

### ⚠️ filename suffixes bite full-frame decks

`_hat` `_glasses` `_nose` `_beard` `_mouth` at the end of a filename mount that art to that
point on the face automatically, with no `fasten` in the scene. Convenient for a prop; a trap
for a deck.

An image with **no fastener** re-derives its mount from its filename **on every `]` press**,
so one `413_diagram_mouth.png` in a thirteen-slide deck snaps the whole slide onto your chin
the moment you reach it — and only then. Two defences, use both:

1. Never end a full-frame slide's filename with one of those five words.
2. Write `"fasten": null` **explicitly** on any unfastened deck. Omitting the field is not the
   same as naming it — the auto-mount only runs when the field is absent.

A fastened deck (`"fasten": "leftHand"`, above) is immune: a truthy fastener is never
overwritten.
