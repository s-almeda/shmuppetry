# CNMAT_openlab — asset list

> **Scenes 2–4 of `script.json` are scratch**, marked `SCRATCH` in their `_note`. They
> exercise the series/provenance/ventriloquy/readout paths against demo art so you can see
> each one work. Delete them once the real script lands.

Drop art in `assets/CNMAT_openlab/` with an `NNN_` prefix. **The only part the rig reads is
the number**; the name after it is for you. Two files sharing a number is ambiguous — the
manifest keys on the number, not the extension.

> **Use the 300–399 band for this show.** Asset numbers are GLOBAL across every folder under
> `assets/`, and they already collide once: `demo/013_miku.png` and `shmidpoint/013_miku.png`
> both claim 13, and the sorted manifest silently picks the later path. demo holds 1–25, 100
> and 901; shmidpoint holds 201–216. 300+ is clear.

Two filename suffixes are load-bearing:

- `_hat` `_glasses` `_nose` `_beard` `_mouth` — mounts the art to that point on the face and
  scales it to head/jaw width, with no `fasten` needed in the scene.
- everything else — no automatic placement; the scene says where it goes.

## art

| # | file | scene | what it is |
|---|---|---|---|
| 301 | `301_.*` | | |
| 302 | `302_.*` | | |

## paintings (provenance in `assets/meta.json`)

Anything shown with a provenance card needs an entry in the top-level `assets/meta.json`,
keyed by the same number:

```json
"301": { "title": "…", "artist": "…", "year": 1782, "medium": "…", "source": "…" }
```

| # | file | title | artist |
|---|---|---|---|
| | | | |

## ventriloquy puppets

A puppet that bounces and changes frame on your voice is an ordinary image with two extra
fields, so it still takes `fasten` and can ride your hand:

```json
{ "type": "image", "fasten": "leftHand", "src": 330, "talkSrc": 331, "bounce": 0.07 }
```

`bounce` is a fraction of stage height (2.5.0 used 0.07). Needs the mic, which this show's
`micOnStart` grabs from the *"it's showtime!"* click. Number the pair adjacently.

| # | rest frame | talk frame | scene |
|---|---|---|---|
| | | | |

## masks (face-aligned)

A mask is an ordinary image with `"align": "face"`. Its own face is scanned once in the panel
(**scan face**) and stored as a `face` record in `assets/meta.json`, so at showtime nothing
extra loads. A mask *series* is just `srcs` — each entry looks up its own face box.

Two ways to step one: `"cycleKey": "]"` for a keypress, or `"cycleOn": "reacquire"` to
advance whenever the tracker loses your face and finds it again — swipe a hand past your
face and the next mask is on when it recovers. `breakMs` (default 120) is how long the face
must be gone to count; raise it if ordinary head-turns are triggering cycles.

| # | file | scanned? | notes |
|---|---|---|---|
| | | | |

## video

Recordings play as ordinary `image` objects — `makeMediaEl` returns a `<video>` for
`.mp4` / `.webm` / `.mov`. Full-frame with sound:

```json
{ "type": "image", "src": 310, "fit": "cover", "z": -50, "audio": true }
```

`audio: true` is required — videos are muted unless a scene opts in.

| # | file | scene | what it is |
|---|---|---|---|
| 310 | `310_artographer.*` | | past-show recording |
| 311 | `311_aitl.*` | | past-show recording |

## already supplied, nothing to do

| # | file | what it is |
|---|---|---|
| 5 | `assets/demo/005_circus_theme.mp3` | circus theme, if this show wants it |
| 100 | `assets/demo/0100_spotlight.svg` | soft-edged white circle, used via `maskedBy` as a spotlight. Alpha only — never appears on stage itself |
