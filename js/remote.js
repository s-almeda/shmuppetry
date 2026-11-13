// ── Remote ────────────────────────────────────────────────────────────────
// Tells control.html — the presenter view on the laptop — where the show is. One
// BroadcastChannel per show, so two shows open in two tabs never cross wires.
//
// The HINT is worked out here, not in control.html, because only the rig knows the truth:
// it holds the resolved script including unsaved panel edits, the live position of every
// cycling series, and the asset names. control.html just prints what it is sent.
//
// The picture is not sent at all. control.html screen-captures this tab, which is the only
// way to get the DOM layer (dialogue boxes, xp.css chrome) as well as the canvas.

// `504_filipino_flag.png` → "filipino flag". What you'd call it out loud.
const label = (file) => String(file ?? '').split('/').pop()
  .replace(/\.[^.]+$/, '').replace(/^\d+_/, '').replace(/_/g, ' ');

const clip = (s, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class Remote {
  constructor({ showName, player, assets }) {
    this.player = player;
    this.assets = assets;
    this.last = '';
    this.channel = new BroadcastChannel(`shmuppetry:${showName}`);
    // A control window opened mid-show asks where we are, rather than waiting for the
    // next scene change to find out.
    //
    // `peek` is the control view stepping its OWN position (its ◀ ▶), e.g. to correct a
    // view that has drifted from the show. Answered from the resolved script; the show
    // itself never moves.
    this.channel.onmessage = ({ data }) => {
      if (data?.type === 'hello') this.send(true);
      if (data?.type === 'peek') this.channel.postMessage({ type: 'peek', ...this.state(data.index) });
    };
    // Break-to-cycle (`cycleOn: "reacquire"`) steps a series from inside the render loop
    // with no event anyone can hook, so changes are also caught by polling. Posts only
    // when something actually differs.
    setInterval(() => this.send(), 300);
  }

  send(force = false) {
    const state = this.state();
    const key = JSON.stringify(state);
    if (!force && key === this.last) return;
    this.last = key;
    this.channel.postMessage({ type: 'state', ...state });
  }

  name(src) {
    return typeof src === 'number' ? label(this.assets.byNumber.get(src) ?? `#${src}`) : label(src);
  }

  // What an object is showing, in words.
  shows(spec) {
    if (!spec) return '';
    if (spec.srcs?.length) return this.name(spec.srcs[spec.index ?? 0]);
    if (spec.src != null) return this.name(spec.src);
    return spec.type;
  }

  state(i = this.player.index) {
    const p = this.player;
    i = Math.max(-1, Math.min(i, p.length - 1));
    const scene = p.resolved[i];
    return {
      index: i,
      total: p.length,
      id: scene?.id ?? null,
      now: scene ? this.lines(scene.objects) : [],
      series: this.series(),
      // Build position within the scene — live, so only at the rig's own scene.
      step: i === p.index ? { at: p.builds.at, n: p.builds.total } : null,
      next: this.next(i),
    };
  }

  // Every line of text on stage, speaker first.
  lines(objects) {
    return Object.values(objects)
      .filter((o) => o.type === 'text' && o.text)
      .map((o) => clip(o.speaker ? `${o.speaker}: ${o.text}` : o.text));
  }

  // Live, from the pool — a series' position is performance state, not script state.
  series() {
    return this.player.pool.objects
      .filter((o) => o.srcs?.length > 1)
      .map((o) => {
        const n = o.srcs.length, at = o.index ?? 0;
        return {
          id: o.id, key: o.cycleKey ?? (o.cycleOn === 'reacquire' ? 'swipe' : null),
          at: at + 1, n,
          now: this.name(o.srcs[at]),
          then: this.name(o.srcs[(at + 1) % n]),
        };
      });
  }

  // What pressing Space will change. A scene's own `cue` is the author's word and wins;
  // the diff underneath is always included, since it is what the stage will actually do.
  next(i) {
    const p = this.player;
    if (i + 1 >= p.length) return { cue: 'end of script', changes: [] };
    const a = p.resolved[i]?.objects ?? {};
    const b = p.resolved[i + 1].objects;
    const raw = p.script[i + 1] ?? {};
    const changes = [];
    if (raw.reset) changes.push('↺ stage reset');
    for (const [id, o] of Object.entries(b)) {
      const was = a[id];
      if (o.type === 'text') {
        if (o.text && o.text !== was?.text) changes.push(`💬 ${clip(o.speaker ? `${o.speaker}: ${o.text}` : o.text)}`);
        else if (!was) changes.push(`+ ${id}`);
        continue;
      }
      if (!was || was.type !== o.type) changes.push(`+ ${id} (${this.shows(o)})`);
      else if (this.shows(o) !== this.shows(was)) changes.push(`${id} → ${this.shows(o)}`);
    }
    for (const id of Object.keys(a)) if (!(id in b)) changes.push(`− ${id}`);
    if (!changes.length) changes.push('(nothing visible changes)');
    return { cue: raw.cue ?? null, changes };
  }
}
