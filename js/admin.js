// ── Admin ─────────────────────────────────────────────────────────────────
// The [?] in the title bar: a local-only menu for jumping between shows and opening the
// presenter view (control.html). Only mounted when the dev server answered the probe, so
// the public page never shows it — same gate as authoring.

export class Admin {
  constructor({ button, showName }) {
    this.button = button;
    this.showName = showName;
    this.menu = null;
  }

  mount() {
    this.button.hidden = false;
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      // Blur, or the next Space press "clicks" this button instead of advancing the show.
      this.button.blur();
      this.menu ? this.close() : this.open();
    });
    document.addEventListener('click', (e) => {
      if (this.menu && !this.menu.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  async open() {
    const menu = document.createElement('div');
    menu.className = 'window admin-menu';
    menu.innerHTML = `
      <div class="title-bar"><div class="title-bar-text">admin</div></div>
      <div class="window-body">
        <button type="button" class="admin-control">open control in new tab</button>
        <button type="button" class="admin-editor">open slide editor in new tab</button>
        <p class="admin-label">shows</p>
        <div class="admin-shows">loading…</div>
      </div>`;
    menu.querySelector('.admin-control').addEventListener('click', () => {
      window.open(`./control.html?show=${encodeURIComponent(this.showName)}`, '_blank');
      this.close();
    });
    // The editor opens on the scene the rig is showing, so "fix this slide" is one click.
    menu.querySelector('.admin-editor').addEventListener('click', () => {
      const scene = (window.shmuppetry?.player?.index ?? 0) + 1;
      window.open(`./editor.html?show=${encodeURIComponent(this.showName)}&scene=${scene}`, '_blank');
      this.close();
    });
    document.body.appendChild(menu);
    this.menu = menu;

    const list = menu.querySelector('.admin-shows');
    try {
      const res = await fetch('./shows/index.json', { cache: 'no-store' });
      const { shows } = await res.json();
      list.replaceChildren(...shows.map((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${s.name} — ${s.title} (${s.scenes})`;
        if (s.name === this.showName) { b.disabled = true; b.textContent += ' ← here'; }
        b.addEventListener('click', () => {
          location.href = `./?show=${encodeURIComponent(s.name)}`;
        });
        return b;
      }));
    } catch (err) {
      list.textContent = `couldn't load shows/index.json (${err.message})`;
    }
  }

  close() {
    this.menu?.remove();
    this.menu = null;
  }
}
