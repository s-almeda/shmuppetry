# UIUC_2026 — asset map

The rig runs the **intro only**; the rest of the talk is Keynote.

Asset numbers are **global** across every folder under `assets/`, so `"src": 302` works from
this show without copying anything. This show's own entries live in `assets/UIUC_2026/` in the
**500–599 band**, and every one of them is a **symlink** into the 2.5.0 rig at
`~/Projects/shmspace/public/puppets/` — nothing is duplicated. `ls -l assets/UIUC_2026` shows
where each points. The cost: if shmspace moves, these go blank.
A new file you add here can be a real file or another link; only the `NNN_` number matters.

## already in 3.0 — reference by number

| # | file | beat in the intro |
|---|---|---|
| 100 | `demo/0100_spotlight.svg` | hand spotlights (isMask) for the curtain cold open |
| 204 | `shmidpoint/204_red_curtain.png` | curtain bg |
| 203 | `shmidpoint/203_stochastic_labs_hat.png` | stochastic triangle hat |
| 001 | `demo/001_beret_hat.png` | artist beret (see also 551) |
| 002 | `demo/002_scientist_glasses.png` | scientist glasses |
| 003 | `demo/003_engineer_goggles_glasses.png` | engineer goggles |
| 216 | `shmidpoint/216_cane.png` | the hook |
| 300 | `CNMAT_openlab/300_bjorn_drawing.png` | Björn |
| 301 | `CNMAT_openlab/301_eecs_logo.png` | UC Berkeley EECS — **this is the bear photo** (same bytes as 2.5.0's `berkeley_bear.png`) |
| 302 | `CNMAT_openlab/302_adobe_research.png` | Adobe Research |
| 303 | `CNMAT_openlab/303_mj_lab.png` | Midjourney Storytelling Lab |
| 304 | `CNMAT_openlab/304_jacobs.png` | Jacobs Institute |
| 305 / 306 | `CNMAT_openlab/305_bart_costume1.jpg`, `306_bart_costume2.png` | BART costumes |
| 307 | `CNMAT_openlab/307_tiat_soundsculpture.webm` | tiat (video) — logo is 530 |
| 308 | `CNMAT_openlab/308_stochastic_logo.png` | Stochastic Labs logo |
| 309 / 310 | `CNMAT_openlab/309_sock_rest.png`, `310_sock_talk.png` | talking sock (rest / talk) |
| 315 | `CNMAT_openlab/315_bPigment_pears.webm` | bPigment |
| 316 | `CNMAT_openlab/316_cse.png` | CSE |
| 333 | `CNMAT_openlab/333_smithsonian.png` | Smithsonian |
| 343 | `CNMAT_openlab/343_artographer.webm` | artographer video |
| 352 | `CNMAT_openlab/352_shm_mirror.png` | round mirror (focus) |

> ⚠️ **901 is shadowed.** `demo/0901_sign.svg` and `CNMAT_openlab/901_portrait.png` both
> parse to 901, and the sorted manifest picks the demo sign. Use **516** for the portrait.

## linked in — `assets/UIUC_2026/` (symlinks to shmspace)

### identity beats (from cs10)

| # | file | |
|---|---|---|
| 500 | `500_ruler.png` | "HCI researcher" ruler |
| 501 | `501_paintbrush.png` | artist |
| 502 | `502_computer.png` | computer scientist / "the computers" |
| 503 | `503_nonbinary_flag.png` | non-binary |
| 504 | `504_filipino_flag.png` | Filipino American |
| 505 | `505_bid_logo.jpg` | Berkeley Institute of Design |
| 506 | `506_newjersey.png` | NJ :-) |
| 507 | `507_ate_art.png` | sister's art |
| 508 | `508_human.png` | "the humans" |
| 509 | `509_interaction.png` | "the interactions" |
| 510 | `510_mouse.png` | first mouse |
| 511 | `511_christie.png` | |
| 512 | `512_artographer_trajectory.webm` | artographer trajectory |
| 513 | `513_hci.png` | HCI |
| 514 | `514_phopper.jpg` | |
| 515 | `515_shmdoodle.png` | |
| 516 | `516_portrait.png` | portrait (use instead of 901) |
| 517–522 | `517_hci_url` `518_shmuh_url` `519_qr_code` `520_course_recs` `521_bcdi_url` `522_jacobs_url` | links / QR |

### teaching, art, theatre (from stochastic_intro)

| # | file | |
|---|---|---|
| 530 | `530_tiat_logo.png` | tiat logo |
| 531–533 | `531_teaching_robodog_srimayi_gupta.webm` `532_teaching_rainier_dylan_pearson.webm` `533_teaching_radar_garden_sabrina_kuang.webm` | student work |
| 534–538 | `534_shm_art1` `535_shm_art4` `536_shm_art3` `537_shm_art2016` `538_shm_art5` | shm's art |
| 539 | `539_carrot.jpg` | |
| 540 / 541 | `540_mirrors.png`, `541_mirrors_round.png` | mirrors |
| 542–545 | `542_shm_in_theatre1` … `545_shm_in_theatre4` | theatre photos |
| 546 / 547 | `546_performance_text.png`, `547_creative_computation_text.png` | text puppets |

### head puppets

| # | file | |
|---|---|---|
| 550 | `550_hci_researcher_heading.png` | "Human-Computer Interaction Researcher" heading |
| 551 | `551_beret_hat.png` | cs10's beret (slightly different from 001) — auto-mounts to hat |
| 552 | `552_designer_hat.png` | auto-mounts to hat |
| 553 | `553_visual_art_heading.png` | "visual art" heading |

`_heading` means nothing to 3.0 (only `_hat _glasses _nose _beard _mouth` auto-mount). Place
headings with `"fasten": "face"` and a negative `y` offset.

### slides

| # | file |
|---|---|
| 560 | `560_tcnj.png` |
| 561–567 | `561_richgold` `562_interface` `563_first_mouse` `564_hci_researchers` `565_hci_at_berkeley` `566_jacobs_building` `567_jacobs_making` |
| 568–570 | `568_performance_painting.webm` `569_potatoes.webm` `570_max_training.webm` |

### stage puppets (rest / talk pairs)

| # | file |
|---|---|
| 580 / 581 | hat sock — rest / talk |
| 582 / 583 | hat-puppeteer sock — rest / talk |
| 584 / 585 | Mr. / Mrs. Potato Head |
| 586 | walter the dog |

## not found

cs10's `005_adobe_dress.mp4`, `006_artographer.mp4`,
`008_parrot_hci.mp4` and `009_cats.mp4` are referenced by its script but aren't on disk in
shmspace. **571 `571_CSEdrawing.webm`** is a real file (not a link), converted from the Keynote copy.
