#!/usr/bin/env python3
"""Convert a floor drawn in Adobe Illustrator (exported as SVG) into 3D floor data for the kiosk.

Expected layers (top-level <g id=...>, matched case-insensitively):
  base       one closed shape: the mall floor outline (becomes the podium)
  tenant     one closed shape per unit; the unit name is the object name
             (Illustrator writes it to id / data-name). Unnamed shapes are kept as
             unnamed units (small ones become low kiosks). Illustrator's default names ("<Path>") and
             one-letter booth codes count as unnamed; a shape named like a facility ("toilet-sf",
             "eskalator-trn-cnc") is a facility.
  other      optional named rooms that are not shops (lobbies), shown like units
  fasilitas  toilet / lift / escalator / musholla / ATM ... shown as icons
  void       optional atrium openings (holes in the podium); also "bolong" or "kosongan"
  skala      optional: one straight line whose name is its real length ("8000mm", "8m")
A hidden reference image in the file (e.g. the leasing plan, id="denah") is ignored: it is internal
and must never be copied into this repository.

Scale comes from the skala line, or from known areas: --area "Helens Night Mart=800".

Usage (from the repository root; the Illustrator file stays outside the repo):
  python3 tools/3d/svg_to_3d.py "/path/to/Ewalk/LG.svg" --mall ewalk --floor LG --floor-name "Lower Ground" \
      --area "Helens Night Mart=800" --area "Kidzilla=680" [--logo-dir /path/to/logos]
Writes data/3d/<mall>-<floor>.json. Then run tools/3d/register_floor.py to place it on a kiosk floor.
Needs python3 with numpy + opencv-python-headless.
"""
import argparse
import html
import json
import math
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labels import label_box  # noqa: E402

NS = "{http://www.w3.org/2000/svg}"

NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
FACILITY_TYPES = [  # (keyword in the name, icon type)
    ("toilet", "toilet"), ("wc", "toilet"), ("lift", "lift"), ("elevator", "lift"),
    ("escalator", "escalator"), ("eskalator", "escalator"), ("excalat", "escalator"), ("travelator", "escalator"),
    ("tangga", "stairs"), ("tngga", "stairs"), ("stair", "stairs"), ("mushol", "prayer"), ("musal", "prayer"), ("prayer", "prayer"),
    ("atm", "atm"), ("bank", "atm"), ("info", "info"), ("customer", "info"), ("parkir", "parking"), ("parking", "parking"),
    ("p3k", "firstaid"), ("first aid", "firstaid"), ("laktasi", "nursery"), ("nursery", "nursery"),
]
# facilities drawn on the tenant layer, by the start of their name
FACILITY_ROOM = re.compile(r"(toilet|wc\b|e[sx][ck]alat|escalat|travelator|lift\b|elevator|tangga|tngga|stair|mushol|musal|prayer)")


# ---------- geometry helpers ----------
def mat_mul(m, n):
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def parse_transform(t):
    m = (1, 0, 0, 1, 0, 0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", t or ""):
        v = [float(x) for x in re.findall(NUM, args)]
        if name == "matrix" and len(v) == 6:
            n = tuple(v)
        elif name == "translate":
            n = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            n = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            n = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) == 3:
                n = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), n), (1, 0, 0, 1, -v[1], -v[2]))
        else:
            continue
        m = mat_mul(m, n)
    return m


def apply(m, pts):
    a, b, c, d, e, f = m
    return [(a * x + c * y + e, b * x + d * y + f) for x, y in pts]


def arc_pts(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2):
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    phi = math.radians(phi_deg)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    rx, ry = abs(rx), abs(ry)
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0, num / den)) if den else 0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = cp * cxp - sp * cyp + (x1 + x2) / 2, sp * cxp + cp * cyp + (y1 + y2) / 2
    t1 = math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    t2 = math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    dt = t2 - t1
    if sweep and dt < 0:
        dt += 2 * math.pi
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    n = max(2, int(abs(math.degrees(dt)) / 6))
    out = []
    for i in range(1, n + 1):
        t = t1 + dt * i / n
        out.append((cp * rx * math.cos(t) - sp * ry * math.sin(t) + cx, sp * rx * math.cos(t) + cp * ry * math.sin(t) + cy))
    return out


def bez(p0, p1, p2, p3, n=10):
    return [((1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t * t * p2[0] + t ** 3 * p3[0],
             (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t * t * p2[1] + t ** 3 * p3[1])
            for t in (i / n for i in range(1, n + 1))]


def path_subpaths(d):
    """Full SVG path grammar (absolute and relative) -> list of point lists."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|" + NUM, d)
    subs, cur, start, i, cmd = [], [], (0.0, 0.0), 0, None
    x = y = 0.0
    lastc = None  # last control point for S/T

    def nums(k):
        nonlocal i
        v = [float(t) for t in toks[i:i + k]]
        i += k
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                if cur:
                    subs.append(cur)
                cur, (x, y), lastc = [], start, None
                continue
        elif cmd is None:
            break
        rel = cmd.islower()
        C = cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if C == "M":
            px, py = nums(2)
            if cur:
                subs.append(cur)
            x, y = ox + px, oy + py
            start, cur = (x, y), [(x, y)]
            cmd = "l" if rel else "L"  # implicit lineto
            lastc = None
        elif C == "L":
            px, py = nums(2)
            x, y = ox + px, oy + py
            cur.append((x, y))
            lastc = None
        elif C == "H":
            (px,) = nums(1)
            x = ox + px if rel else px
            cur.append((x, y))
            lastc = None
        elif C == "V":
            (py,) = nums(1)
            y = oy + py if rel else py
            cur.append((x, y))
            lastc = None
        elif C == "C":
            a = nums(6)
            p1, p2, p3 = (ox + a[0], oy + a[1]), (ox + a[2], oy + a[3]), (ox + a[4], oy + a[5])
            cur.extend(bez((x, y), p1, p2, p3))
            lastc, (x, y) = p2, p3
        elif C == "S":
            a = nums(4)
            p1 = (2 * x - lastc[0], 2 * y - lastc[1]) if lastc else (x, y)
            p2, p3 = (ox + a[0], oy + a[1]), (ox + a[2], oy + a[3])
            cur.extend(bez((x, y), p1, p2, p3))
            lastc, (x, y) = p2, p3
        elif C == "Q":
            a = nums(4)
            q, p3 = (ox + a[0], oy + a[1]), (ox + a[2], oy + a[3])
            p1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y))
            p2 = (p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1]))
            cur.extend(bez((x, y), p1, p2, p3))
            lastc, (x, y) = q, p3
        elif C == "T":
            a = nums(2)
            q = (2 * x - lastc[0], 2 * y - lastc[1]) if lastc else (x, y)
            p3 = (ox + a[0], oy + a[1])
            p1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y))
            p2 = (p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1]))
            cur.extend(bez((x, y), p1, p2, p3))
            lastc, (x, y) = q, p3
        elif C == "A":
            a = nums(7)
            p3 = (ox + a[5], oy + a[6])
            cur.extend(arc_pts(x, y, a[0], a[1], a[2], int(a[3]), int(a[4]), p3[0], p3[1]))
            x, y = p3
            lastc = None
        else:
            i += 1
    if cur:
        subs.append(cur)
    return subs


def shape_points(el):
    tag = el.tag.replace(NS, "")
    if tag in ("polygon", "polyline"):
        v = [float(t) for t in re.findall(NUM, el.get("points", ""))]
        return [list(zip(v[0::2], v[1::2]))]
    if tag == "rect":
        x, y = float(el.get("x", 0)), float(el.get("y", 0))
        w, h = float(el.get("width", 0)), float(el.get("height", 0))
        return [[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]]
    if tag in ("ellipse", "circle"):
        cx, cy = float(el.get("cx", 0)), float(el.get("cy", 0))
        rx = float(el.get("rx", el.get("r", 0)))
        ry = float(el.get("ry", el.get("r", 0)))
        return [[(cx + rx * math.cos(a), cy + ry * math.sin(a)) for a in (i * math.pi / 24 for i in range(48))]]
    if tag == "path":
        return path_subpaths(el.get("d", ""))
    if tag == "line":
        return [[(float(el.get("x1", 0)), float(el.get("y1", 0))), (float(el.get("x2", 0)), float(el.get("y2", 0)))]]
    return []


def clean(pts):
    out = []
    for p in pts:
        if not out or math.dist(out[-1], p) > 0.05:
            out.append(p)
    if len(out) > 2 and math.dist(out[0], out[-1]) < 0.05:
        out.pop()
    return out


def area(pts):
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))) / 2


def ai_name(el):
    """Illustrator object name: data-name (full text) or id (spaces -> _, specials -> _xHH_)."""
    raw = el.get("data-name") or el.get("id") or ""
    raw = html.unescape(html.unescape(raw))
    if not el.get("data-name"):
        raw = re.sub(r"_x([0-9A-Fa-f]{2,4})_", lambda m: chr(int(m.group(1), 16)), raw)
        raw = raw.replace("_", " ")
    return raw.strip()


def unit_name(el):
    """A unit's name, or "" for Illustrator's default names ("<Path>") and one-letter booth codes ("h", "c")."""
    n = ai_name(el).rstrip("\\").strip()
    return "" if re.fullmatch(r"<[^>]*>", n) or len(n) < 2 else n


def rim_outline(pts, grow):
    """Outline grown by `grow` SVG units with rounded corners (dilate a fine raster, trace it back)."""
    if grow <= 0:
        return pts
    k = 4.0  # raster px per SVG unit
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    pad = grow + 4
    x0, y0 = min(xs) - pad, min(ys) - pad
    mask = np.zeros((int((max(ys) - y0 + pad) * k), int((max(xs) - x0 + pad) * k)), np.uint8)
    cv2.fillPoly(mask, [np.round((np.array(pts) - [x0, y0]) * k).astype(np.int32)], 1)
    r = max(1, int(round(grow * k)))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    cnt = max(cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    cnt = cv2.approxPolyDP(cnt, 0.35 * k, True).reshape(-1, 2)
    return [(x / k + x0, y / k + y0) for x, y in cnt.tolist()]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower().replace("&", "and"))


def match_logo(name, logo_files, meta):
    """A real logo (not a storefront photo, per index.json "kind") whose file name matches the unit name."""
    key = norm(name)
    if len(key) < 3:
        return None
    stems = {f: norm(os.path.splitext(f)[0]) for f in logo_files}
    is_logo = lambda f: meta.get(f, {}).get("kind", "logo") == "logo"  # noqa: E731
    exact = [f for f, st in stems.items() if re.sub(r"\d+$", "", st) == key and is_logo(f)]
    if exact:
        return sorted(exact, key=len)[0]
    pref = [f for f, st in stems.items() if st.startswith(key) and is_logo(f)]
    return sorted(pref, key=len)[0] if len(pref) == 1 else None


# ---------- main ----------
def walk(el, m, layer, out):
    """Collect shapes with their top-level layer name and accumulated transform."""
    m = mat_mul(m, parse_transform(el.get("transform")))
    tag = el.tag.replace(NS, "")
    if tag == "g":
        name = layer or (el.get("data-name") or el.get("id") or "").lower()
        for ch in el:
            walk(ch, m, name, out)
        return
    if tag in ("polygon", "polyline", "rect", "ellipse", "circle", "path", "line"):
        for sub in shape_points(el):
            out.append({"layer": layer or "", "el": el, "pts": clean(apply(m, sub)), "tag": tag})


def artboard(root):
    """The drawing's artboard [x, y, w, h] (Illustrator units): the CMS plan of a "plan"-frame floor uses it as its viewBox."""
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if len(vb) == 4:
        return [round(float(v), 2) for v in vb]
    try:
        return [0.0, 0.0] + [round(float(re.sub(r"[a-z%]+$", "", root.get(k) or "")), 2) for k in ("width", "height")]
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svg")
    ap.add_argument("--mall", required=True)
    ap.add_argument("--floor", required=True)
    ap.add_argument("--floor-name", default=None)
    ap.add_argument("--level", type=int, default=0)
    ap.add_argument("--area", action="append", default=[], help='known printed area: "Name=800"')
    ap.add_argument("--scale", type=float, default=None, help="metres per SVG unit (overrides everything)")
    ap.add_argument("--anchor-min-m2", type=float, default=500.0, help="named units from this size are listed as anchors")
    ap.add_argument("--rim", type=float, default=1.2, help="metres of floor kept around the base outline (rounded)")
    ap.add_argument("--logo-dir", default=None, help="folder of roof logos (+ optional index.json); matches are copied to assets/logos/3d/")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    a = ap.parse_args()

    root = ET.parse(a.svg).getroot()
    shapes = []
    for ch in root:
        if ch.tag.replace(NS, "") == "image":  # reference plan (internal): never read or copied
            continue
        walk(ch, (1, 0, 0, 1, 0, 0), None, shapes)

    def layer_is(s, *names):
        return any(s["layer"].startswith(n) for n in names)

    base = [s for s in shapes if layer_is(s, "base", "lantai", "floor") and len(s["pts"]) >= 3]
    voids = [s for s in shapes if layer_is(s, "void", "bolong", "kosongan") and len(s["pts"]) >= 3]
    tenants = [s for s in shapes if layer_is(s, "tenant", "unit", "toko", "other") and len(s["pts"]) >= 3]
    facs = [s for s in shapes if layer_is(s, "fasilitas", "facility", "facilities") and len(s["pts"]) >= 2]
    rooms = [s for s in tenants if FACILITY_ROOM.match(unit_name(s["el"]).lower())]
    tenants = [s for s in tenants if not any(s is r for r in rooms)]
    facs += rooms
    scal = [s for s in shapes if layer_is(s, "skala", "scale")]
    if not base:
        sys.exit("no 'base' layer with a closed shape found")

    # scale (metres per SVG unit)
    s_m, how = a.scale, "--scale"
    if s_m is None and scal:
        el = scal[0]["el"]
        mm = re.search(r"(" + NUM + r")\s*(mm|cm|m)?", ai_name(el))
        if mm:
            val = float(mm.group(1)) * {"mm": 0.001, "cm": 0.01, "m": 1.0, None: 0.001}[mm.group(2)]
            p = scal[0]["pts"]
            s_m, how = val / math.dist(p[0], p[-1]), f"skala line '{ai_name(el)}'"
    known = {}
    for kv in a.area:
        k, v = kv.rsplit("=", 1)
        known[norm(k)] = float(v)
    samples = []
    for s in tenants:
        k = norm(ai_name(s["el"]))
        if k in known:
            samples.append((math.sqrt(known[k] / area(s["pts"])), ai_name(s["el"])))
    if s_m is None:
        if not samples:
            sys.exit("no scale: add a 'skala' line, --area pairs, or --scale")
        vals = sorted(v for v, _ in samples)
        s_m, how = vals[len(vals) // 2], f"median of {len(samples)} known areas"

    bpts = max(base, key=lambda s: area(s["pts"]))["pts"]
    base_cnt = np.array(bpts, np.float32).reshape(-1, 1, 2)
    xs, ys = [p[0] for p in bpts], [p[1] for p in bpts]
    ox, oy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2

    def m_(pts):
        return [[round((x - ox) * s_m, 2), round((y - oy) * s_m, 2)] for x, y in pts]

    W = int(math.ceil(max(max(p[0] for s in shapes for p in s["pts"]), max(xs)))) + 4
    H = int(math.ceil(max(max(p[1] for s in shapes for p in s["pts"]), max(ys)))) + 4
    sup = 2 if s_m > 0.15 else 1  # raster finer than ~0.1 m for label boxes

    def lbox(pts):
        mask = np.zeros((H * sup, W * sup), np.uint8)
        cv2.fillPoly(mask, [np.round(np.array(pts) * sup).astype(np.int32)], 1)
        if mask.sum() < 6:
            return None
        b = label_box(mask)
        if not b:
            return None
        return {"x": round((b["cx"] / sup - ox) * s_m, 2), "y": round((b["cy"] / sup - oy) * s_m, 2),
                "angle": round(b["angle"], 1), "w": round(b["w"] / sup * s_m * 0.9, 2), "h": round(b["h"] / sup * s_m * 0.85, 2)}

    logo_dir = a.logo_dir
    logo_files = sorted(f for f in os.listdir(logo_dir) if f.lower().endswith((".png", ".webp", ".svg"))) if logo_dir and os.path.isdir(logo_dir) else []
    meta_path = os.path.join(logo_dir, "index.json") if logo_dir else ""
    logo_meta = json.load(open(meta_path)) if meta_path and os.path.exists(meta_path) else {}

    units, used, report = [], {}, []
    for i, s in enumerate(tenants):
        name = unit_name(s["el"])
        a_m2 = area(s["pts"]) * s_m * s_m
        # unnamed shapes standing free in the corridor (not on the mall outline) are booths / kiosks / stages
        on_edge = min(abs(cv2.pointPolygonTest(base_cnt, (float(x), float(y)), True)) for x, y in s["pts"]) * s_m < 1.0
        kind = ("anchor" if a_m2 >= a.anchor_min_m2 else "tenant") if name else ("unit" if on_edge else "kiosk")
        base_id = f"{a.floor}-" + (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or f"u{i + 1}")
        uid, n = base_id, 2
        while uid in used:
            uid, n = f"{base_id}-{n}", n + 1
        used[uid] = 1
        logo = match_logo(name, logo_files, logo_meta) if name else None
        if logo:  # copy into the repo so the kiosk serves it
            os.makedirs(os.path.join(a.root, "assets", "logos", "3d"), exist_ok=True)
            shutil.copyfile(os.path.join(logo_dir, logo), os.path.join(a.root, "assets", "logos", "3d", logo))
        units.append({"id": uid, "name": name, "kind": kind, "area_calc_m2": round(a_m2, 1),
                      "area_m2": known.get(norm(name)), "poly": m_(s["pts"]), "label": lbox(s["pts"]) if name else None,
                      "logo": f"assets/logos/3d/{logo}" if logo else None})
        report.append(f"{uid:28s} {kind:7s} {a_m2:8.1f} m2" + (f"  (plan {known[norm(name)]})" if norm(name) in known else "") + (f"  logo={logo}" if logo else ""))

    facilities = []
    for i, s in enumerate(facs):
        name = unit_name(s["el"])
        if not name:  # an unnamed shape would only be a misleading "i" icon
            report.append(f"facility without a name skipped: name it in Illustrator (Toilet, Lift, ATM, ...)")
            continue
        low = name.lower()
        ftype = next((t for k, t in FACILITY_TYPES if k in low), "info")
        pts = s["pts"]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        if len(pts) >= 3:
            mask = np.zeros((H, W), np.uint8)
            cv2.fillPoly(mask, [np.round(np.array(pts)).astype(np.int32)], 1)
            dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
            yy, xx = np.unravel_index(int(np.argmax(dist)), dist.shape)
            cx, cy, inner = float(xx), float(yy), float(dist.max())
        else:
            inner = 10
        facilities.append({"id": f"{a.floor}-f{i + 1}", "name": name, "type": ftype,
                           "x": round((cx - ox) * s_m, 2), "y": round((cy - oy) * s_m, 2),
                           "size": round(min(5.5, max(2.6, inner * 2 * s_m * 0.8)), 2), "poly": m_(pts) if len(pts) >= 3 else None})
        report.append(f"facility {name:24s} -> {ftype}")

    data = {
        "version": 2, "mall": a.mall, "floor": a.floor, "floor_name": a.floor_name or a.floor, "level": a.level,
        "source_svg": os.path.basename(a.svg), "m_per_unit": round(s_m, 5), "origin": [round(ox, 2), round(oy, 2)], "artboard": artboard(root), "rim": a.rim,
        "slab": [{"outer": m_(rim_outline(bpts, a.rim / s_m)), "holes": [m_(v["pts"]) for v in voids]}],
        "units": units, "facilities": facilities,
    }
    os.makedirs(os.path.join(a.root, "data", "3d"), exist_ok=True)
    out = os.path.join(a.root, "data", "3d", f"{a.mall}-{a.floor}.json")
    with open(out, "w") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    print(f"scale {s_m:.4f} m/unit ({how}); {len(units)} units, {len(facilities)} facilities -> {os.path.relpath(out, a.root)}")
    for v, nm in samples:
        print(f"  scale sample {nm:22s} {v:.4f} ({(v / s_m - 1) * 100:+.1f}%)")
    print("\n".join(report))


if __name__ == "__main__":
    main()
