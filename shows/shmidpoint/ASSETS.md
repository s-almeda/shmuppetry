# shmidpoint — asset list

Every number below already has a **coloured placeholder** in `assets/shmidpoint/`, so the
whole show runs end to end right now. To supply real art:

> Drop the file in `assets/shmidpoint/` with the **same `NNN_` prefix**, then **delete the
> `.svg` placeholder**. Two files sharing a number is ambiguous — the manifest keys on the
> number, not the extension.

The name after the number is for you, not the rig — the only part that matters is the
number, and the `_hat` / `_beard` suffix where noted.

| # | file | scene | what it is |
|---|---|---|---|
| 201 | `201_dogbubble.*` | 3 | left-hand puppet, 1st in the `]` cycle |
| 202 | `202_loss.*` | 3 | left-hand puppet, 3rd in the cycle |
| 203 | `203_stochastic_labs_hat.*` | 4 | **keep `_hat`** — the suffix is what mounts it to the crown and scales it to head width |
| 204 | `204_red_curtain.*` | 14, 18, 34 | backdrop. Seen through the spotlights in 14, full-frame from 18, and pulled down over everything in 34 |
| 205 | `205_marquee.*` | 18 | hand-drawn sign, "THE AMAZING SHMIDPOINT PRESENTATION!" |
| 206 | `206_tophat.*` | 20, 21 | held by a hand in 20, then pinned above the mouth from 21 |
| 207 | `207_bricolbody_beard.*` | 20+ | BricolMage's little body with legs, hanging off the bottom lip. **keep `_beard`** |
| 209 | `209_drumroll_sign.*` | 11 | white lettering "drumroll please" on transparent — puppeted by your left hand |
| 211–215 | `vero` `joel` `tiffany` `ace` `max` | 36 | one per fingertip, left hand, thumb→pinky |
| 216 | `216_cane.*` | 37 | there is a real one at `shmspace/public/puppets/hand_puppets/stochastic_intro/029_cane.png` — copy it in as `216_cane.png` |

## Already supplied, nothing to do

| # | file | scene |
|---|---|---|
| 4 | `assets/demo/004_willsmith.webm` | 3 — 2nd in the `]` cycle |
| 5 | `assets/demo/005_circus_theme.mp3` | 13, 18, 29, 33 |
| 100 | `assets/demo/0100_spotlight.svg` | 14 — soft-edged white circle, used as a mask. It is alpha only, so it never appears on stage itself |

## Music cue points

One file, two cues, both already in `script.json`:

- **scene 13** — drumroll, `from: 11`, looping `11 → 14`
- **scene 18** — main theme, `from: 15`, looping `16 → 82` (1:22)

The audio object keeps its id across scenes, so the pool updates it in place rather than
rebuilding it — which is what lets the theme survive every scene change from 18 to 29, and
29 → 33 stop and restart it without reloading.
