// ── Face analysis ─────────────────────────────────────────────────────────
// Age, gender and expression from face-api.js, ported from 2.5.0's index.html. Loaded
// only when a show asks for it — it is a SECOND ML runtime alongside MediaPipe, and the
// only reason to pay for it is that MediaPipe has no age or gender model at all.
//
// Race is NOT inferred. 2.5.0 shipped a 9MB TF.js race classifier; it is deliberately not
// ported (§10), and the script hardcodes the word instead.
//
// Detection runs on its own slow cadence — these labels drift by design and nothing here
// needs to be frame-accurate.

const LIB = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
const WEIGHTS = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
const EVERY_MS = 250;

function loadLib() {
  if (window.faceapi) return Promise.resolve(window.faceapi);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.onload = () => resolve(window.faceapi);
    s.onerror = () => reject(new Error('failed to load face-api.js'));
    document.head.appendChild(s);
  });
}

export class FaceAnalysis {
  constructor(stage, camera) {
    this.stage = stage;
    this.camera = camera;
    this.state = 'idle';
    this.result = null;      // { box: {x,y,w,h} in stage units, age, gender, emotion }
    this._at = 0;
    this._busy = false;
  }

  load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    loadLib()
      .then(async (faceapi) => {
        this.api = faceapi;
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(WEIGHTS),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(WEIGHTS),
          faceapi.nets.ageGenderNet.loadFromUri(WEIGHTS),
          faceapi.nets.faceExpressionNet.loadFromUri(WEIGHTS),
        ]);
        this.state = 'ready';
        console.log('[facelabel] ready');
      })
      .catch((err) => {
        this.state = 'failed';
        console.warn('[facelabel] failed to load', err);
      });
  }

  update(now) {
    if (this.state !== 'ready' || !this.camera.live || this._busy) return;
    if (now - this._at < EVERY_MS) return;
    this._at = now;
    this._detect();
  }

  async _detect() {
    this._busy = true;
    try {
      const video = this.camera.source;
      const found = await this.api
        .detectAllFaces(video, new this.api.TinyFaceDetectorOptions())
        .withFaceLandmarks(true)
        .withAgeAndGender()
        .withFaceExpressions();
      const r = found?.[0];
      if (!r) { this.result = null; return; }

      // face-api boxes are in the source's own pixels. Map both corners through the stage
      // so the mirror is resolved once at the boundary, as everywhere else (§9.2).
      const vw = video.videoWidth || video.width;
      const vh = video.videoHeight || video.height;
      const b = r.detection.box;
      const a = this.stage.videoNormToStage(b.x / vw, b.y / vh, video);
      const c = this.stage.videoNormToStage((b.x + b.width) / vw, (b.y + b.height) / vh, video);
      const emotion = r.expressions
        ? Object.entries(r.expressions).sort((p, q) => q[1] - p[1])[0][0]
        : '';
      this.result = {
        box: {
          x: Math.min(a.x, c.x), y: Math.min(a.y, c.y),
          w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y),
        },
        age: Number.isFinite(r.age) ? Math.round(r.age) : null,
        gender: r.gender,
        emotion,
      };
    } catch (err) {
      console.warn('[facelabel] detect failed', err);
    } finally {
      this._busy = false;
    }
  }

  // Fill {emotion} {age} {gender} in a template. Anything without a placeholder is a
  // literal, so "shm garanganao almeda" and "bored mf" are the same object with different
  // text — which is exactly how the script uses it.
  fill(template) {
    const r = this.result;
    return String(template)
      .replace(/\{emotion\}/g, r?.emotion && r.emotion !== 'neutral' ? r.emotion : '')
      .replace(/\{age\}/g, r?.age ?? '')
      .replace(/\{gender\}/g, r ? (r.gender === 'female' ? 'woman' : r.gender === 'male' ? 'man' : 'person') : '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
