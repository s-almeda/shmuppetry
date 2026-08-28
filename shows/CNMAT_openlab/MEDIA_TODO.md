# CNMAT_openlab — media to make

**51 placeholders** are standing in right now. Every one of them renders, so the
show runs end to end today — these are all `.svg` colour blocks with the name written on them.

## how to replace one

Drop the real file in `assets/CNMAT_openlab/` with the **same `NNN_` number prefix**, then
**delete the `.svg`**. Two files sharing a number is ambiguous — the manifest keys on the
number, not the extension, and the sorted listing silently picks one. The name after the
number is for you; the rig only reads the number.

Nothing else needs editing: the scenes reference numbers, so filenames can change freely.

## videos
Drop as `.mp4` or `.webm`. They play as ordinary full-frame objects with `audio: true`. Consecutive scenes reuse the same object, so the video keeps playing across them rather than restarting.

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 340 | `340_aitl.svg` | 44, 46 | full-frame slide |
| 341 | `341_annotation1.svg` | 51, 52 | full-frame slide |
| 342 | `342_annotation2.svg` | 65, 66 | full-frame slide |
| 343 | `343_artographer.svg` | 74, 75 | full-frame slide |
| 344 | `344_artographer_gen.svg` | 80 | full-frame slide |

## portraits — historical (scene 33)
Eight, cycled as face masks by breaking the tracking. **Scan each one** with the panel's **scan face** button after dropping it in, or it will centre instead of registering to your face.

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 317 | `317_historicalportrait1.svg` | 33 | face MASK series |
| 318 | `318_historicalportrait2.svg` | 33 | face MASK series |
| 319 | `319_historicalportrait3.svg` | 33 | face MASK series |
| 320 | `320_historicalportrait4.svg` | 33 | face MASK series |
| 321 | `321_historicalportrait5.svg` | 33 | face MASK series |
| 322 | `322_historicalportrait6.svg` | 33 | face MASK series |
| 323 | `323_historicalportrait7.svg` | 33 | face MASK series |
| 324 | `324_historicalportrait8.svg` | 33 | face MASK series |

## portraits — shm's own (scene 37)
Six of your own mirror self-portraits. Same face-scan note as above.

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 350 | `350_shm_mirror_charcoal.svg` | 37 | face MASK series |
| 351 | `351_shm_mirror_oil.svg` | 37 | face MASK series |
| 352 | `352_shm_mirror_ink.svg` | 37 | face MASK series |
| 353 | `353_shm_mirror_pastel.svg` | 37 | face MASK series |
| 354 | `354_shm_mirror_paint.svg` | 37 | face MASK series |
| 355 | `355_shm_mirror_digital.svg` | 37 | face MASK series |

## talking puppets (paired frames)
Each is a **rest + talk pair**: the talk frame is the same drawing with the mouth moved. The rig swaps to it above the mic threshold and hops the puppet on your voice.

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 309 | `309_sock_rest.svg` | 14, 15, 17, 18, 19 | on leftHand; on rightHand |
| 310 | `310_sock_talk.svg` | 14, 15, 17, 18, 19 | TALK frame |
| 313 | `313_mcluhan_rest.svg` | 29 | prop |
| 314 | `314_mcluhan_talk.svg` | 29 | TALK frame |
| 327 | `327_berger_rest.svg` | 49, 50 | on leftHand |
| 328 | `328_berger_talk.svg` | 50 | TALK frame |

## logos & screenshots

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 300 | `300_bjorn_drawing.svg` | 6, 73 | series; on leftHand |
| 301 | `301_eecs_logo.svg` | 6 | series |
| 302 | `302_adobe_research.svg` | 9 | series |
| 303 | `303_mj_lab.svg` | 9 | series |
| 304 | `304_jacobs.svg` | 10 | series |
| 308 | `308_stochastic_logo.svg` | 13 | on leftHand |
| 325 | `325_flock.svg` | 41 | on leftHand |
| 330 | `330_wapo_datawork.svg` | 56 | on leftHand |
| 331 | `331_sd_headline.svg` | 57 | on leftHand |
| 333 | `333_smithsonian.svg` | 88 | on leftHand |
| 338 | `338_libraries_museums.svg` | 69 | prop |

## photos & artwork

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 305 | `305_bart_costume1.svg` | 11 | series |
| 306 | `306_bart_costume2.svg` | 11 | series |
| 307 | `307_tiat.svg` | 11 | series |
| 315 | `315_bpigment.svg` | 7 | series |
| 316 | `316_cse.svg` | 8 | series |
| 326 | `326_ways_of_seeing.svg` | 48 | on leftHand |
| 334 | `334_map.svg` | 89 | full-frame slide |
| 335 | `335_bierstadt1.svg` | 81, 82 | on leftHand; prop |
| 336 | `336_bierstadt2.svg` | 82 | prop |
| 337 | `337_bierstadt3.svg` | 82 | prop |

## signs & props
`312_chair_beard` **must keep the `_beard` suffix** — that is what hangs it off your chin at jaw width. Same idea as `_hat`.

| # | placeholder file | scene(s) | how it is used |
|---|---|---|---|
| 311 | `311_mic.svg` | 26, 27 | on rightHand |
| 312 | `312_chair_beard.svg` | 26, 27 | on face.beard |
| 329 | `329_in_the_weeds.svg` | 54 | on leftHand |
| 332 | `332_snailbunny.svg` | 87 | on leftHand |
| 360 | `360_spotlight_cone.svg` | 26, 27, 29 | prop |

## already real, nothing to do

| # | file | used for |
|---|---|---|
| 1 | `demo/001_beret_hat.png` | the artist beret — already says "artist" on it |
| 100 | `demo/0100_spotlight.svg` | soft spotlight circles on your hands (scene 2) |
| 203 | `shmidpoint/203_stochastic_labs_hat.png` | stochastic labs party hat |
| 204 | `shmidpoint/204_red_curtain.png` | the curtain |
| 209 | `shmidpoint/209_drumroll_sign.svg` | "drumroll please" — itself still a placeholder |
| 216 | `shmidpoint/216_cane.png` | the cane, final scene |

## priorities

1. **The five videos** — they are whole scenes. Without footage those beats are a title card.
2. **Sock puppets (309/310)** — the reveal of the whole show, scene 14.
3. **McLuhan + Berger pairs** — the two other talking characters.
4. **The fourteen portraits** — bulk work, and each needs a face scan after import.
5. Everything else is a still that reads fine as a placeholder in a run-through.
