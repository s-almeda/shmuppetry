#!/usr/bin/env node
// ── Dev server ────────────────────────────────────────────────────────────
// Zero dependencies — node:http and node:fs, nothing to install. Run it with
// `node server/dev-server.js` and open http://localhost:8000.
//
// Its only jobs beyond serving files:
//
//   1. GET  /api/health                  — how the client knows authoring exists
//   2. PUT  /api/shows/<show>/script     — write a scene back to disk
//   3. GET  /assets/manifest.json        — generated LIVE from disk, overriding the
//                                          committed file that GitHub Pages serves
//
// (3) is what makes static and local identical from the client's side: one URL, two
// sources, no conditional anywhere in the client. (2) is the entire difference between
// the two deployments — the route simply does not exist statically, so edit mode's
// probe fails and authoring is never offered.
//
// EVERY WRITE ROUTE REJECTS NON-LOOPBACK REQUESTS. Carried over from 2.5.0's
// isLoopback() guard (§8.9): authoring can never be public, even if you run this on a
// machine that is reachable from outside.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

// Trust nothing about the remote address beyond it being loopback. This is the same
// check 2.5.0 used on every write route.
function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2), MIME['.json']);

// Refuse anything that escapes the repo root. Path traversal on a server that also
// has write routes is not a theoretical problem.
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(ROOT, '.' + decoded);
  return resolved.startsWith(ROOT) ? resolved : null;
}

async function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else if (ASSET_EXT.test(e.name)) out.push(rel);
  }
  return out;
}

// The same shape scripts/build-manifests.js bakes.
export async function buildAssetManifest() {
  // Textures are referenced by path; numbering them would collide with real art.
  const files = (await walk(path.join(ROOT, 'assets'))).sort()
    .filter((f) => !f.startsWith('textures/'));
  return {
    _note: 'Generated. Assets are keyed by the number in the filename, not by position in this list.',
    base: './assets/',
    files,
  };
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // ── API ───────────────────────────────────────────────────────────────
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, authoring: isLoopback(req), root: ROOT });
    }

    const scriptRoute = pathname.match(/^\/api\/shows\/([\w.-]+)\/script$/);
    if (scriptRoute) {
      if (req.method !== 'PUT') return send(res, 405, 'method not allowed');
      if (!isLoopback(req)) return send(res, 403, 'authoring is loopback-only');

      const show = scriptRoute[1];
      const file = path.join(ROOT, 'shows', show, 'script.json');
      if (!file.startsWith(path.join(ROOT, 'shows'))) return send(res, 400, 'bad show name');

      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        return send(res, 400, `not valid JSON: ${err.message}`);
      }
      if (!Array.isArray(parsed)) return send(res, 400, 'script must be an array of scenes');

      // Write to a temp file and rename — a crash mid-write must not leave you with
      // half a script and no backup, five minutes before a show.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      await fs.rename(tmp, file);
      console.log(`[dev] saved shows/${show}/script.json (${parsed.length} scenes)`);
      return json(res, 200, { ok: true, scenes: parsed.length });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

    // ── Live manifest, overriding the committed static one ────────────────
    if (pathname === '/assets/manifest.json') {
      return json(res, 200, await buildAssetManifest());
    }

    // ── Static files ──────────────────────────────────────────────────────
    let file = safePath(pathname);
    if (!file) return send(res, 403, 'forbidden');

    let stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file).catch(() => null);
    }
    if (!stat) return send(res, 404, `not found: ${pathname}`);

    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    console.error('[dev] request failed', err);
    send(res, 500, 'server error');
  }
});

// Bind to loopback only. Even the read routes are not offered to the network — the
// public version of this is GitHub Pages, not this process.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`shmuppetry dev server → http://localhost:${PORT}`);
  console.log('authoring enabled (loopback). Ctrl-C to stop.');
});
