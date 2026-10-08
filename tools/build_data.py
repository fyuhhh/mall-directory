#!/usr/bin/env python3
"""
build_data.py — reproducible data build for the e-Walk & Pentacity directory/wayfinding prototype.

Input  : data/raw/mapdata.json      (Mapplic map bhEfnhBRWvijlEasMqb7, copied verbatim)
         data/raw/svg/<layer>.svg   (original floor SVGs, downloaded once from the layer `file` URLs)
         data/raw/url_audit.tsv     (link audit: KIND, id, http code, final url, original url)
         data/raw/logos/*           (original tenant images, downloaded once; cache)
Output : data/directory.json, data/floors/<floorId>.svg, assets/logos/<tenantId>.webp,
         data/debug/<floorId>.svg (+ .png when Google Chrome is available), data/build_log.json

Run    : python3 tools/build_data.py            (network only needed if raw files are missing)
Needs  : Python 3.9+, Pillow (with WebP). Optional: Google Chrome for debug PNGs.
"""
import json, math, os, re, sys, html, shutil, subprocess, unicodedata, urllib.request, urllib.parse
from collections import defaultdict, Counter
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT_FLOORS = os.path.join(ROOT, 'data', 'floors')
OUT_DEBUG = os.path.join(ROOT, 'data', 'debug')
OUT_LOGOS = os.path.join(ROOT, 'assets', 'logos')
RAW_LOGOS = os.path.join(RAW, 'logos')
for d in (OUT_FLOORS, OUT_DEBUG, OUT_LOGOS, RAW_LOGOS, os.path.join(RAW, 'svg')):
    os.makedirs(d, exist_ok=True)

for d, ext in ((OUT_LOGOS, '.webp'), (OUT_FLOORS, '.svg'), (OUT_DEBUG, '')):   # outputs are fully regenerated
    for f in os.listdir(d):
        if f.endswith(ext): os.remove(os.path.join(d, f))

LOG = defaultdict(list)          # everything worth reporting ends up in data/build_log.json

# ----------------------------------------------------------------------------------------------
# 1. Floors. Mapplic layer id -> our floor. Mapplic stage = mapWidth x mapHeight (1000 x 800);
#    every layer SVG is drawn into that stage with preserveAspectRatio "xMidYMid meet".
#    location.coord (0..1) * (1000, 800) = route point space ("map px").
# ----------------------------------------------------------------------------------------------
FLOORS = [
    # mapplic layer id,                 floor id,   name,                         short, level, building
    ('lg-pentacity',                    'lg-penta', 'Lower Ground · Pentacity',   'LG', -1, 'pentacity'),
    ('lg-ewalk',                        'lg-ewalk', 'Lower Ground · E-Walk',      'LG', -1, 'ewalk'),
    ('layer1',                          'gf',       'Ground Floor',               'GF',  0, 'both'),
    ('Upper Ground - Pentacity & Ewalk','ug',       'Upper Ground',               'UG',  1, 'both'),
    ('first-floor-pentacity',           'ff-penta', 'First Floor · Pentacity',    '1F',  2, 'pentacity'),
    ('ff-ewalk',                        'ff-ewalk', 'First Floor · E-Walk',       '1F',  2, 'ewalk'),
    ('secondfloor-pentacity',           'sf-penta', 'Second Floor · Pentacity',   '2F',  3, 'pentacity'),
    ('sf-ewalk',                        'sf-ewalk', 'Second Floor · E-Walk',      '2F',  3, 'ewalk'),
]
LAYER2FLOOR = {f[0]: f[1] for f in FLOORS}
FLOOR = {f[1]: dict(layer=f[0], id=f[1], name=f[2], short=f[3], level=f[4], building=f[5]) for f in FLOORS}
GHOST_LAYERS = {'ug-ewalk', 'ug-penta', 'gf-ewalk', 'gf-pentacity', 'lantai-1-penta', 'lantai-2-penta', 'layer2'}
TARGET_W = 1920.0   # floors whose native viewBox is smaller are rescaled to this width (lg-ewalk: 266x150)


def svg_fname(layer_id):
    return layer_id.replace(' ', '_').replace('&', 'and') + '.svg'


def layer_of(loc):
    l = loc.get('layer')
    return l[0] if isinstance(l, list) else l


# ----------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------
def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = s.lower().replace('&', ' and ').replace("'", '')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def clean_ws(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def fetch(url, dest, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (bsb-directory build)'})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, 'wb') as f:
        f.write(r.read())


# ----------------------------------------------------------------------------------------------
# 2. Load source
# ----------------------------------------------------------------------------------------------
MAP = json.load(open(os.path.join(RAW, 'mapdata.json')))
MW, MH = MAP['settings']['mapWidth'], MAP['settings']['mapHeight']
LAYERS = {l['id']: l for l in MAP['layers']}
assert set(LAYERS) == set(LAYER2FLOOR), 'layer set changed in mapdata.json — update FLOORS'

for lid, l in LAYERS.items():
    p = os.path.join(RAW, 'svg', svg_fname(lid))
    if not os.path.exists(p):
        print('downloading', lid); fetch(l['file'], p)


# ----------------------------------------------------------------------------------------------
# 3. SVG cleaning (+ per-floor transform)
# ----------------------------------------------------------------------------------------------
SVG_NS = 'http://www.w3.org/2000/svg'
XLINK_NS = 'http://www.w3.org/1999/xlink'
ET.register_namespace('', SVG_NS)
ET.register_namespace('xlink', XLINK_NS)
T = lambda tag: '{%s}%s' % (SVG_NS, tag)


def parse_viewbox(root):
    return [float(v) for v in re.split(r'[ ,]+', root.get('viewBox').strip())]


def make_transform(vb_native, k):
    """map px (Mapplic stage) -> floor SVG units (after optional rescale by k)."""
    minx, miny, w, h = vb_native
    s = min(MW / w, MH / h)                       # 'meet'
    ox, oy = (MW - w * s) / 2, (MH - h * s) / 2   # centred
    return lambda X, Y: ((minx + (X - ox) / s) * k, (miny + (Y - oy) / s) * k)


# ---- affine helpers for unit-shape matching
def mat_mul(a, b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])


def parse_tf(s):
    m = (1, 0, 0, 1, 0, 0)
    for name, args in re.findall(r'(\w+)\s*\(([^)]*)\)', s or ''):
        v = [float(x) for x in re.findall(r'-?[\d.]+(?:e-?\d+)?', args)]
        if name == 'matrix': t = tuple(v)
        elif name == 'translate': t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == 'scale': t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == 'rotate':
            a = math.radians(v[0]); c, s_ = math.cos(a), math.sin(a)
            t = (c, s_, -s_, c, 0, 0)
            if len(v) == 3:
                t = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        else: continue
        m = mat_mul(m, t)
    return m


def apply(m, p):
    return (m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5])


NUM = r'-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?'


def path_polys(d):
    """Very small SVG path flattener -> list of closed point lists (curves sampled)."""
    toks = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|' + NUM, d)
    polys, cur, i, cmd = [], [], 0, None
    x = y = sx = sy = 0.0
    lc = None
    def nums(n):
        nonlocal i
        v = [float(t) for t in toks[i:i+n]]; i += n; return v
    while i < len(toks):
        t = toks[i]
        if re.match(r'[A-Za-z]', t):
            cmd = t; i += 1
            if cmd in 'Zz':
                if cur: polys.append(cur)
                cur = []; x, y = sx, sy; continue
        elif cmd is None:
            break
        rel = cmd.islower(); c = cmd.upper()
        if c == 'M':
            dx, dy = nums(2)
            x, y = (x+dx, y+dy) if rel else (dx, dy)
            if cur: polys.append(cur)
            cur = [(x, y)]; sx, sy = x, y
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            dx, dy = nums(2); x, y = (x+dx, y+dy) if rel else (dx, dy); cur.append((x, y))
        elif c == 'H':
            dx, = nums(1); x = x+dx if rel else dx; cur.append((x, y))
        elif c == 'V':
            dy, = nums(1); y = y+dy if rel else dy; cur.append((x, y))
        elif c in 'CSQT':
            n = {'C': 6, 'S': 4, 'Q': 4, 'T': 2}[c]
            v = nums(n)
            if rel: v = [v[j] + (x if j % 2 == 0 else y) for j in range(n)]
            pts = [(x, y)] + [(v[j], v[j+1]) for j in range(0, n, 2)]
            for tt in (0.25, 0.5, 0.75, 1.0):   # coarse sampling of control polygon
                if len(pts) == 4:
                    a, b, cc, dd = pts; u = 1-tt
                    cur.append((u**3*a[0]+3*u*u*tt*b[0]+3*u*tt*tt*cc[0]+tt**3*dd[0],
                                u**3*a[1]+3*u*u*tt*b[1]+3*u*tt*tt*cc[1]+tt**3*dd[1]))
                elif len(pts) == 3:
                    a, b, cc = pts; u = 1-tt
                    cur.append((u*u*a[0]+2*u*tt*b[0]+tt*tt*cc[0], u*u*a[1]+2*u*tt*b[1]+tt*tt*cc[1]))
                else:
                    cur.append(pts[-1]); break
            x, y = pts[-1]
        elif c == 'A':
            v = nums(7); x, y = (x+v[5], y+v[6]) if rel else (v[5], v[6]); cur.append((x, y))
        else:
            i += 1
    if cur: polys.append(cur)
    return [p for p in polys if len(p) >= 3]


def poly_area(p):
    return abs(sum(p[i][0]*p[i-1][1]-p[i-1][0]*p[i][1] for i in range(len(p)))) / 2


def pip(pt, poly):
    x, y = pt; inside = False; j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def clean_svg(layer_id, fid):
    """Returns (ElementTree root, viewBox, k, stats). Strips editor junk, prefixes ids."""
    src = os.path.join(RAW, 'svg', svg_fname(layer_id))
    raw_bytes = os.path.getsize(src)
    tree = ET.parse(src); root = tree.getroot()
    vb = parse_viewbox(root)
    stats = dict(rawBytes=raw_bytes, removed=Counter())
    # strip Illustrator private data / metadata / dead raster refs
    parent = {c: p for p in root.iter() for c in p}
    for el in list(root.iter()):
        tag = el.tag
        ns_ok = tag.startswith('{%s}' % SVG_NS)
        local = tag.split('}')[-1]
        drop = False
        if not ns_ok: drop = True                          # i:aipgf, i:pgf (Adobe private, ~1 MB each)
        elif local in ('metadata', 'title', 'desc'): drop = True
        elif local == 'image':
            href = el.get('{%s}href' % XLINK_NS) or el.get('href') or ''
            if not href.startswith('data:'): drop = True   # relative PNGs ("full area - GF-1.png") never uploaded -> 404
            elif len(href) > 200_000: drop = True
        if drop and el in parent:
            parent[el].remove(el); stats['removed'][local] += 1
    for a in list(root.attrib):
        if a in ('width', 'height', 'x', 'y', 'version', 'style', 'enable-background') or a.startswith('{http://ns.adobe'):
            del root.attrib[a]
    # prefix every id (several floors may be inlined into one DOM)
    idmap = {}
    for el in root.iter():
        if el.get('id'):
            old = el.get('id'); new = f'{fid}--{old}'; idmap[old] = new; el.set('id', new)
            if old in ('base', 'tenant', 'text', 'lantai-atas', 'surface1'):
                el.set('class', (el.get('class', '') + ' layer-' + old).strip())
    def fix(v):
        v = re.sub(r'url\(#([^)]+)\)', lambda m: f'url(#{idmap.get(m.group(1), m.group(1))})', v)
        return v
    for el in root.iter():
        for a, v in list(el.attrib.items()):
            if 'url(#' in v: el.set(a, fix(v))
            if a in ('{%s}href' % XLINK_NS, 'href') and v.startswith('#'):
                el.set(a, '#' + idmap.get(v[1:], v[1:]))
    # rescale tiny viewBoxes (lg-ewalk is 266x150) so every floor is ~1920 units wide
    k = 1.0
    if vb[2] < TARGET_W * 0.9:
        k = TARGET_W / vb[2]
        g = ET.Element(T('g'), {'transform': f'scale({k:.6f})', 'class': 'rescaled'})
        for c in list(root):
            if c.tag != T('defs'):
                root.remove(c); g.append(c)
        root.append(g)
        vb = [vb[0]*k, vb[1]*k, vb[2]*k, vb[3]*k]
        stats['rescaledBy'] = round(k, 6)
    vb = [round(v, 3) for v in vb]
    root.set('viewBox', ' '.join(f'{v:g}' for v in vb))
    root.set('class', f'floor-plan floor-{fid}')
    root.set('data-floor', fid)
    return tree, root, vb, k, stats


def collect_shapes(root):
    """Closed shapes inside the Illustrator 'tenant' group (final SVG user space)."""
    out = []
    def walk(el, m, inside):
        local = el.tag.split('}')[-1]
        if local in ('defs', 'clipPath', 'mask', 'symbol', 'pattern'): return
        if 'layer-text' in (el.get('class') or ''): return
        inside = inside or 'layer-tenant' in (el.get('class') or '')
        m = mat_mul(m, parse_tf(el.get('transform')))
        polys = []
        if local == 'polygon':
            v = [float(t) for t in re.findall(NUM, el.get('points', ''))]
            polys = [list(zip(v[0::2], v[1::2]))]
        elif local == 'path':
            polys = path_polys(el.get('d', ''))
        elif local == 'rect':
            x, y, w, h = (float(el.get(a, 0)) for a in ('x', 'y', 'width', 'height'))
            polys = [[(x, y), (x+w, y), (x+w, y+h), (x, y+h)]]
        for p in polys:
            p = [apply(m, q) for q in p]
            a = poly_area(p)
            if a > 0 and inside: out.append((a, p, el))
        for c in el: walk(c, m, inside)
    walk(root, (1, 0, 0, 1, 0, 0), False)
    return out


SVG = {}
for lid, fid in LAYER2FLOOR.items():
    tree, root, vb, k, stats = clean_svg(lid, fid)
    native = parse_viewbox(ET.parse(os.path.join(RAW, 'svg', svg_fname(lid))).getroot())
    SVG[fid] = dict(tree=tree, root=root, vb=vb, k=k, stats=stats, tf=make_transform(native, k))
    FLOOR[fid]['viewBox'] = vb


# ----------------------------------------------------------------------------------------------
# 4. Graph from Mapplic routes
# ----------------------------------------------------------------------------------------------
SNAP_TOL_PX = 1.0      # map px: vertices closer than this are one node (Mapplic joins coincident vertices)
TJOIN_TOL_PX = 1.0     # dangling polyline ends this close to another segment get spliced in
routes = [r for r in MAP['routes'] if r.get('points') and r.get('layer') in LAYER2FLOOR]
ghost_routes = [r for r in MAP['routes'] if r.get('points') and r.get('layer') not in LAYER2FLOOR]
LOG['routes'] = dict(total=len(MAP['routes']), realLayer=len(routes), ghostOrEmpty=len(MAP['routes']) - len(routes))


def pts_of(r):
    return [tuple(float(v) for v in p.split(',')) for p in r['points'].split()]


class Graph:
    def __init__(self):
        self.nodes = {}            # id -> dict(floor, x, y, mx, my)
        self.adj = defaultdict(dict)
        self.edges = {}            # (a,b,type) -> cost   (walk/lift/stairs/crossing stored a<b; escalator directed)
        self.by_floor = defaultdict(list)
        self.n = 0

    def add_node(self, fid, mx, my):
        self.n += 1; nid = f'n{self.n}'
        x, y = SVG[fid]['tf'](mx, my)
        self.nodes[nid] = dict(id=nid, floor=fid, x=round(x, 2), y=round(y, 2), mx=mx, my=my)
        self.by_floor[fid].append(nid); return nid

    def find(self, fid, mx, my, tol):
        best, bd = None, tol
        for nid in self.by_floor[fid]:
            n = self.nodes[nid]; d = math.hypot(n['mx']-mx, n['my']-my)
            if d <= bd: best, bd = nid, d
        return best

    def node_at(self, fid, mx, my, tol=SNAP_TOL_PX):
        return self.find(fid, mx, my, tol) or self.add_node(fid, mx, my)

    def add_edge(self, a, b, typ='walk', cost=None):
        if a == b: return
        if cost is None:
            na, nb = self.nodes[a], self.nodes[b]
            cost = math.hypot(na['x']-nb['x'], na['y']-nb['y'])
        key = (a, b, typ) if typ.startswith('escalator') else (min(a, b, key=lambda s: int(s[1:])), max(a, b, key=lambda s: int(s[1:])), typ)
        self.edges[key] = min(cost, self.edges.get(key, 1e18))

    def walk_segments(self, fid):
        return [(a, b) for (a, b, t) in self.edges if t == 'walk' and self.nodes[a]['floor'] == fid]


G = Graph()
route_first_node = {}      # route id -> node id of its first vertex (the endpoint side, see report)
for r in routes:
    fid = LAYER2FLOOR[r['layer']]
    prev = None
    nodes_r = []
    for (mx, my) in pts_of(r):
        nid = G.node_at(fid, mx, my)
        if prev and prev != nid: G.add_edge(prev, nid)
        prev = nid; nodes_r.append(nid)
    route_first_node[r['id']] = nodes_r[0]

# T-junctions: dangling vertices lying on another segment -> split that segment
deg = Counter()
for (a, b, t) in G.edges:
    deg[a] += 1; deg[b] += 1
tj = 0
for nid, n in list(G.nodes.items()):
    if deg[nid] != 1: continue
    fid = n['floor']
    for (a, b) in G.walk_segments(fid):
        if nid in (a, b): continue
        A, B = G.nodes[a], G.nodes[b]
        ax, ay, bx, by = A['mx'], A['my'], B['mx'], B['my']
        L2 = (bx-ax)**2 + (by-ay)**2
        if L2 == 0: continue
        t = ((n['mx']-ax)*(bx-ax) + (n['my']-ay)*(by-ay)) / L2
        if 0.02 < t < 0.98:
            px, py = ax + t*(bx-ax), ay + t*(by-ay)
            if math.hypot(px-n['mx'], py-n['my']) <= TJOIN_TOL_PX:
                del G.edges[(min(a, b, key=lambda s: int(s[1:])), max(a, b, key=lambda s: int(s[1:])), 'walk')]
                G.add_edge(a, nid); G.add_edge(nid, b); tj += 1
                LOG['tJunctions'].append(dict(node=nid, floor=fid, splitEdge=[a, b]))
                break

# ---- per-floor unit scale (detail floors are zoomed-in drawings; normalise walking cost)
def bank_of(endpoint):
    """'esc-a-penta-3' -> 'esc-a-penta', 'lift-ewalk' -> 'lift-ewalk', 'cross-ff' -> None"""
    m = re.match(r'^(?:(lift)|esc-?([abc]))-(penta|ewalk)', endpoint)
    if not m: return None
    return f"{'lift' if m.group(1) else 'esc-' + m.group(2)}-{m.group(3)}"

bank_pos = defaultdict(lambda: defaultdict(list))   # bank -> floor -> [(x,y) svg]
for r in routes:
    if r.get('connect') and r.get('endpoint'):
        b = bank_of(r['endpoint'])
        if b:
            n = G.nodes[route_first_node[r['id']]]
            bank_pos[b][n['floor']].append((n['x'], n['y']))

REF = {'pentacity': None, 'ewalk': None}
unit_scale = {}
for fid, f in FLOOR.items():
    if f['building'] == 'both':
        unit_scale[fid] = 1.0; continue
    ref = 'ug' if f['level'] > 1 else 'gf'
    ratios = []
    banks = [b for b in bank_pos if f['building'][:5] in b and fid in bank_pos[b] and ref in bank_pos[b]]
    P = {b: [sum(c)/len(c) for c in zip(*bank_pos[b][fid])] for b in banks}
    Q = {b: [sum(c)/len(c) for c in zip(*bank_pos[b][ref])] for b in banks}
    for i in range(len(banks)):
        for j in range(i+1, len(banks)):
            dp = math.dist(P[banks[i]], P[banks[j]]); dq = math.dist(Q[banks[i]], Q[banks[j]])
            if dp > 5: ratios.append(dq / dp)
    if ratios:
        unit_scale[fid] = round(math.exp(sum(math.log(r) for r in ratios)/len(ratios)), 4)   # geometric mean
    else:
        unit_scale[fid] = None
    LOG['unitScale'].append(dict(floor=fid, ref=ref, banks=banks, ratios=[round(r, 3) for r in ratios]))
# floors without anchors: borrow from the same-level / same-building neighbour
fallback = {k: v for k, v in unit_scale.items() if v}
for fid, v in unit_scale.items():
    if not v:
        same_b = [unit_scale[o] for o in fallback if FLOOR[o]['building'] == FLOOR[fid]['building'] and FLOOR[o]['building'] != 'both']
        unit_scale[fid] = round(sum(same_b)/len(same_b), 4) if same_b else 1.0
        LOG['unitScaleFallback'].append(fid)
for fid in FLOOR: FLOOR[fid]['unitScale'] = unit_scale[fid]
# rescale walk costs
for key in list(G.edges):
    a, b, t = key
    if t == 'walk':
        G.edges[key] = G.edges[key] * unit_scale[G.nodes[a]['floor']]

# ---- inter-floor connectors
REF_COST_SCALE = TARGET_W / MW      # Mapplic weight is in map px; express it in GF svg units (1.92)
DEFAULT_WEIGHT = {'escalator': 10, 'lift': 20, 'stairs': 15, 'crossing': 0}
LIFT_MIN_WEIGHT = 20                # lifts in source have weight 2..5 (cheaper than escalators) -> wait-time floor
conn_groups = defaultdict(list)
for r in routes:
    if r.get('connect') and r.get('endpoint'):
        conn_groups[r['endpoint']].append(r)
for r in ghost_routes:
    if r.get('connect') and r.get('endpoint'):
        LOG['ghostConnectors'].append(dict(route=r['id'], endpoint=r['endpoint'], layer=r.get('layer')))

def conn_type(ep):
    e = ep.lower()
    if e.startswith('lift'): return 'lift'
    if e.startswith('cross'): return 'crossing'
    if e.startswith('tangga') or e.startswith('stair'): return 'stairs'
    return 'escalator'

# field corrections (connectors that don't exist on site / one-way escalators)
_ov_path = os.path.join(ROOT, 'data', 'overrides', 'connectors.json')
CONN_OV = json.load(open(_ov_path, encoding='utf-8')) if os.path.exists(_ov_path) else {}
CONN_DISABLE = CONN_OV.get('disable', {})
CONN_ONEWAY = CONN_OV.get('oneway', {})
LOG['connectorOverrides'] = dict(disabled=sorted(CONN_DISABLE), oneway=CONN_ONEWAY,
                                 unknown=sorted(k for k in list(CONN_DISABLE) + list(CONN_ONEWAY) if k not in conn_groups))

AMEN = {}     # (floor,node,type) -> amenity
for ep, rs in sorted(conn_groups.items()):
    if ep in CONN_DISABLE: continue
    typ = conn_type(ep)
    ends = []
    for r in rs:
        nid = route_first_node[r['id']]; n = G.nodes[nid]
        w = r.get('weight')
        ends.append(dict(route=r['id'], node=nid, floor=n['floor'], level=FLOOR[n['floor']]['level'],
                         w=float(w) if w not in (None, '') else None))
        bank = bank_of(ep) or ('bridge' if typ == 'crossing' else ep)
        akey = (n['floor'], nid, typ)
        if akey not in AMEN:
            AMEN[akey] = dict(bank=bank, type=typ, floor=n['floor'], x=n['x'], y=n['y'], node=nid, connectors=set())
        AMEN[akey]['connectors'].add(ep)
    floors_in = {e['floor'] for e in ends}
    if len(floors_in) < 2:
        LOG['danglingConnectors'].append(dict(endpoint=ep, floors=sorted(floors_in), routes=[e['route'] for e in ends]))
        continue
    # one end per floor (if several on the same floor, they are joined by walking already or are the same node)
    per_floor = {}
    for e in ends: per_floor.setdefault(e['floor'], e)
    ends = sorted(per_floor.values(), key=lambda e: (e['level'], e['floor']))
    pairs = list(zip(ends, ends[1:])) if typ != 'crossing' else [(ends[0], e) for e in ends[1:]]
    for a, b in pairs:
        ws = [x for x in (a['w'], b['w']) if x is not None]
        w = sum(ws)/len(ws) if ws else DEFAULT_WEIGHT[typ]
        if typ == 'lift': w = max(w, LIFT_MIN_WEIGHT)
        dl = abs(b['level'] - a['level'])
        cost = round(w * max(dl, 1) * REF_COST_SCALE, 2)
        if typ == 'escalator':
            lo, hi = (a, b) if a['level'] <= b['level'] else (b, a)
            ow = CONN_ONEWAY.get(ep)
            if ow != 'down': G.add_edge(lo['node'], hi['node'], 'escalator-up', cost)
            if ow != 'up': G.add_edge(hi['node'], lo['node'], 'escalator-down', cost)
        else:
            G.add_edge(a['node'], b['node'], typ, cost)
        LOG['connectorEdges'].append(dict(endpoint=ep, type=typ, a=a['floor'], b=b['floor'], cost=cost, srcWeight=ws or None))


# ----------------------------------------------------------------------------------------------
# 5. Locations -> tenants / kiosks
# ----------------------------------------------------------------------------------------------
CATEGORIES = [
    ('food-beverage', 'Food & Beverage', 'utensils'),
    ('fashion', 'Fashion & Lifestyle', 'shirt'),
    ('beauty-health', 'Beauty & Health', 'sparkles'),
    ('electronics', 'Gadgets & Electronics', 'smartphone'),
    ('kids-family', 'Kids & Family', 'baby'),
    ('entertainment', 'Entertainment', 'clapperboard'),
    ('department-store', 'Department Store & Supermarket', 'shopping-cart'),
    ('services', 'Hotel, Travel & Services', 'concierge-bell'),
]
SRC_GROUP = {
    'FOOD & BEVERAGES': 'food-beverage', 'FASHION & LIFESTYLE': 'fashion', 'BEAUTY & HEALTH': 'beauty-health',
    'GADGETS & ELECTRONICS': 'electronics', 'GADGET': 'electronics', 'KIDS & FAMILY': 'kids-family',
    'ENTERTAINMENT': 'entertainment', 'DEPARTMENT STORE & SUPERMARKET': 'department-store',
    'HOTEL & TRAVEL': 'services',
}

# Curated corrections keyed by Mapplic location id (exact, incl. trailing spaces).
# name: display name; cat: category override; url: replacement (verified 200) or None to drop.
FIX = {
    "BEARD PAPA' S": dict(name="Beard Papa's"), 'TEA BREAK': dict(name='Tea Break'),
    'CAPTAIN GELATO': dict(name='Captain Gelato'), "BARRA'S  ": dict(name="Barra's"),
    "ROTI  'O": dict(name="Roti'O"), 'SHARE TEA  ': dict(name='Share Tea', cat='food-beverage'),
    'COLL FROYO': dict(name="Col's Froyo"), 'BAKSO BK ': dict(name='Bakso BK'),
    'NEW STAR KOPITAM': dict(name='New Star Kopitiam'), 'ESSENTIALS  ': dict(name='Essentials'),
    'STROBERI  ': dict(name='Stroberi'), 'BAKOEL BAMBU  ': dict(name='Bakoel Bamboe'),
    'JAMU KULIT ': dict(name='Java Kulit', cat='fashion', url='https://www.tokopedia.com/javakulitofficial'),
    'WACOAL ': dict(name='Wacoal'), 'LITTLE X.EIGHT  ': dict(name='Little X.Eight'),
    'POLO  ': dict(name='Polo'), 'New Era ': dict(cat='fashion'), 'LOGO  ': dict(name='Logo'),
    'corcs': dict(name='Crocs', url='https://www.crocs.co.id/'), '3SECOND ': dict(name='3Second'),
    'Marrugame Udon   ': dict(name='Marugame Udon'), 'FUN Station  ': dict(name='Fun Station'),
    'GC STREET BBQ  ': dict(name='GC Street BBQ'), 'wrangler  ': dict(name='Wrangler'),
    'Skechers   ': dict(cat='fashion'), 'Skechers ': dict(cat='fashion'), 'Skechers  ': dict(cat='fashion'),
    'Puma ': dict(cat='fashion', url='https://id.puma.com/'),
    'SOLARIA ': dict(name='Solaria'), 'Pyaless Shoes - Ewalk': dict(name='Payless'),
    'Hok Ben ': dict(name='HokBen'), 'Payles - Pentacty': dict(name='Payless'),
    'Planet Sport ': dict(name='Planet Sports'), 'SMIGGLE ': dict(name='Smiggle', cat='kids-family'),
    'JETE ': dict(name='Jete', url='https://jete.id/'), 'Hush Pupies': dict(name='Hush Puppies', url='https://hushpuppies.co.id/'),
    'Asisc': dict(name='Asics'), 'MI Store': dict(name='Xiaomi Store', cat='electronics'),
    'BOSE ': dict(name='Bose'), 'REDDOG ': dict(name='Red Dog'), 'Shilin': dict(name='Shihlin'),
    'Lilla Lable ': dict(name='Lilla Label'), 'MR Miles': dict(name='Mr Miles'), ' C & F ': dict(name='C&F'),
    'Lego ': dict(cat='kids-family'), 'Skinarma ': dict(cat='electronics'),
    'Erha ': dict(name='Erha Apothecary', cat='beauty-health', url=None),
    'Oh Some': dict(name='OH!SOME'), 'Buttonscarve': dict(name='Buttonscarves'), "D'Crepes": dict(name="D'Crepes"), 'dcrepes': dict(name="D'Crepes"), 'Sports Station - Pentacty': dict(name='Sports Station'),
    'Sports Station  - Ewalk ': dict(name='Sports Station'), 'Batik Keris - Ewalk': dict(name='Batik Keris'),
    'Shem ramen ': dict(name='Shem Ramen'), 'Ibox ': dict(name='iBox'),
    'Samsung  ': dict(name='Samsung Experience Store'), ' Eprise': dict(name='Eprise'),
    'Mississipi': dict(name='Mississippi'), "LEVI'S": dict(name="Levi's"), 'loc9': dict(name='Hammer'),
    'Moc': dict(name='MOC'), 'Body Shop': dict(name='The Body Shop', url=None), 'Watsons ': dict(name='Watsons'),
    'Play works': dict(name='Playworks'), 'BY AURA': dict(name='By Aura'),
    'Optic seis': dict(name='Optik Seis'), 'Optic Seis  ': dict(name='Optik Seis'),
    'Optic Tunggal ': dict(name='Optik Tunggal'), 'Melawai': dict(name='Optik Melawai'),
    'C & f Perfume': dict(name='C&F Perfume'), 'DIGIPLUS': dict(name='Digiplus', cat='electronics'),
    'ET CATERA': dict(name='Et Cetera & Wood'), 'Havainas': dict(name='Havaianas'),
    'Vivtoria Secret': dict(name="Victoria's Secret"), 'Shem Shushi': dict(name='Shem Sushi'),
    'Flaying Tiger': dict(name='Flying Tiger Copenhagen'), 'Bath & Bodywork': dict(name='Bath & Body Works', cat='beauty-health'),
    'Frank': dict(name='Frank & Co.'), '  Staccato': dict(name='Staccato'),
    'Blend & CO': dict(name='Blend & Co', cat='food-beverage'), 'Uniqlo - Pentacity ': dict(name='Uniqlo'),
    'Fore': dict(name='Fore Coffee', url=None), 'Garmin': dict(cat='electronics'),
    'Sociolla': dict(cat='beauty-health'), 'Pedro': dict(cat='fashion'), 'Charles & Keith': dict(cat='fashion'),
    'Everbest': dict(cat='fashion'), 'Apartemen Aeropolis': dict(cat='services'),
    'H & M': dict(name='H&M'), 'Watch Club': dict(url='https://watchclub.co.id/'),
    'sneakers': dict(name='Sneakers'), 'kidzilla': dict(name='Kidzilla'),
    'jatra': dict(name='Grand Jatra Hotel'), 'matahariewalk': dict(name='Matahari'), 'matahari': dict(name='Matahari'),
    'xxiewalk1': dict(name='Cinema XXI'), 'xxiewalk': dict(name='Cinema XXI'), 'xxi': dict(name='Cinema XXI'),
    'mrdiy-sec': dict(name='MR.DIY'), 'mrdiy_': dict(name='MR.DIY'), 'loc5': dict(name='Food Court', nologo='old map gives Food Court the XXI logo'),
    'pentafoodavanue': dict(name='Penta Food Avenue'), 'gurdian': dict(name='Guardian'),
    'watsons': dict(name='Watsons'), 'andalas': dict(name='Andalas'), 'Andalas ': dict(name='Andalas'),
    'funworld-': dict(name='Fun World'), 'bakoelbambu': dict(name='Bakoel Bamboe'), 'solaria': dict(name='Solaria'),
    'dwidaya': dict(name='Dwidaya Tour'), 'spilla': dict(name='Spilla Jewelry'), 'bauthaul': dict(cat='beauty-health'),
    'cnc': dict(cat='beauty-health'), 'kiddyhope': dict(name='Kiddy Hope'), 'sushitei': dict(cat='food-beverage'),
    'rolaybbq': dict(cat='food-beverage'), 'embassy': dict(cat='entertainment'), 'kidzooona-safari': dict(cat='kids-family'),
    'miniso': dict(url='https://www.miniso.co.id/'), 'Starbucks': dict(url='https://www.starbucks.co.id/'),
    'Starbucks ': dict(url='https://www.starbucks.co.id/'), 'Giordano': dict(url='https://www.giordano.com/'),
    'Watch Club ': dict(url='https://watchclub.co.id/'), 'Everbest ': dict(),
    'Pandora ': dict(cat='fashion'),
}
# Same floor + same building duplicates: keep the first id, drop the others (decided by hand, see report)
DROP_DUP = {
    'Skechers  ': 'UG Pentacity has two "Skechers" markers; the old per-building map (ug-penta) has one, between Andalas and Adidas -> keep "Skechers " and drop this one (next to Planet Sports).',
    ' GC KOREAN BBQ & HOTPOT': 'Second "GC Korean BBQ & Hotpot" marker 6 px from the first one on UG Pentacity -> merged.',
}
DROP_OTHER = {'loc17': 'test entry "blabla" on ghost layer2'}
KIOSK_NAMES = {'ff-pentacity': '1F Pentacity', 'ug-pentacity': 'UG Pentacity', 'gf-pentacity': 'GF Pentacity',
               'lg-pentacity': 'LG Pentacity', 'ug-ewalk': 'UG E-Walk', 'gf-ewalk-right': 'GF E-Walk (right)',
               'gf-ewalk-left': 'GF E-Walk (left)'}
KIOSK_IDS = {'loc16': 'ff-pentacity', 'loc15': 'ug-pentacity', 'loc14': 'gf-pentacity', 'loc13': 'lg-pentacity',
             'loc12': 'ug-ewalk', 'loc11': 'gf-ewalk-right', 'yah-gfe': 'gf-ewalk-left'}

KEYWORDS = [  # (regex on name, keywords)
    (r'starbucks|excelso|kopi|koffie|fore|kopitiam|tea|chatime|share tea|mixue', ['kopi', 'coffee', 'minuman', 'drink']),
    (r'ramen|udon|sushi|hokben|yoshinoya|ichiban|kimukatsu|gyu|marugame|pepper|shem|ta wan|imperial|royal k|korean|gc ', ['makan', 'restoran', 'asian', 'japanese']),
    (r'gelato|froyo|crepes|beard papa|roti|stroberi|boncafe|jus|luuca|captain', ['dessert', 'snack', 'jajan', 'cafe']),
    (r'kfc|pizza|solaria|bakso|bakoel|dapur|gurih|babaku|cabe|alta|barra|red dog|shihlin|food', ['makan', 'restoran', 'food']),
    (r'skechers|vans|converse|adidas|puma|new balance|asics|foot locker|crocs|payless|hush|everbest|my feet|sneakers|aldo|pedro|charles|birkenstock|steve madden|staccato|havaianas', ['sepatu', 'shoes', 'sandal']),
    (r'sports|planet|fisik', ['olahraga', 'sport']),
    (r'optik|optic|dr\. specs', ['kacamata', 'eyewear', 'optical']),
    (r'watch|time concept|startime|garmin', ['jam tangan', 'watch']),
    (r'samsung|ibox|xiaomi|erafone|digiplus|doran|bose|andalas|skinarma', ['hp', 'handphone', 'gadget', 'elektronik']),
    (r'guardian|watsons|sephora|sociolla|body shop|bath|beautyhaul|erha|c&f|heylocal|victoria', ['kosmetik', 'skincare', 'beauty', 'parfum']),
    (r'salon|beautique|ypyr|footlab|mercy|cnc', ['salon', 'perawatan', 'spa', 'klinik']),
    (r'xxi|cinema', ['bioskop', 'film', 'movie', 'nonton']),
    (r'kidz|kiddy|fun world|fun station|cocoland|toys|lego|mothercare|early learning|kidzooona|kidzilla', ['anak', 'mainan', 'playground', 'kids']),
    (r'hypermart|foodmart|matahari|mr\.diy|miniso', ['belanja', 'supermarket', 'groceries']),
    (r'karaoke|embassy', ['karaoke', 'hiburan', 'nightlife']),
    (r'hotel|tour|apartemen', ['hotel', 'travel', 'properti']),
    (r'batik|java kulit|wacoal|bra house|ria miranda|nada puspita|buttonscarves|benang jarum', ['batik', 'busana', 'pakaian']),
]
CAT_KW = {'food-beverage': ['makan', 'minum', 'kuliner'], 'fashion': ['fashion', 'pakaian', 'baju'],
          'beauty-health': ['kecantikan', 'kesehatan'], 'electronics': ['elektronik', 'gadget'],
          'kids-family': ['anak', 'keluarga'], 'entertainment': ['hiburan'], 'department-store': ['belanja'],
          'services': ['layanan']}


def to_svg(fid, coord):
    return SVG[fid]['tf'](coord[0]*MW, coord[1]*MH)


# --- building separator for the combined floors (GF / UG): E-Walk is the north-east block.
#     Decided on map px: f = X - 0.6*Y ; Pentacity f<375, E-Walk f>=375 (gap 347..401 between the
#     closest tenants of the two blocks; verified on data/debug images).
def building_of(fid, mx, my):
    b = FLOOR[fid]['building']
    if b != 'both': return b
    return 'ewalk' if (mx - 0.6*my) >= 375 else 'pentacity'


# --- link audit
AUDIT = {}
for line in open(os.path.join(RAW, 'url_audit.tsv'), encoding='utf-8'):
    parts = line.rstrip('\n').split('\t')
    if len(parts) >= 5 and parts[0] == 'LINK':
        AUDIT[parts[4]] = dict(code=parts[2], final=parts[3])
HTTPS_CHECK = {}   # optional second audit of the final https URLs (tools: curl -L), url -> http code
_hc = os.path.join(RAW, 'https_check.tsv')
if os.path.exists(_hc):
    for line in open(_hc, encoding='utf-8'):
        parts = line.rstrip('\n').split('\t')
        if len(parts) >= 2: HTTPS_CHECK[parts[0]] = parts[1]
TRACK = re.compile(r'^(utm_.*|srsltid|gad_.*|gclid|gbraid|wbraid|igshid|igsh|hl|fbclid|ref|admitad_.*)$', re.I)


def clean_url(u, srcid):
    if not u: return None, None
    u = u.strip()
    if re.fullmatch(r'[\d\s()+-]+', u) or re.fullmatch(r'https?://[\d()+-]+/?', u):
        return None, 'link is a phone number'
    a = AUDIT.get(u)
    note = None
    if a:
        if a['code'] == '000': return None, f'unreachable ({u})'
        fin = a['final']
        if 'google.com/aclk' in u: u = fin; note = 'google ad link -> landing page'
        elif 'perfdrive' in fin or 'maintenance' in fin: pass
        elif a['code'] in ('200', '301'): u = fin
    if 'google.com/aclk' in u: return None, 'google ad link'
    p = urllib.parse.urlsplit(u)
    if not p.netloc or '.' not in p.netloc or 'https//' in u: return None, f'malformed ({u})'
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not TRACK.match(k)]
    host = p.netloc.replace(':443', '')
    u2 = urllib.parse.urlunsplit(('https', host, p.path or '/', urllib.parse.urlencode(q), ''))
    if p.scheme == 'http': note = (note + '; ' if note else '') + 'http->https'
    return u2, note


def clean_phone(p):
    if not p: return None
    digits = re.sub(r'\D', '', p)
    if not digits: return None
    if len(digits) <= 7 and not digits.startswith('0'): return digits          # short codes 14099, 1500600
    if digits.startswith('62'): digits = digits[2:]
    if digits.startswith('0'): digits = digits[1:]
    return '+62' + digits


def plain(s):
    t = re.sub(r'<[^>]+>', ' ', s or ''); t = html.unescape(t)
    return clean_ws(t)


locs = MAP['locations']
real_locs, ghost_locs = [], []
for l in locs:
    (real_locs if layer_of(l) in LAYER2FLOOR else ghost_locs).append(l)
LOG['locations'] = dict(total=len(locs), realLayer=len(real_locs), ghostLayer=len(ghost_locs))

# routes keyed by endpoint (tenant routes start AT the tenant: first vertex == location)
ep_routes = defaultdict(list)
orphan_starts = defaultdict(list)    # floor -> [(node, endpoint)] for routes whose endpoint matches no location
loc_ids = {l['id'] for l in locs}
for r in routes:
    if r.get('connect') or not r.get('endpoint'): continue
    if r['endpoint'] in loc_ids: ep_routes[r['endpoint']].append(r)
    else: orphan_starts[LAYER2FLOOR[r['layer']]].append((route_first_node[r['id']], r['endpoint'], r['id']))


def attach(fid, mx, my, srcid, label):
    """Return (node id, method)."""
    rs = [r for r in ep_routes.get(srcid, []) if LAYER2FLOOR[r['layer']] == fid]
    if rs:
        best = min(rs, key=lambda r: math.dist(pts_of(r)[0], (mx, my)))
        nid = route_first_node[best['id']]
        if any(nid in (a, b) for (a, b, _t) in G.edges):
            return nid, 'route'
        LOG['singlePointRoutes'].append(dict(tenant=label, route=best['id'], points=best['points']))
    cand = [(math.hypot(G.nodes[n]['mx']-mx, G.nodes[n]['my']-my), n, ep, rid) for n, ep, rid in orphan_starts[fid]]
    cand = [c for c in cand if c[0] <= 3.0]
    if cand:
        c = min(cand); LOG['attachedViaOrphanRoute'].append(dict(tenant=label, route=c[3], routeEndpoint=c[2], distPx=round(c[0], 2)))
        return c[1], 'orphan-route'
    me = project_attach(fid, mx, my, label)
    return (me, 'projected') if me else (None, 'none')


def project_attach(fid, mx, my, label, me=None):
    """Project (mx,my) onto the nearest walk edge of the floor, splice a node in, and join a stub from the
    point (new node, or existing node `me`) to it. Returns the point's node id."""
    best = None
    for (a, b) in G.walk_segments(fid):
        if me in (a, b): continue
        A, B = G.nodes[a], G.nodes[b]
        ax, ay, bx, by = A['mx'], A['my'], B['mx'], B['my']
        L2 = (bx-ax)**2 + (by-ay)**2 or 1e-9
        t = max(0, min(1, ((mx-ax)*(bx-ax)+(my-ay)*(by-ay))/L2))
        px, py = ax+t*(bx-ax), ay+t*(by-ay); d = math.hypot(px-mx, py-my)
        if best is None or d < best[0]: best = (d, a, b, t, px, py)
    if best is None: return None
    d, a, b, t, px, py = best
    if t <= 0.001: proj = a
    elif t >= 0.999: proj = b
    else:
        key = (min(a, b, key=lambda s: int(s[1:])), max(a, b, key=lambda s: int(s[1:])), 'walk')
        c = G.edges.pop(key)
        proj = G.add_node(fid, px, py)
        G.add_edge(a, proj, 'walk', c*t); G.add_edge(proj, b, 'walk', c*(1-t))
    if me is None: me = G.add_node(fid, mx, my)
    G.add_edge(me, proj, 'walk', math.hypot(G.nodes[me]['x']-G.nodes[proj]['x'], G.nodes[me]['y']-G.nodes[proj]['y'])*unit_scale[fid])
    LOG['attachedByProjection'].append(dict(what=label, floor=fid, distPx=round(d, 2)))
    return me


# connector ends drawn as single-point polylines have no walking edge -> join them to the corridor
for (fid, nid, typ), a in AMEN.items():
    if not any(t_ == 'walk' and nid in (a_, b_) for (a_, b_, t_) in G.edges):
        n = G.nodes[nid]
        project_attach(fid, n['mx'], n['my'], f"connector {sorted(a['connectors'])}", me=nid)


tenants_pre, kiosks = [], []
for l in real_locs:
    sid = l['id']; fid = LAYER2FLOOR[layer_of(l)]
    mx, my = l['coord'][0]*MW, l['coord'][1]*MH
    x, y = to_svg(fid, l['coord'])
    if sid in DROP_OTHER: LOG['dropped'].append(dict(srcId=sid, reason=DROP_OTHER[sid])); continue
    if sid in KIOSK_IDS:
        node, how = attach(fid, mx, my, sid, KIOSK_IDS[sid])
        kiosks.append(dict(id=KIOSK_IDS[sid], name=KIOSK_NAMES[KIOSK_IDS[sid]],
                           floor=fid, building=building_of(fid, mx, my), x=round(x, 2), y=round(y, 2), node=node, facingDeg=None,
                           srcId=sid, _attach=how))
        continue
    if sid in DROP_DUP: LOG['dropped'].append(dict(srcId=sid, title=l['title'], reason=DROP_DUP[sid])); continue
    fx = FIX.get(sid, {})
    title = clean_ws(l['title'])
    name = fx.get('name') or title
    if name == title and (name.isupper() and len(name) > 4): LOG['allCapsKept'].append(name)
    grp = [clean_ws(g).upper() for g in (l.get('group') or [])]
    cat = fx.get('cat') or (SRC_GROUP.get(grp[0]) if grp else None)
    if not cat: LOG['uncategorized'].append(dict(srcId=sid, name=name))
    if fx.get('cat') and grp and SRC_GROUP.get(grp[0]) != fx['cat']:
        LOG['recategorized'].append(dict(srcId=sid, name=name, src=grp[0], new=fx['cat']))
    elif fx.get('cat') and not grp:
        LOG['categoryAdded'].append(dict(srcId=sid, name=name, new=fx['cat']))
    # link / phone
    link = l.get('link')
    phone_src = l.get('phone')
    if link and re.fullmatch(r'[\d\s()+-]+', link.strip()) and not phone_src: phone_src = link
    if 'url' in fx:
        url, note = fx['url'], 'manual override'
    else:
        url, note = clean_url(link, sid)
    code = HTTPS_CHECK.get(url) if url else None
    if code and (code == '000' or (code >= '404' and code not in ('406', '429'))):
        note = f'https version unreachable ({code})'; url = None
    if link and (note or url != link): LOG['urlChanges'].append(dict(srcId=sid, name=name, before=link, after=url, note=note))
    node, how = attach(fid, mx, my, sid, name)
    d_src = plain(l.get('desc'))
    m = re.match(r'Location:\s*(.*)', d_src, re.I)
    if m and m.group(1).strip().lower() != {'lg': 'lower ground', 'gf': 'ground floor', 'ug': 'upper ground', '1f': 'first floor', '2f': 'second floor'}[FLOOR[fid]['short'].lower()]:
        LOG['descFloorMismatch'].append(dict(srcId=sid, name=name, desc=d_src, layerFloor=FLOOR[fid]['name']))
    if sid.strip() != sid or title != l['title']: LOG['whitespaceFixed'].append(sid)
    if name != title: LOG['renamed'].append(dict(srcId=sid, before=l['title'], after=name))
    tenants_pre.append(dict(name=name, category=cat, floor=fid, building=building_of(fid, mx, my),
                            x=round(x, 2), y=round(y, 2), node=node, phone=clean_phone(phone_src), url=url,
                            desc=None, hours=clean_ws(l.get('hours')) or None, image=l.get('image'),
                            srcId=sid, _attach=how, _mx=mx, _my=my, _nologo=fx.get('nologo')))

# ghost-only check: any ghost tenant whose (normalised) name has no counterpart among real tenants?
def norm(s): return re.sub(r'[^a-z0-9]', '', slug(re.sub(r'\s*-\s*(ewalk|pentacity|pentacty|penta|ug|ff|sc|lg).*$', '', s, flags=re.I)))
real_norms = {norm(t['name']) for t in tenants_pre} | {norm(l['title']) for l in real_locs} | {norm(l['id']) for l in real_locs}
GHOST_ALIAS = {'mistore': 'xiaomistore', 'kidzooonasafari': 'kidzooonasafari', 'mrdiy': 'mrdiy', 'foodcourt': 'foodcourt',
               'footlab': 'footlabreflexology', 'jawakulit': 'javakulit', 'reddog': 'reddog', 'shihlin': 'shihlin'}
for l in ghost_locs:
    n = norm(l['title'])
    hit = n in real_norms or any(n and (n in r or r in n) for r in real_norms if len(r) > 3)
    if l['id'] in DROP_OTHER: continue
    if not hit: LOG['ghostOnly'].append(dict(srcId=l['id'], title=l['title'], layer=layer_of(l)))
    else: LOG['ghostDuplicate'].append(l['id'])

# ids + disambiguation
by_name = defaultdict(list)
for t in tenants_pre: by_name[t['name'].lower()].append(t)
BNAME = {'pentacity': 'Pentacity', 'ewalk': 'E-Walk'}
for nm, ts in by_name.items():
    if len(ts) < 2: continue
    blds = Counter(t['building'] for t in ts)
    for t in ts:
        suffix = [BNAME[t['building']]]
        if blds[t['building']] > 1: suffix.append(FLOOR[t['floor']]['short'])
        t['displayName'] = f"{t['name']} · {' '.join(suffix)}"
    LOG['duplicateNamesKept'].append(dict(name=ts[0]['name'], outlets=[dict(srcId=t['srcId'], floor=t['floor'], building=t['building'], display=t['displayName']) for t in ts]))

base_count = Counter(f"{slug(t['name'])}-{t['floor']}" for t in tenants_pre)
used = set()
for t in tenants_pre:      # same brand twice on a combined floor -> both get the building suffix
    base = f"{slug(t['name'])}-{t['floor']}"
    tid = base if base_count[base] == 1 else f"{base}-{t['building'][:5]}"
    n = 2
    while tid in used: tid = f'{base}-{n}'; n += 1
    used.add(tid); t['id'] = tid

# keywords
for t in tenants_pre:
    kw = []
    for rx, words in KEYWORDS:
        if re.search(rx, t['name'], re.I): kw += words
    kw += CAT_KW.get(t['category'], [])
    kw += [FLOOR[t['floor']]['short'].lower(), BNAME[t['building']].lower()]
    t['keywords'] = list(dict.fromkeys(kw))

# ----------------------------------------------------------------------------------------------
# 6. Logos
# ----------------------------------------------------------------------------------------------
from PIL import Image
def first_url(u):
    """some image fields contain two URLs glued together (Starbucks) -> keep the first"""
    if not u: return u
    i = u.find('http', 8)
    if i > 0: LOG['imageUrlConcatenated'].append(u); return u[:i]
    return u

for l in locs:
    if l.get('image'): l['image'] = first_url(l['image'])
img_users = defaultdict(set)
for l in locs:
    if l.get('image'): img_users[l['image'].split('?')[0]].add(norm(clean_ws(FIX.get(l['id'], {}).get('name') or l['title'])))
brand_img = {}
for l in locs:      # same brand on another entry (incl. ghost) can supply a missing / broken logo
    if l.get('image'): brand_img.setdefault(norm(clean_ws(FIX.get(l['id'], {}).get('name') or l['title'])), []).append(l['image'])
logo_raw_bytes = logo_out_bytes = 0
LOGO_MAX = 256


def raw_logo(url):
    fn = re.sub(r'[^A-Za-z0-9._-]', '_', urllib.parse.unquote(url.split('?')[0].rsplit('/', 1)[-1]))
    tok = re.search(r'token=([0-9a-f]{8})', url)
    fn = (tok.group(1) + '_' if tok else '') + fn
    p = os.path.join(RAW_LOGOS, fn)
    if os.path.exists(p + '.404'): return None
    if not os.path.exists(p):
        try: fetch(url, p)
        except Exception as e:
            open(p + '.404', 'w').write(str(e)); return None
    return p


for t in tenants_pre:
    t['image'] = first_url(t['image'])
    t['logo'] = None
    if t['_nologo']:
        LOG['noLogo'].append(t['id'] + ' (' + t['_nologo'] + ')'); continue
    nb = norm(t['name'])
    srcs = ([t['image']] if t['image'] else []) + [u for u in brand_img.get(nb, []) if u != t['image']
                                                    and not (img_users.get(u.split('?')[0], set()) - {nb})]
    t['logo'] = None
    for i, u in enumerate(srcs):
        p = raw_logo(u)
        if not p: LOG['logoMissing404'].append(dict(tenant=t['id'], url=u)); continue
        try:
            im = Image.open(p); im.load()
        except Exception as e:
            LOG['logoUnreadable'].append(dict(tenant=t['id'], url=u, err=str(e))); continue
        if im.mode not in ('RGB', 'RGBA'): im = im.convert('RGBA')
        im.thumbnail((LOGO_MAX, LOGO_MAX), Image.LANCZOS)
        out = os.path.join(OUT_LOGOS, f"{t['id']}.webp")
        im.save(out, 'WEBP', quality=82, method=6)
        logo_raw_bytes += os.path.getsize(p); logo_out_bytes += os.path.getsize(out)
        t['logo'] = f"assets/logos/{t['id']}.webp"
        if i > 0 or not t['image']: LOG['logoBorrowed'].append(dict(tenant=t['id'], from_=u))
        break
    if not t['logo']: LOG['noLogo'].append(t['id'])
LOG['logoBytes'] = dict(raw=logo_raw_bytes, webp=logo_out_bytes)

# ----------------------------------------------------------------------------------------------
# 7. Tenant unit shapes in the SVG (Mapplic does NOT link them: no SVG id equals a location id).
#    Heuristic: smallest closed shape (outside text/defs) that contains the marker point.
# ----------------------------------------------------------------------------------------------
for fid, S in SVG.items():
    shapes = collect_shapes(S['root'])
    if not shapes:
        LOG['unitMatchingSkipped'].append(dict(floor=fid, reason='no <g id="tenant"> group in this SVG')); continue
    vb_area = S['vb'][2] * S['vb'][3]
    taken = {}
    for t in [t for t in tenants_pre if t['floor'] == fid]:
        hits = [(a, el) for (a, p, el) in shapes if vb_area*0.00004 < a < vb_area*0.04 and pip((t['x'], t['y']), p)]
        if not hits:
            LOG['unitNotFound'].append(dict(tenant=t['id'], floor=fid)); continue
        a, el = min(hits, key=lambda h: h[0])
        if id(el) in taken:
            LOG['unitShared'].append(dict(tenant=t['id'], with_=taken[id(el)])); continue
        taken[id(el)] = t['id']
        el.set('data-tenant', t['id']); el.set('class', (el.get('class', '') + ' unit').strip())
        if not el.get('id') or el.get('id').startswith(fid + '--'): el.set('id', f"unit-{t['id']}")
        LOG['unitMatched'].append(dict(tenant=t['id'], area=round(a)))

# ----------------------------------------------------------------------------------------------
# 8. Write floors (cleaned SVG)
# ----------------------------------------------------------------------------------------------
def round_geom(v, nd=3):
    """round coordinates in d/points to nd decimals (lg-ewalk is Cairo output with 6 decimals)"""
    def f(m):
        g = m.group(0)
        if '.' not in g or 'e' in g.lower() or len(g.split('.')[1]) <= nd: return g     # leave short numbers untouched
        r = round(float(g), nd)
        txt = ('%.*f' % (nd, r)).rstrip('0').rstrip('.') if r != int(r) else str(int(r))
        if txt == '-0': txt = '0'
        prev = v[m.start()-1] if m.start() > 0 else ' '
        return (' ' if prev in '0123456789.' else '') + txt
    return re.sub(NUM, f, v)

for fid, S in SVG.items():
    for el in S['root'].iter():
        for a in ('d', 'points'):
            if el.get(a): el.set(a, round_geom(el.get(a)))
    s = ET.tostring(S['root'], encoding='unicode')
    s = re.sub(r'>\s+<', '><', s)
    out = os.path.join(OUT_FLOORS, f'{fid}.svg')
    open(out, 'w', encoding='utf-8').write(s)
    S['stats']['cleanBytes'] = os.path.getsize(out)
    FLOOR[fid]['svg'] = f'data/floors/{fid}.svg'
    LOG['svg'].append(dict(floor=fid, src=svg_fname(FLOOR[fid]['layer']), rawBytes=S['stats']['rawBytes'],
                           cleanBytes=S['stats']['cleanBytes'], removed=dict(S['stats']['removed']), rescaledBy=S['stats'].get('rescaledBy')))

# ----------------------------------------------------------------------------------------------
# 9. Prune: keep nodes that are in any edge; renumber densely in floor order
# ----------------------------------------------------------------------------------------------
used_nodes = set()
for (a, b, t) in G.edges: used_nodes |= {a, b}
for t in tenants_pre + kiosks: used_nodes.add(t['node'])
order = sorted(used_nodes, key=lambda n: ([f[1] for f in FLOORS].index(G.nodes[n]['floor']), int(n[1:])))
ren = {old: f'n{i+1}' for i, old in enumerate(order)}

amenities = []
seen_am = Counter()
for (fid, nid, typ), a in sorted(AMEN.items(), key=lambda kv: ([f[1] for f in FLOORS].index(kv[0][0]), kv[1]['bank'])):
    base = f"{a['bank']}-{fid}"
    seen_am[base] += 1
    aid = base if seen_am[base] == 1 else f'{base}-{seen_am[base]}'
    bld = building_of(fid, G.nodes[nid]['mx'], G.nodes[nid]['my'])
    m = re.match(r'esc-([abc])', a['bank'])
    label = {'lift': 'Lift', 'crossing': 'Bridge Pentacity – E-Walk', 'stairs': 'Stairs'}.get(typ) or f"Escalator {m.group(1).upper() if m else ''}".strip()
    if typ != 'crossing': label += f" · {BNAME[bld]}"
    to = sorted({G.nodes[b if a_ == nid else a_]['floor'] for (a_, b, t_) in G.edges if t_ != 'walk' and nid in (a_, b)},
                key=lambda f: [x[1] for x in FLOORS].index(f))
    amenities.append(dict(id=aid, type=typ, name=label, floor=fid, building=bld,
                          x=a['x'], y=a['y'], node=ren[nid], toFloors=to, connectors=sorted(a['connectors'])))

graph_nodes = [dict(id=ren[n], floor=G.nodes[n]['floor'], x=G.nodes[n]['x'], y=G.nodes[n]['y']) for n in order]
graph_edges = sorted(([ren[a], ren[b], round(c, 2), t] for (a, b, t), c in G.edges.items()), key=lambda e: (int(e[0][1:]), int(e[1][1:])))

def tenant_out(t):
    return dict(id=t['id'], name=t.get('displayName', t['name']), brand=t['name'], category=t['category'],
                floor=t['floor'], building=t['building'], x=t['x'], y=t['y'], node=ren[t['node']],
                logo=t['logo'], phone=t['phone'], url=t['url'], desc=t['desc'], hours=t['hours'],
                keywords=t['keywords'], srcId=t['srcId'])

tenants_out = sorted((tenant_out(t) for t in tenants_pre), key=lambda t: t['name'].lower())
kiosks_out = [dict(id=k['id'], name=k['name'], floor=k['floor'], building=k['building'], x=k['x'], y=k['y'],
                   node=ren[k['node']], facingDeg=k['facingDeg'], srcId=k['srcId']) for k in kiosks]
kiosks_out.sort(key=lambda k: ([f[1] for f in FLOORS].index(k['floor']), k['id']))

def bbox(points, pad=60):
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    return [round(min(xs)-pad, 1), round(min(ys)-pad, 1), round(max(xs)-min(xs)+2*pad, 1), round(max(ys)-min(ys)+2*pad, 1)]

floors_out = []
for f in FLOORS:
    F = FLOOR[f[1]]
    focus = {}
    for b in ('pentacity', 'ewalk'):
        pts = [(G.nodes[n]['x'], G.nodes[n]['y']) for n in order if G.nodes[n]['floor'] == F['id']
               and building_of(F['id'], G.nodes[n]['mx'], G.nodes[n]['my']) == b]
        if pts: focus[b] = bbox(pts, 40 if F['building'] == 'both' else 120)
    floors_out.append(dict(id=F['id'], name=F['name'], short=F['short'], level=F['level'], building=F['building'],
                           svg=F['svg'], viewBox=F['viewBox'], unitScale=F['unitScale'], focus=focus))

directory = dict(
    meta=dict(generated=datetime.now(timezone.utc).replace(microsecond=0).isoformat(), source='mapplic bhEfnhBRWvijlEasMqb7',
              mapNorthDeg=None,
              notes=['x/y are in each floor SVG viewBox space',
                     'edges: walk/lift/stairs/crossing are undirected; escalator-up/escalator-down are directed (from -> to)',
                     'edge cost unit = Ground-Floor SVG unit (detail floors scaled by floors[].unitScale)',
                     'mapNorthDeg and kiosk facingDeg are null = unknown (to be supplied by the mall)']),
    floors=floors_out,
    categories=[dict(id=c[0], name=c[1], icon=c[2]) for c in CATEGORIES],
    tenants=tenants_out,
    kiosks=kiosks_out,
    amenities=amenities,
    graph=dict(nodes=graph_nodes, edges=graph_edges),
)
json.dump(directory, open(os.path.join(ROOT, 'data', 'directory.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ----------------------------------------------------------------------------------------------
# 10. Debug overlays
# ----------------------------------------------------------------------------------------------
COL = {'walk': '#e11d48', 'lift': '#2563eb', 'escalator-up': '#16a34a', 'escalator-down': '#16a34a', 'crossing': '#a855f7', 'stairs': '#f59e0b'}
NODE = {n['id']: n for n in graph_nodes}
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
for fl in floors_out:
    fid = fl['id']; vb = fl['viewBox']
    inner = open(os.path.join(OUT_FLOORS, f'{fid}.svg'), encoding='utf-8').read()
    inner = re.sub(r'^<svg ', f'<svg x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" ', inner, count=1)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="{" ".join(map(str, vb))}" width="{int(vb[2]*1.5)}" height="{int(vb[3]*1.5)}">',
         '<style>.unit{fill:#facc15 !important;opacity:.9} text{font:7px sans-serif;paint-order:stroke;stroke:#fff;stroke-width:2px}</style>',
         f'<rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" fill="#fff"/>', inner]
    for a, b, c, t in graph_edges:
        A, B = NODE[a], NODE[b]
        if A['floor'] == fid and B['floor'] == fid:
            o.append(f'<line x1="{A["x"]}" y1="{A["y"]}" x2="{B["x"]}" y2="{B["y"]}" stroke="{COL[t]}" stroke-width="1.2"/>')
        elif A['floor'] == fid or B['floor'] == fid:
            P = A if A['floor'] == fid else B; other = B if P is A else A
            o.append(f'<text x="{P["x"]+4}" y="{P["y"]-4}" fill="{COL[t]}">{t}→{other["floor"]}</text>')
    for n in graph_nodes:
        if n['floor'] == fid: o.append(f'<circle cx="{n["x"]}" cy="{n["y"]}" r="1" fill="#111"/>')
    for t in tenants_out:
        if t['floor'] != fid: continue
        c = '#2563eb' if t['building'] == 'pentacity' else '#ea580c'
        N = NODE[t['node']]
        o.append(f'<line x1="{t["x"]}" y1="{t["y"]}" x2="{N["x"]}" y2="{N["y"]}" stroke="#000" stroke-width=".6"/>')
        o.append(f'<circle cx="{t["x"]}" cy="{t["y"]}" r="3" fill="{c}"/><text x="{t["x"]+4}" y="{t["y"]+2}">{html.escape(t["brand"])}</text>')
    for a in amenities:
        if a['floor'] == fid:
            o.append(f'<rect x="{a["x"]-3}" y="{a["y"]-3}" width="6" height="6" fill="none" stroke="{COL.get(a["type"], COL.get("escalator-up"))}" stroke-width="1.5"/>')
    for k in kiosks_out:
        if k['floor'] == fid:
            o.append(f'<path d="M{k["x"]},{k["y"]-9} l3,6 7,1 -5,5 1,7 -6,-3 -6,3 1,-7 -5,-5 7,-1z" fill="#16a34a" stroke="#000" stroke-width=".5"/><text x="{k["x"]+9}" y="{k["y"]-6}" fill="#166534">KIOSK {k["id"]}</text>')
    o.append(f'<text x="{vb[0]+10}" y="{vb[1]+20}" style="font-size:18px">{fid} — {html.escape(fl["name"])} (blue=Pentacity, orange=E-Walk, yellow=matched unit shape)</text></svg>')
    dbg = os.path.join(OUT_DEBUG, f'{fid}.svg')
    open(dbg, 'w', encoding='utf-8').write('\n'.join(o))
    if os.path.exists(chrome) and '--no-png' not in sys.argv:
        W, H = int(vb[2]*1.5), int(vb[3]*1.5)
        subprocess.run([chrome, '--headless', '--disable-gpu', '--hide-scrollbars', f'--screenshot={dbg[:-4]}.png',
                        f'--window-size={W},{H}', 'file://' + dbg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)

# ----------------------------------------------------------------------------------------------
LOG['counts'] = dict(floors=len(floors_out), tenants=len(tenants_out), kiosks=len(kiosks_out), amenities=len(amenities),
                     nodes=len(graph_nodes), edges=len(graph_edges), tJunctions=tj,
                     attach=Counter(t['_attach'] for t in tenants_pre))
json.dump(LOG, open(os.path.join(ROOT, 'data', 'build_log.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
print(json.dumps(LOG['counts'], default=str))
print('unitScale', unit_scale)
