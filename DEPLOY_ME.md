# DEPLOY_ME — shmuppetry demo on GitHub Pages

The public read-only demo. **It is already live.** This file is the loop for keeping it
current, plus what to check before and after you push.

| | |
|---|---|
| **live URL** | <https://s-almeda.github.io/shmuppetry/> |
| **repo** | `s-almeda/shmuppetry` |
| **source** | branch `main`, folder `/ (root)` — no build step, no `gh-pages` branch |
| **public show** | `demo` (the default when no `?show=` is given) |
| **as of 2026-09-14** | live is **2 commits behind** local `main` (`9b2b886`, `e7ad53a`) |

Why root-of-main works with no CI: the page is plain ES modules, every path is relative, and
`.nojekyll` (already committed at the repo root) stops Jekyll from eating `_`-prefixed and
underscore paths. There is nothing to build except the asset manifest.

---

## 0. one time only — confirm the Pages setting

You almost certainly did this already (the URL answers 200). Verify at:

<https://github.com/s-almeda/shmuppetry/settings/pages>

- **Source**: `Deploy from a branch`
- **Branch**: `main` · `/ (root)`

`gh` is not installed on this machine, so this one is the web UI. Everything below is CLI.

---

## 1. the deploy loop — every time you want the public page updated

```bash
cd ~/Projects/shmuppetry

# 1. bake the PUBLIC asset manifest (demo/ only, and only what git actually tracks)
node scripts/build-manifests.js

# 2. smoke check — must print "all good"
node scripts/check.mjs

# 3. see exactly what you are about to publish
git status --short
git diff --stat
```

Then commit and push (**you run these — I never commit**):

```bash
git add -A
git commit -m "deploy: <what changed>"
git push origin main
```

Pages rebuilds in ~30–90s. Watch it:

```bash
open https://github.com/s-almeda/shmuppetry/actions
```

> **`build-manifests.js` with no flags is the deploy-correct invocation.** It bakes only
> `assets/demo/` *and* only files git tracks, so the public page can never advertise an
> asset that isn't there. Never commit the output of `--all` — that manifest lists your
> whole local library and the public page would 404 its way through it.

---

## 2. TEST BEFORE YOU PUSH

Run locally exactly the way the public gets it. The dev server is fine for the first two,
but do at least one pass on a **static** server, because the dev server hides the two
failure modes that only exist in production.

```bash
# the authoring rig (dev server: live manifest + write routes)
node server/dev-server.js
open "http://localhost:8000/?show=demo"

# the PUBLIC simulation (no dev server: baked manifest, no write routes)
node scripts/build-manifests.js
python3 -m http.server 8001
open "http://localhost:8001/?show=demo"
```

Static-server pass is the one that matters. Checklist:

- [ ] `node scripts/check.mjs` prints **all good**
- [ ] page paints before the camera prompt; **"it's showtime!"** appears
- [ ] camera grant works, webcam fills the stage
- [ ] `→` / `←` walk all 4 demo scenes; `Space` finishes a typing line then advances
- [ ] scene 2 — paper cutouts on your face and hands
- [ ] scene 3 — spotlights: the red curtain shows *only* through your hands
- [ ] scene 4 — BricolMage: tophat on right hand, body on your mouth
- [ ] showcase toggles in the panel (hands / heads / fingers / drawing / facebox / potato) each
      switch on without a console error — these lazy-load models from CDN
- [ ] **the panel offers no "save scene" / edit section** on `:8001` — that is the proof the
      public build is read-only by construction
- [ ] browser console: **zero 404s** and zero red errors
- [ ] `?nocam` still lays out ( `open "http://localhost:8001/?show=demo&nocam"` )
- [ ] narrow the window hard — normalized coords should hold the composition

Deep-link sanity, since these are the URLs you'll paste on your website:

```bash
open "http://localhost:8001/?show=demo&scene=3"
open "http://localhost:8001/?show=demo&nocam"
```

---

## 3. TEST AFTER YOU PUSH

**Hard-reload** — GitHub Pages caches aggressively and a stale `main.js` will make you
debug a bug you already fixed. `Cmd+Shift+R`, or an incognito window.

```bash
open "https://s-almeda.github.io/shmuppetry/"
```

Confirm from the terminal that what's live is what you pushed:

```bash
# every URL the public page needs — all must be 200
for p in "" assets/manifest.json assets/meta.json shows/demo/config.json \
         shows/demo/script.json js/main.js css/base.css \
         assets/demo/008_red_curtain.png assets/demo/0100_spotlight.svg; do
  printf '%3s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://s-almeda.github.io/shmuppetry/$p")" "/$p"
done

# and that the live script is byte-identical to the commit you pushed
curl -s https://s-almeda.github.io/shmuppetry/shows/demo/script.json \
  | diff - <(git show origin/main:shows/demo/script.json) && echo "live == origin/main"
```

Then in the browser:

- [ ] camera prompt appears and is granted (Pages is HTTPS, so `getUserMedia` is allowed)
- [ ] all 4 scenes, same as the local pass
- [ ] showcase toggles work — these pull MediaPipe / face-api / the potato ONNX from CDN,
      which is the one thing localhost can mask if you were offline
- [ ] no "save scene" anywhere in the panel
- [ ] console: no 404s
- [ ] try it on your phone once — the layout is normalized, but the camera prompt differs

---

## 4. how to update it later

Same loop. Three cases:

**Changed the demo script or a demo asset** — art must go in `assets/demo/` and must be
*committed*, or the baked manifest drops it:

```bash
node scripts/build-manifests.js   # re-bake, or the new art is invisible publicly
node scripts/check.mjs
git add -A && git commit -m "demo: …" && git push origin main
```

**Changed engine code (`js/`, `css/`, `index.html`)** — no manifest re-bake needed, but run
the static pass, because absolute paths and missing write routes only bite in production:

```bash
node scripts/check.mjs
git add -A && git commit -m "…" && git push origin main
```

**Saved a demo scene through the editor** — the editor writes the fully-resolved absolute
scene back to `shows/demo/script.json`. Read the diff before committing; a save rewrites far
more of the file than you changed:

```bash
git diff shows/demo/script.json
```

### rolling back

```bash
git revert <sha> && git push origin main      # preferred — keeps history
```

---

## 5. TODOs / known sharp edges

Ordered by how likely each is to bite.

- [ ] **`@mediapipe/tasks-vision@latest` is unpinned** — [tracking.js:11](js/tracking.js#L11).
      A breaking upstream release silently kills hands + face tracking on the public page,
      with nothing in the repo having changed. Pin it to the version you've tested:
      `@mediapipe/tasks-vision@0.10.x`. This is the single biggest public-uptime risk.
- [ ] **`shows/index.json` advertises local-only shows.** `build-manifests.js` regenerates it
      from every folder under `shows/`, so `CNMAT_openlab`, `shmidpoint` and
      `stochastic_final` are listed publicly — but their art is gitignored, so
      `?show=CNMAT_openlab` renders an empty stage. Harmless today (nothing reads
      `index.json` yet, and `demo` is the default), but it becomes a broken link the moment
      a directory page exists. Decide: filter non-public shows out of the baked
      `index.json`, or add a `"public": true` flag to config.
- [ ] **Potato model is served from the old repo** —
      `cdn.jsdelivr.net/gh/s-almeda/shmspace@v2.5.0/…/potato.onnx` ([detector.js:23](js/detector.js#L23)).
      Currently 200, but it is a 2.5.0 tag in a repo you might tidy up. If shmspace ever
      moves, the public potato toggle dies. Consider committing the ONNX here instead.
- [ ] **`005_circus_theme.mp3` is deliberately gitignored** (2.6MB). Nothing in the demo
      script uses it today — if you ever add sound to the demo, it will work locally and be
      silent publicly. Same trap for any new large demo media.
- [ ] **xp.css comes from `unpkg.com` unpinned** — [index.html:9](index.html#L9). Lower stakes
      (the page is readable without it) but it is the same class of problem.
- [ ] **No favicon / no social preview.** You're linking this from your website — add a
      favicon and an `og:image` + `og:description` so the link doesn't unfurl blank.
- [ ] **The demo landing has no context.** A visitor arrives at a camera prompt with no idea
      what the thing is. Consider a line of copy above the stage, or a `?show=demo` scene 0
      that explains it before asking for the camera.
- [ ] **Link it with an explicit show param** from your website — `…/shmuppetry/?show=demo` —
      so changing the runtime default later can't repoint your public link.
