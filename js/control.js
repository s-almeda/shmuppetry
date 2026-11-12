// ── Control ───────────────────────────────────────────────────────────────
// The presenter view (control.html). Two independent halves:
//
//   the MIRROR — a screen capture of the rig's tab. Capture rather than a second rig,
//     because the dialogue boxes are DOM, not canvas, and because a second rig would run
//     every model twice and drift from what the audience actually sees.
//   the NOTES  — whatever js/remote.js broadcasts. Nothing here reads the script; the rig
//     already knows everything, including edits made in its panel since the last save.

const params = new URLSearchParams(location.search);
const showName = params.get('show') || 'demo';
document.title = `control — ${showName}`;

const $ = (id) => document.getElementById(id);

// ── Mirror ────────────────────────────────────────────────────────────────
const video = $('mirror-video');

async function pick() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 60 } },
      // The rig plays its own sound. Capturing it here would play it twice.
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',   // never offer this tab — mirroring a mirror
      surfaceSwitching: 'include',     // lets you re-point at a reloaded rig tab
    });
    video.srcObject = stream;
    $('mirror-empty').hidden = true;
    // Chrome's "stop sharing", or the rig tab closing, ends the track. Put the button back
    // rather than leaving a frozen last frame that looks like a live one.
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      video.srcObject = null;
      $('mirror-empty').hidden = false;
    });
  } catch (err) {
    console.warn('[control] capture cancelled or refused', err);
  }
}
$('pick').addEventListener('click', pick);

// ── Notes ─────────────────────────────────────────────────────────────────
// ◀ ▶ move THIS VIEW only, as an offset from wherever the rig says it is — so a correction
// sticks as the show carries on advancing. The rig answers a `peek` from its resolved
// script; the audience never sees a thing. Click the scene counter to drop the offset.
const channel = new BroadcastChannel(`shmuppetry:${showName}`);
let heard = false;
let live = null;     // the rig's own latest state
let offset = 0;

const fill = (ul, items, make = (s) => s) => {
  ul.replaceChildren(...items.map((x) => {
    const li = document.createElement('li');
    li.textContent = make(x);
    return li;
  }));
};

function render(data) {
  const shifted = offset !== 0;
  $('where').textContent = data.index < 0 ? '—'
    : `scene ${data.index + 1} / ${data.total}  ·  id ${data.id}` + (shifted ? `   (rig at ${live.index + 1})` : '');
  $('where').classList.toggle('shifted', shifted);
  fill($('now'), data.now);
  $('cue').textContent = data.next?.cue ?? '';
  $('cue').hidden = !data.next?.cue;
  fill($('changes'), data.next?.changes ?? []);
  // A series' position is live performance state, so it only means anything at the rig's
  // actual scene.
  const series = shifted ? [] : data.series;
  fill($('series'), series, (s) =>
    `${s.key ? `[${s.key}] ` : ''}${s.id}  ${s.at}/${s.n}  ${s.now}  →  ${s.then}`);
  $('series-h').hidden = !series.length;
}

const peek = () => channel.postMessage({ type: 'peek', index: live.index + offset });
const refresh = () => (offset ? peek() : render(live));

channel.onmessage = ({ data }) => {
  if (data?.type === 'state') {
    heard = true;
    live = data;
    $('link').textContent = '● rig';
    $('link').className = 'on';
    refresh();
  } else if (data?.type === 'peek' && offset) {
    render(data);
  }
};

const step = (by) => {
  if (!live) return;
  offset = Math.max(-live.index, Math.min(offset + by, live.total - 1 - live.index));
  refresh();
};
$('back').addEventListener('click', () => step(-1));
$('fwd').addEventListener('click', () => step(1));
$('where').addEventListener('click', () => { offset = 0; if (live) refresh(); });

// Ask until someone answers: the rig may be opened after this window, or reloaded.
const hello = () => channel.postMessage({ type: 'hello' });
hello();
setInterval(() => { if (!heard) hello(); }, 1500);
$('link').textContent = `waiting for the rig — open index.html?show=${showName}`;
