#!/usr/bin/env python3
"""Import a Keynote deck into a show's script.json.

    .venv-kp/bin/python3 scripts/import-keynote.py example.key myshow
    .venv-kp/bin/python3 scripts/import-keynote.py example.key myshow --band 600
    .venv-kp/bin/python3 scripts/import-keynote.py example.key UIUC_2026 --into --after 21

Keynote is AUTHORING ONLY. This reads the .key once (via keynote-parser's YAML dump of the
IWA protobufs) and writes our own scene JSON — text, image, video and shape objects with
builds and transitions — plus the referenced media into assets/<show>/. After that the
.key is not needed. Anything outside the supported feature set is reported per slide and,
for slides with tables/charts/unknown drawables, flattened to a PNG via Keynote itself.

Needs keynote-parser in .venv-kp (see scripts/try-keynote-parser.sh).
keynote-parser is by Peter Sobot, MIT licensed: https://github.com/psobot/keynote-parser
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, tempfile, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV = os.path.join(ROOT, '.venv-kp', 'bin')

try:
    import yaml
except ImportError:
    sys.exit('PyYAML missing — run with .venv-kp/bin/python3 (see scripts/try-keynote-parser.sh)')

# ── Keynote → ours ────────────────────────────────────────────────────────
# Build direction codes (KN.AnimationAttributes.direction). Filled in from a test deck
# whose builds name their own direction; unknown codes fall back to the effect's default
# and are listed in the report so they can be added here.
# Keynote names a direction by where the object COMES FROM; ours is the direction of
# travel. Mapped from example_simple.key, whose builds say their own direction
# ("wipes in from bottom left…"). 21/22 complete Apple's 11–14 / 21–24 scheme.
DIR_CODES = {
    11: 'right',      # from left (also what an absent code means for a wipe)
    12: 'left',       # from right
    13: 'down',       # from top
    14: 'up',         # from bottom
    21: 'downRight',  # from top left
    22: 'downLeft',   # from top right
    23: 'upRight',    # from bottom left
    24: 'upLeft',     # from bottom right
}
# What Keynote does when no code is stored.
DEFAULT_DIR = {'wipe': 'right', 'move': 'right', 'fadeMove': 'up', 'push': 'left'}

def map_effect(name, anim_type):
    """Keynote effect string → (ours, note). None means 'not a build we play'."""
    n = (name or '').lower()
    if 'magic-move' in n: return None, None
    if 'linedraw' in n: return 'lineDraw', None
    if n == 'apple:movie-start': return 'movieStart', None
    if 'fade and move' in n: return 'fadeMove', None
    if 'dissolve' in n: return 'dissolve', None
    if n.startswith('apple:fade'): return 'fade', None
    if 'wipe' in n: return 'wipe', None
    if 'keyboard' in n or 'typewriter' in n: return 'keyboard', None
    if 'pulse' in n: return 'pulse', None
    if 'pop' in n: return 'pop', None
    if 'scale' in n: return 'scale', None
    if 'move' in n or 'fly' in n: return 'move', None
    return 'dissolve', f'effect "{name}" not supported → dissolve'

def map_transition(name):
    n = (name or '').lower()
    if not n or n == 'none': return None, None
    if 'magic-move' in n: return 'magicMove', None
    if 'dissolve' in n: return 'dissolve', None
    if 'fade' in n: return 'fade', None
    if 'wipe' in n or 'reveal' in n: return 'wipe', None
    if 'push' in n: return 'push', None
    if 'move' in n: return 'move', None
    return 'dissolve', f'transition "{name}" not supported → dissolve'

WEIGHTS = {'thin': 100, 'ultralight': 200, 'extralight': 200, 'light': 300, 'regular': 400, 'roman': 400,
           'medium': 500, 'semibold': 600, 'demibold': 600, 'bold': 700, 'extrabold': 800, 'heavy': 900, 'black': 900}

def font_css(ps_name):
    """'HelveticaNeue-BoldItalic' → ('HelveticaNeue-BoldItalic, Helvetica Neue', 700, True).
    The PostScript name goes first — macOS browsers resolve it directly — with a family
    guess as the fallback."""
    if not ps_name: return None, None, None
    fam, _, style = ps_name.partition('-')
    weight, italic = None, False
    tokens = re.findall(r'[A-Z][a-z]+|[a-z]+', style)
    for t in tokens:
        tl = t.lower()
        if tl in WEIGHTS: weight = WEIGHTS[tl]
        if tl in ('italic', 'oblique'): italic = True
    # Some families carry the weight without a dash (ArialBold) — rare, ignore.
    family = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', fam)
    family = re.sub(r'\bM S\b', 'MS', family)
    return f'{ps_name}, {family}', weight, italic

def color_hex(c):
    if not isinstance(c, dict) or 'r' not in c: return None
    r, g, b = (max(0, min(255, round(c.get(k, 0) * 255))) for k in 'rgb')
    a = c.get('a', 1.0)
    if a < 0.999: return f'rgba({r},{g},{b},{a:.3f})'
    return '#%02x%02x%02x' % (r, g, b)

def rnd(v, n=4): return round(float(v), n)

# ── Object graph ──────────────────────────────────────────────────────────
class Deck:
    def __init__(self, unpacked):
        self.dir = unpacked
        self.objs = {}
        for f in glob.glob(os.path.join(unpacked, 'Index', '*.yaml')):
            d = yaml.safe_load(open(f))
            for ch in d.get('chunks', []):
                for a in ch.get('archives', []):
                    oid = a['header']['identifier']
                    objs = a.get('objects') or []
                    if objs: self.objs[oid] = objs[0]
        self.data_files = {}
        for f in os.listdir(os.path.join(unpacked, 'Data')):
            m = re.search(r'-(\d+)\.(\w+)$', f)
            if m: self.data_files[m.group(1)] = f

    def get(self, ref):
        if isinstance(ref, dict): ref = ref.get('identifier')
        if ref is None: return None
        return self.objs.get(str(ref))

    def typ(self, o): return (o or {}).get('_pbtype', '')

    # Walk the style parent chain, deep-merging so the child wins.
    def resolve_style(self, ref, depth=0):
        o = self.get(ref)
        if not o or depth > 12: return {}
        parent = None
        sup = o
        for _ in range(4):
            sup = sup.get('super') if isinstance(sup, dict) else None
            if not isinstance(sup, dict): break
            if 'parent' in sup: parent = sup['parent']; break
        base = self.resolve_style(parent, depth + 1) if parent else {}
        return deep_merge(base, o)

def deep_merge(a, b):
    if not isinstance(a, dict) or not isinstance(b, dict): return b
    out = dict(a)
    for k, v in b.items():
        out[k] = deep_merge(a.get(k), v) if k in a else v
    return out

def dig(d, *path, default=None):
    for p in path:
        if not isinstance(d, dict) or p not in d: return default
        d = d[p]
    return d

# ── Importer ──────────────────────────────────────────────────────────────
class Importer:
    def __init__(self, deck, show, band, out_assets):
        self.deck = deck
        self.show = show
        self.W, self.H = 1920.0, 1080.0
        self.band = band
        self.out_assets = out_assets
        self.assets = {}        # data id → asset number
        self.next_asset = band
        self.report = []
        self.scenes = []

    def note(self, slide_no, msg): self.report.append((slide_no, msg))

    # Copy a Data/ file into the show's asset folder, once per data id.
    def asset(self, data_ref):
        did = str(data_ref.get('identifier') if isinstance(data_ref, dict) else data_ref)
        if did in self.assets: return self.assets[did]
        f = self.deck.data_files.get(did)
        if not f: return None
        n = self.next_asset; self.next_asset += 1
        base = re.sub(r'-\d+(\.\w+)$', r'\1', f)
        base = re.sub(r'[^A-Za-z0-9_.-]', '_', base)
        os.makedirs(self.out_assets, exist_ok=True)
        shutil.copy2(os.path.join(self.deck.dir, 'Data', f), os.path.join(self.out_assets, f'{n}_{base}'))
        self.assets[did] = n
        return n

    def run(self):
        D = self.deck
        show = next((o for o in D.objs.values() if D.typ(o) == 'KN.ShowArchive'), None)
        if not show: sys.exit('no KN.ShowArchive — is this a Keynote file?')
        self.W = float(dig(show, 'size', 'width', default=1920)); self.H = float(dig(show, 'size', 'height', default=1080))
        nodes = [D.get(r) for r in dig(show, 'slideTree', 'slides', default=[])]
        slide_no = 0
        for node in nodes:
            if not node: continue
            slide_no += 1
            if node.get('isSkipped'):
                self.note(slide_no, 'skipped in Keynote — not imported'); continue
            slide = D.get(node.get('slide'))
            if not slide: continue
            scene, _needs_png = self.convert_slide(slide, slide_no)
            self.scenes.append(scene)
        return self.scenes

    # ── one slide ─────────────────────────────────────────────────────────
    def convert_slide(self, slide, no):
        D = self.deck
        objects = {}
        self.ids = set()
        needs_png = False
        # Background: the slide's style, falling back to its master's.
        bg = self.background(slide)
        if bg: objects['bg'] = bg
        z = 0
        order = slide.get('drawablesZOrder') or slide.get('ownedDrawables') or []
        drawable_ids = {}   # keynote id → our object id (for builds)
        for ref in order:
            d = D.get(ref)
            if not d: continue
            # Two z slots per drawable: a text-bearing shape's box at 2n, its text at 2n+1,
            # so the text sits directly on its own box and under anything drawn after it.
            z += 2
            made = self.convert_drawable(d, no, z, 0.0, 0.0)
            if made is None: needs_png = True; continue
            for oid, spec in made:
                objects[oid] = spec
                drawable_ids.setdefault(str(ref.get('identifier')), []).append(oid)
        # Builds, in chunk order: a non-automatic chunk starts a new click.
        self.builds(slide, no, objects, drawable_ids)
        scene = {'id': len(self.scenes) + 1, 'reset': True, 'slide': True, '_note': f'keynote slide {no}'}
        t = self.transition(slide, no)
        if t: scene['transition'] = t
        scene['objects'] = objects
        return scene, needs_png

    def background(self, slide):
        D = self.deck
        for cand in (slide.get('style'), dig(D.get(slide.get('templateSlide')) or {}, 'style')):
            if not cand: continue
            st = D.resolve_style(cand)
            fill = dig(st, 'slideProperties', 'fill', default={})
            col = color_hex(fill.get('color')) if isinstance(fill, dict) else None
            if col:
                return {'type': 'shape', 'path': 'M 0 0 H 1 V 1 H 0 Z', 'size': 3, 'aspect': 3,
                        'fill': col, 'stroke': 'none', 'strokeWidth': 0, 'z': -150, 'fasten': None}
            img = dig(fill, 'image', 'imagedata') if isinstance(fill, dict) else None
            if img:
                n = self.asset(img)
                if n: return {'type': 'image', 'src': n, 'fit': 'cover', 'z': -150, 'fasten': None}
        return None

    def transition(self, slide, no):
        a = dig(slide, 'transition', 'attributes', 'animationAttributes', default={})
        eff, warn = map_transition(a.get('effect'))
        if warn: self.note(no, warn)
        if not eff: return None
        t = {'effect': eff, 'dur': rnd(a.get('duration', 0.7), 2)}
        if eff in ('wipe', 'push', 'move'):
            code = a.get('direction')
            t['dir'] = DIR_CODES.get(code, DEFAULT_DIR.get(eff, 'right'))
            if code is not None and code not in DIR_CODES:
                t['dirCode'] = code; self.note(no, f'transition direction code {code} unknown → {t["dir"]}')
        return t

    def uid(self, base):
        base = re.sub(r'[^A-Za-z0-9_]+', '_', base).strip('_')[:28] or 'obj'
        if base[0].isdigit(): base = '_' + base
        oid, i = base, 2
        while oid in self.ids: oid = f'{base}_{i}'; i += 1
        self.ids.add(oid)
        return oid

    def geom(self, d):
        g = dig(d, 'super', 'geometry') or dig(d, 'super', 'super', 'geometry') or dig(d, 'super', 'super', 'super', 'geometry') or {}
        w = float(dig(g, 'size', 'width', default=0)); h = float(dig(g, 'size', 'height', default=0))
        # `flags` says which fields are set; a text item sized to its contents carries no
        # size (flags 0) and its path's natural size is the box.
        if not w or not h:
            ps = dig(d, 'super', 'pathsource') or dig(d, 'super', 'super', 'pathsource') or {}
            nat = next((v.get('naturalSize') for k, v in ps.items() if isinstance(v, dict) and v.get('naturalSize')), None)
            if nat: w = w or float(nat.get('width', 0)); h = h or float(nat.get('height', 0))
        return (float(dig(g, 'position', 'x', default=0)), float(dig(g, 'position', 'y', default=0)), w, h,
                float(g.get('angle', 0) or 0))

    # Returns [(id, spec)...], or None when the drawable makes the slide need a PNG.
    def convert_drawable(self, d, no, z, ox, oy):
        D = self.deck
        t = D.typ(d)
        if t == 'TSD.GroupArchive':
            gx, gy, _, _, ang = self.geom(d)
            if ang: self.note(no, 'rotated group — children imported unrotated')
            out = []
            for ref in d.get('children') or []:
                c = D.get(ref)
                if not c: continue
                made = self.convert_drawable(c, no, z, ox + gx, oy + gy)
                if made is None: return None
                out += made
            return out
        if t in ('TSD.ImageArchive', 'TSD.MovieArchive'):
            return self.convert_media(d, no, z, ox, oy)
        if t in ('TSWP.ShapeInfoArchive', 'KN.PlaceholderArchive', 'TSD.ConnectionLineArchive'):
            return self.convert_shape(d, no, z, ox, oy)
        if t.startswith('TST.') or t.startswith('TSCH.'):
            self.note(no, f'{t.split(".")[0]} (table/chart) — slide flattened to PNG'); return None
        self.note(no, f'unknown drawable {t} — slide flattened to PNG')
        return None

    def convert_media(self, d, no, z, ox, oy):
        D = self.deck
        x, y, w, h, ang = self.geom(d)
        movie = D.typ(d) == 'TSD.MovieArchive'
        data = d.get('movieData') if movie else d.get('data')
        n = self.asset(data)
        if n is None:
            self.note(no, 'media file missing from the package'); return []
        crop = None
        mask = D.get(d.get('mask'))
        if mask and w and h:
            # The mask's geometry is in the image's own space: where, on the displayed
            # image, the visible window sits. That window is what the slide shows.
            mx, my, mw, mh, _ = self.geom(mask)
            if mw > 0 and mh > 0 and (mw < w - 0.5 or mh < h - 0.5 or mx > 0.5 or my > 0.5):
                crop = [rnd(mx / w), rnd(my / h), rnd(mw / w), rnd(mh / h)]
                x, y, w, h = x + mx, y + my, mw, mh
        spec = {'type': 'video' if movie else 'image', 'src': n, 'fasten': None,
                'x': rnd((ox + x + w / 2) / self.W), 'y': rnd((oy + y + h / 2) / self.H),
                'size': rnd(h / self.H), 'z': z}
        if crop: spec['crop'] = crop
        if ang: spec['rotation'] = rnd(-ang, 2)
        if dig(d, 'super', 'pathsource', 'horizontalFlip'): spec['flipX'] = True
        if movie:
            spec['play'] = 'auto'
            spec['loop'] = (d.get('loopOption') or 'None') != 'None'
        oid = self.uid(f'{"mov" if movie else "img"}{data.get("identifier") if isinstance(data, dict) else data}')
        return [(oid, spec)]

    def convert_shape(self, d, no, z, ox, oy):
        D = self.deck
        inner = d.get('super') if D.typ(d) == 'KN.PlaceholderArchive' else d
        x, y, w, h, ang = self.geom(inner)
        out = []
        style = D.resolve_style(dig(inner, 'super', 'style'))
        sp = dig(style, 'super', 'shapeProperties', default={}) or {}
        stroke = sp.get('stroke') or {}
        has_stroke = (stroke.get('width', 0) or 0) > 0 and dig(stroke, 'pattern', 'type') != 'TSDEmptyPattern'
        fill_col = color_hex(dig(sp, 'fill', 'color'))
        path = self.path_of(dig(inner, 'super', 'pathsource'), w, h, no)
        is_text = bool(inner.get('isTextBox')) or bool(inner.get('ownedStorage'))
        storage = D.get(inner.get('ownedStorage') or inner.get('deprecatedStorage'))
        text = ''.join(storage.get('text') or []) if storage else ''
        text = text.replace(' ', '\n').replace(' ', '\n').replace('￼', '').rstrip('\n')
        # The shape itself, when it draws something: a filled box, a line, an arrow.
        if path and (has_stroke or fill_col):
            spec = {'type': 'shape', 'path': path, 'fasten': None,
                    'x': rnd((ox + x + w / 2) / self.W), 'y': rnd((oy + y + max(h, 1) / 2) / self.H),
                    'size': rnd(max(h, 1) / self.H), 'aspect': rnd(w / max(h, 1), 3), 'z': z}
            spec['stroke'] = color_hex(stroke.get('color')) if has_stroke else 'none'
            spec['strokeWidth'] = rnd((stroke.get('width') or 0) / self.H) if has_stroke else 0
            if fill_col: spec['fill'] = fill_col
            if ang: spec['rotation'] = rnd(-ang, 2)
            # Keynote's HEAD is the end of the path (where an arrow points), TAIL the start.
            # Verified against AppleScript's start/end points on the example deck.
            head, tail = self.line_end(sp.get('headLineEnd')), self.line_end(sp.get('tailLineEnd'))
            if head: spec['arrowEnd'] = True
            if tail: spec['arrowStart'] = True
            style_ = head or tail
            if style_ and 'open' in style_: spec['arrowStyle'] = 'open'
            out.append((self.uid('shape' if text.strip() == '' else 'box_' + text[:12]), spec))
        elif not path and not text.strip():
            self.note(no, 'shape with a non-bezier path and no text skipped')
        # The text in it.
        if text.strip():
            spec = self.text_spec(inner, storage, style, ox + x, oy + y, w, h, no)
            spec['z'] = z + 1
            out.append((self.uid('t_' + text), spec))
        return out

    def line_end(self, le):
        """The arrowhead's name ('open arrow', 'filled arrow', …), or None. A plain end is
        stored as a record whose identifier is 'none', so presence alone means nothing."""
        if not isinstance(le, dict): return None
        ident = str(le.get('identifier') or '').strip().lower()
        return None if not ident or ident == 'none' else ident

    def path_of(self, ps, w, h, no):
        bez = dig(ps, 'bezierPathSource')
        eb = dig(ps, 'editableBezierPathSource')
        if not bez and eb:
            # Editable paths ARE in the box's units (their naturalSize is the node bounds).
            nw = float(dig(eb, 'naturalSize', 'width', default=0) or 0); nh = float(dig(eb, 'naturalSize', 'height', default=0) or 0)
            hf = bool(ps.get('horizontalFlip')); vf = bool(ps.get('verticalFlip'))
            def f(p):
                u = p['x'] / nw if nw else 0.5; v = p['y'] / nh if nh else 0.5
                if hf: u = 1 - u
                if vf: v = 1 - v
                return f'{u:.4f} {v:.4f}'
            parts = []
            for sp in eb.get('subpaths') or []:
                nodes = sp.get('nodes') or []
                for i, n in enumerate(nodes):
                    if i == 0: parts.append('M ' + f(n['nodePoint'])); continue
                    prev = nodes[i - 1]
                    parts.append('C ' + ', '.join(f(p) for p in (prev.get('outControlPoint', prev['nodePoint']), n.get('inControlPoint', n['nodePoint']), n['nodePoint'])))
                if sp.get('closed') and nodes:
                    prev, n = nodes[-1], nodes[0]
                    parts.append('C ' + ', '.join(f(p) for p in (prev.get('outControlPoint', prev['nodePoint']), n.get('inControlPoint', n['nodePoint']), n['nodePoint'])) + ' Z')
            return ' '.join(parts) if parts else None
        sc = dig(ps, 'scalarPathSource')
        if not bez and sc and sc.get('type') == 'kTSDRoundedRectangle':
            # Corner radius in points, turned into the unit box per axis so the corners stay
            # round however the box is stretched. Cubic quarter-circles (k ≈ 0.5523).
            nw = float(dig(sc, 'naturalSize', 'width', default=w) or w or 1)
            nh = float(dig(sc, 'naturalSize', 'height', default=h) or h or 1)
            r = min(float(sc.get('scalar') or 0), nw / 2, nh / 2)
            rx, ry, k = r / nw, r / nh, 0.5523
            q = lambda v: f'{v:.4f}'
            return (f'M {q(rx)} 0 L {q(1 - rx)} 0 C {q(1 - rx + rx * k)} 0, 1 {q(ry - ry * k)}, 1 {q(ry)} '
                    f'L 1 {q(1 - ry)} C 1 {q(1 - ry + ry * k)}, {q(1 - rx + rx * k)} 1, {q(1 - rx)} 1 '
                    f'L {q(rx)} 1 C {q(rx - rx * k)} 1, 0 {q(1 - ry + ry * k)}, 0 {q(1 - ry)} '
                    f'L 0 {q(ry)} C 0 {q(ry - ry * k)}, {q(rx - rx * k)} 0, {q(rx)} 0 Z')
        if not bez:
            if ps and any(k.endswith('PathSource') for k in ps if k != 'bezierPathSource'):
                kind = next(k for k in ps if k.endswith('PathSource'))
                # Keynote's parametric shapes (rounded rect, arrows, polygons) carry no bezier; a
                # plain rectangle stands in. The report says so.
                self.note(no, f'{kind} shape drawn as a rectangle')
                return 'M 0 0 H 1 V 1 H 0 Z'
            return None
        # Keynote's path points are in the path's OWN units (a rectangle is 0..100, a line
        # 0..141.42) and are stretched to fill the drawable's box. So normalise by the
        # points' bounding box, not by naturalSize — dividing by the box drew lines at 43%
        # of their length with the arrowhead off the end, and shrank 0..100 rectangles.
        els = dig(bez, 'path', 'elements', default=[]) or []
        xs = [p['x'] for e in els for p in (e.get('points') or [])]
        ys = [p['y'] for e in els for p in (e.get('points') or [])]
        if not xs: return None
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        hf = bool(ps.get('horizontalFlip')); vf = bool(ps.get('verticalFlip'))
        def f(p):
            u = (p['x'] - x0) / (x1 - x0) if x1 - x0 > 1e-9 else 0.5
            v = (p['y'] - y0) / (y1 - y0) if y1 - y0 > 1e-9 else 0.5
            if hf: u = 1 - u
            if vf: v = 1 - v
            return f'{u:.4f} {v:.4f}'
        parts = []
        for el in els:
            typ = el.get('type'); pts = el.get('points') or []
            if typ == 'moveTo' and pts: parts.append('M ' + f(pts[0]))
            elif typ == 'lineTo' and pts: parts.append('L ' + f(pts[0]))
            elif typ == 'curveTo' and len(pts) >= 3: parts.append('C ' + ', '.join(f(p) for p in pts[:3]))
            elif typ == 'closeSubpath': parts.append('Z')
        # Trailing "Z M 0 0" is Keynote's habit; drop a dangling moveTo.
        while parts and parts[-1].startswith('M'): parts.pop()
        return ' '.join(parts) if parts else None

    def text_spec(self, inner, storage, shape_style, x, y, w, h, no):
        D = self.deck
        para_ref = None
        for e in dig(storage, 'tableParaStyle', 'entries', default=[]) or []:
            if e.get('object'): para_ref = e['object']; break
        para = D.resolve_style(para_ref) if para_ref else {}
        if not para: para = D.resolve_style(dig(shape_style, 'shapeProperties', 'paragraphStyle'))
        cp = dict(para.get('charProperties') or {})
        for e in dig(storage, 'tableCharStyle', 'entries', default=[]) or []:
            if e.get('characterIndex') == 0 and e.get('object'):
                cp.update(D.resolve_style(e['object']).get('charProperties') or {}); break
        pp = para.get('paraProperties') or {}
        font, weight, italic = font_css(cp.get('fontName'))
        if cp.get('bold'): weight = max(weight or 400, 700)
        if cp.get('italic'): italic = True
        pt = float(cp.get('fontSize') or 24)
        align = {'TATvalue0': 'left', 'TATvalue1': 'right', 'TATvalue2': 'center', 'TATvalue3': 'left', 'TATvalue4': 'left'}.get(pp.get('alignment'), 'left')
        valign = {'kFrameAlignTop': 'top', 'kFrameAlignMiddle': 'middle', 'kFrameAlignBottom': 'bottom'}.get(
            dig(shape_style, 'shapeProperties', 'verticalAlignment'), 'top')
        # Keynote insets text from the box edge (4pt by default); the text wraps inside that.
        pad = dig(shape_style, 'shapeProperties', 'padding', default={}) or {}
        pl, pr = float(pad.get('left', 4) or 0), float(pad.get('right', 4) or 0)
        pt_, pb = float(pad.get('top', 4) or 0), float(pad.get('bottom', 4) or 0)
        x, w = x + pl, max(1.0, w - pl - pr)
        y, h = y + pt_, max(1.0, h - pt_ - pb)
        ty = {'top': y, 'middle': y + h / 2, 'bottom': y + h}[valign]
        text = ''.join(storage.get('text') or []).replace(' ', '\n').replace(' ', '\n').replace('￼', '').rstrip('\n')
        spec = {'type': 'text', 'style': 'slide', 'instant': True, 'text': text,
                'x': rnd((x + w / 2) / self.W), 'y': rnd(ty / self.H), 'width': rnd(w / self.W),
                'size': rnd(pt / self.H), 'align': align, 'valign': valign, 'fasten': None}
        # Shrink-to-fit: Keynote draws the text smaller until it fits the box, so the
        # declared point size is a ceiling, not what the audience sees.
        if dig(shape_style, 'shapeProperties', 'shrinkToFit'):
            spec['fitHeight'] = rnd(h / self.H)
        if font: spec['font'] = font
        if weight and weight != 400: spec['weight'] = weight
        if italic: spec['italic'] = True
        col = color_hex(cp.get('fontColor'))
        if col: spec['color'] = col
        ls = dig(pp, 'lineSpacing', 'amount')
        if ls: spec['lineHeight'] = rnd(float(ls) * 1.2, 2)
        return spec

    # ── builds ────────────────────────────────────────────────────────────
    def builds(self, slide, no, objects, drawable_ids):
        D = self.deck
        # Keynote's build order is a list of chunks. A non-automatic chunk is a click (a new
        # step). An automatic one runs without a click: `referent: true` means AFTER the
        # previous build finishes, false means WITH it. Automatic chunks before the first
        # click run when the slide appears — step 0.
        step = 0
        prev_start = prev_end = 0.0
        for ref in slide.get('buildChunks') or []:
            chunk = D.get(ref)
            if not chunk: continue
            dur = float(chunk.get('duration') or 0); delay = float(chunk.get('delay') or 0)
            if not chunk.get('automatic'):
                step += 1; start = delay
            elif chunk.get('referent'):
                start = prev_end + delay
            else:
                start = prev_start + delay
            prev_start, prev_end = start, start + dur
            b = D.get(chunk.get('build'))
            if not b: continue
            a = dig(b, 'attributes', 'animationAttributes', default={}) or {}
            kind = a.get('animationType', 'In')
            targets = drawable_ids.get(str(dig(b, 'drawable', 'identifier')))
            if not targets:
                self.note(no, f'build on a drawable that was not imported ({a.get("effect")})'); continue
            if kind == 'Action':
                # An action changes something already on the slide (js/builds.js "Actions").
                at = dig(b, 'attributes', default={}) or {}
                name = (a.get('effect') or '').lower()
                act = {'step': step, 'dur': rnd(a.get('duration', 0.5), 2)}
                if start > 0.001: act['delay'] = rnd(start, 2)
                if 'pulse' in name:
                    act['effect'] = 'pulse'
                    act['amount'] = rnd(float(at.get('customActionScale', 110)) / 100, 3)
                    rep = int(at.get('customActionRepeatCount', 1) or 1)
                    if rep > 1: act['repeat'] = rep
                elif 'scale' in name:
                    act['_scaleBy'] = float(at.get('actionScaleSize', 1) or 1)
                else:
                    self.note(no, f'action build ({a.get("effect")}) not supported — skipped'); continue
                for k in targets:
                    o = objects.get(k)
                    if not o: continue
                    mine = dict(act)
                    by = mine.pop('_scaleBy', None)
                    if by is not None:
                        # Text has no `scale`: its type size and box width grow instead.
                        if o.get('type') == 'text':
                            mine['set'] = {'size': rnd(o.get('size', 0.05) * by), 'width': rnd(o.get('width', 0.5) * by)}
                        else:
                            mine['set'] = {'scale': rnd(o.get('scale', 1) * by)}
                    o.setdefault('actions', []).append(mine)
                continue
            eff, warn = map_effect(a.get('effect'), kind)
            if warn: self.note(no, warn)
            if eff is None: continue
            build = {'effect': eff, 'dur': rnd(a.get('duration', 0.5), 2), 'step': step}
            if start > 0.001: build['delay'] = rnd(start, 2)
            if eff == 'movieStart':
                build['effect'] = 'fade'; build['dur'] = 0
                for k in targets:
                    if objects[k].get('type') == 'video': objects[k]['play'] = 'onStep'
            code = a.get('direction')
            if eff in ('wipe', 'move', 'fadeMove'):
                build['dir'] = DIR_CODES.get(code, DEFAULT_DIR[eff])
                if code is not None and code not in DIR_CODES:
                    build['dirCode'] = code; self.note(no, f'build direction code {code} unknown → {build["dir"]}')
            key = 'in' if kind == 'In' else 'out'
            # A text-bearing shape is two objects (box + text), and a group is many: all
            # of a drawable's objects take its build.
            for k in targets:
                if k in objects: objects[k][key] = dict(build)

# ── Keynote PNG export (AppleScript) ──────────────────────────────────────
def export_pngs(key_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    script = f'''
    tell application "Keynote"
      set d to open POSIX file "{key_path}"
      export d to POSIX file "{out_dir}" as slide images with properties {{image format:PNG, skipped slides:false, all stages:false}}
      close d saving no
    end tell'''
    subprocess.run(['osascript', '-e', script], check=True)
    files = sorted(glob.glob(os.path.join(out_dir, '*.png')))
    return files

# ── main ──────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('key', help='.key file, or a folder keynote-parser already unpacked')
    ap.add_argument('show', help='show name under shows/')
    ap.add_argument('--band', type=int, help='first asset number (default: next free hundred)')
    ap.add_argument('--into', action='store_true', help='splice into the existing show instead of creating one')
    ap.add_argument('--after', type=int, help='with --into: insert after this scene id (default: end)')
    ap.add_argument('--png', action='store_true', help='flatten unsupported slides via Keynote PNG export')
    ap.add_argument('--dry', action='store_true', help='print the scenes, write nothing')
    args = ap.parse_args()

    key = os.path.abspath(args.key)
    if os.path.isdir(os.path.join(key, 'Index')):
        unpacked = key
    else:
        unpacked = tempfile.mkdtemp(prefix='keynote-')
        kp = os.path.join(VENV, 'keynote-parser')
        if not os.path.exists(kp): sys.exit('keynote-parser not installed — run scripts/try-keynote-parser.sh first')
        subprocess.run([kp, 'unpack', key, '--output', unpacked], check=True)
    deck = Deck(unpacked)

    show_dir = os.path.join(ROOT, 'shows', args.show)
    assets_dir = os.path.join(ROOT, 'assets', args.show)
    band = args.band
    if band is None:
        used = []
        own = os.path.realpath(assets_dir)
        for root, _, files in os.walk(os.path.join(ROOT, 'assets')):
            # A re-import replaces this show's own copies, so they don't count as taken —
            # otherwise every re-run moves the deck up a hundred and leaves the old set behind.
            if os.path.realpath(root).startswith(own): continue
            for f in files:
                m = re.match(r'(\d+)', f)
                if m: used.append(int(m.group(1)))
        band = ((max(used) // 100) + 1) * 100 if used else 600
    imp = Importer(deck, args.show, band, assets_dir if not args.dry else tempfile.mkdtemp())
    scenes = imp.run()

    # PNG fallback: whole-slide images for the slides the report flagged.
    flagged = sorted({n for n, m in imp.report if 'flattened to PNG' in m})
    if flagged and args.png and not args.dry:
        pngs = export_pngs(key, tempfile.mkdtemp(prefix='keynote-png-'))
        for n in flagged:
            if n - 1 < len(pngs):
                num = imp.next_asset; imp.next_asset += 1
                shutil.copy2(pngs[n - 1], os.path.join(assets_dir, f'{num}_slide{n:03d}.png'))
                scenes[n - 1]['objects'] = {'flat': {'type': 'image', 'src': num, 'fit': 'contain', 'z': -150, 'fasten': None}}
                scenes[n - 1]['_note'] += ' (flattened)'
    elif flagged:
        imp.note(0, f'slides {flagged} contain unsupported content; re-run with --png to flatten them via Keynote')

    if args.dry:
        print(json.dumps(scenes, indent=2))
    elif args.into:
        path = os.path.join(show_dir, 'script.json')
        script = json.load(open(path))
        top = max([s.get('id', 0) for s in script] + [0])
        for i, s in enumerate(scenes): s['id'] = top + i + 1
        at = len(script)
        if args.after is not None:
            at = next((i + 1 for i, s in enumerate(script) if s.get('id') == args.after), len(script))
        script[at:at] = scenes
        json.dump(script, open(path, 'w'), indent=2, ensure_ascii=False); open(path, 'a').write('\n')
        print(f'spliced {len(scenes)} scenes into shows/{args.show}/script.json after position {at}')
    else:
        os.makedirs(show_dir, exist_ok=True)
        json.dump(scenes, open(os.path.join(show_dir, 'script.json'), 'w'), indent=2, ensure_ascii=False)
        cfg = os.path.join(show_dir, 'config.json')
        if not os.path.exists(cfg):
            json.dump({'_note': f'Imported from {os.path.basename(key)} by scripts/import-keynote.py.',
                       'title': args.show, 'skin': 'default', 'aspect': round(imp.W / imp.H, 3),
                       'mirror': True, 'capabilities': [], 'showcase': []}, open(cfg, 'w'), indent=2)
        idx = os.path.join(ROOT, 'shows', 'index.json')
        index = json.load(open(idx))
        entry = next((s for s in index['shows'] if s['name'] == args.show), None)
        if entry: entry['scenes'] = len(scenes)
        else: index['shows'].append({'name': args.show, 'title': args.show, 'scenes': len(scenes)})
        json.dump(index, open(idx, 'w'), indent=2); open(idx, 'a').write('\n')
        print(f'wrote shows/{args.show}/script.json ({len(scenes)} scenes), {len(imp.assets)} assets → assets/{args.show}/ from {band}')

    # Report, on stderr so --dry output stays valid JSON.
    if imp.report:
        print('\nreport:', file=sys.stderr)
        seen = set()
        for n, m in imp.report:
            line = f'  slide {n:>3}: {m}' if n else f'  {m}'
            if line in seen: continue
            seen.add(line); print(line, file=sys.stderr)

if __name__ == '__main__':
    main()
