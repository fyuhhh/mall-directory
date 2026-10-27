#!/usr/bin/env python3
"""Build preview 3D model with clean roads, symmetric ruko blocks, and real live CMS tenant data."""
import xml.etree.ElementTree as ET
import html
import json
import math
import os
import re

NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
NS = "{http://www.w3.org/2000/svg}"

def parse_transform(t):
    m = (1, 0, 0, 1, 0, 0)
    if not t: return m
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", t):
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
        else:
            continue
        a, b, c, d, e, f = m
        a2, b2, c2, d2, e2, f2 = n
        m = (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f)
    return m

def apply_mat(m, pts):
    a, b, c, d, e, f = m
    return [(a * x + c * y + e, b * x + d * y + f) for x, y in pts]

def bez(p0, p1, p2, p3, n=8):
    return [((1 - t)**3 * p0[0] + 3 * (1 - t)**2 * t * p1[0] + 3 * (1 - t) * t**2 * p2[0] + t**3 * p3[0],
             (1 - t)**3 * p0[1] + 3 * (1 - t)**2 * t * p1[1] + 3 * (1 - t) * t**2 * p2[1] + t**3 * p3[1])
            for t in (i / n for i in range(1, n + 1))]

def arc_pts(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2):
    if rx == 0 or ry == 0: return [(x2, y2)]
    phi = math.radians(phi_deg)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    rx, ry = abs(rx), abs(ry)
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1: rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0, num / den)) if den else 0
    if large == sweep: co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = cp * cxp - sp * cyp + (x1 + x2) / 2, sp * cxp + cp * cyp + (y1 + y2) / 2
    t1 = math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    t2 = math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    dt = t2 - t1
    if sweep and dt < 0: dt += 2 * math.pi
    if not sweep and dt > 0: dt -= 2 * math.pi
    n = max(2, int(abs(math.degrees(dt)) / 10))
    out = []
    for i in range(1, n + 1):
        t = t1 + dt * i / n
        out.append((cp * rx * math.cos(t) - sp * ry * math.sin(t) + cx, sp * rx * math.cos(t) + cp * ry * math.sin(t) + cy))
    return out

def path_subpaths(d):
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|" + NUM, d)
    subs, cur, start, i, cmd = [], [], (0.0, 0.0), 0, None
    x = y = 0.0
    lastc = None
    def nums(k):
        nonlocal i
        v = [float(t) for t in toks[i:i + k]]
        i += k
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t; i += 1
            if cmd in "Zz":
                if cur: subs.append(cur)
                cur, (x, y), lastc = [], start, None
                continue
        elif cmd is None: break
        rel = cmd.islower(); C = cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if C == "M":
            px, py = nums(2)
            if cur: subs.append(cur)
            x, y = ox + px, oy + py
            start, cur = (x, y), [(x, y)]
            cmd = "l" if rel else "L"; lastc = None
        elif C == "L":
            px, py = nums(2); x, y = ox + px, oy + py; cur.append((x, y)); lastc = None
        elif C == "H":
            (px,) = nums(1); x = ox + px if rel else px; cur.append((x, y)); lastc = None
        elif C == "V":
            (py,) = nums(1); y = oy + py if rel else py; cur.append((x, y)); lastc = None
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
        elif C == "A":
            a = nums(7)
            p3 = (ox + a[5], oy + a[6])
            cur.extend(arc_pts(x, y, a[0], a[1], a[2], int(a[3]), int(a[4]), p3[0], p3[1]))
            x, y = p3; lastc = None
        elif C == "Q":
            a = nums(4)
            p1 = (ox + a[0], oy + a[1])
            p2 = (ox + a[2], oy + a[3])
            for step in range(1, 5):
                t = step / 4.0
                omt = 1.0 - t
                cur.append((omt * omt * x + 2.0 * omt * t * p1[0] + t * t * p2[0],
                            omt * omt * y + 2.0 * omt * t * p1[1] + t * t * p2[1]))
            lastc, (x, y) = p1, p2
        else: i += 1
    if cur: subs.append(cur)
    return subs

def ensure_ccw(poly):
    """Ensure Counter-Clockwise vertex winding order so Three.js normals point upward and never downwards."""
    n = len(poly)
    if n < 3: return poly
    area = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n)) / 2
    if area < 0:
        return poly[::-1]
    return poly

def shape_points(el):
    tag = el.tag.replace(NS, "")
    t = parse_transform(el.get("transform", ""))
    pts_list = []
    if tag in ("polygon", "polyline"):
        v = [float(x) for x in re.findall(NUM, el.get("points", ""))]
        pts_list = [list(zip(v[0::2], v[1::2]))]
    elif tag == "rect":
        x, y = float(el.get("x", 0)), float(el.get("y", 0))
        w, h = float(el.get("width", 0)), float(el.get("height", 0))
        pts_list = [[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]]
    elif tag == "path":
        pts_list = path_subpaths(el.get("d", ""))
    
    out = []
    for pts in pts_list:
        if t != (1, 0, 0, 1, 0, 0):
            pts = apply_mat(t, pts)
        c = []
        for p in pts:
            if not c or math.hypot(c[-1][0] - p[0], c[-1][1] - p[1]) > 0.05:
                c.append((round(p[0], 2), round(p[1], 2)))
        if len(c) > 2 and math.hypot(c[0][0] - c[-1][0], c[0][1] - c[-1][1]) < 0.05:
            c.pop()
        if len(c) >= 3:
            out.append(ensure_ccw(c))
    return out

def poly_area(pts):
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))) / 2

def poly_centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n) if n else (0, 0)

def poly_bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]

def simplify_to_quad(pts):
    """If polygon has 5+ vertices due to collinear cut segments, reduce to its 4 primary corners."""
    pts = list(pts)
    if len(pts) <= 4: return pts
    while len(pts) > 4:
        min_dev = 999.0
        remove_idx = -1
        n = len(pts)
        for i in range(n):
            p_prev = pts[(i - 1 + n) % n]
            p_curr = pts[i]
            p_next = pts[(i + 1) % n]
            v1 = (p_curr[0] - p_prev[0], p_curr[1] - p_prev[1])
            v2 = (p_next[0] - p_curr[0], p_next[1] - p_curr[1])
            l1 = math.hypot(v1[0], v1[1])
            l2 = math.hypot(v2[0], v2[1])
            if l1 < 1e-4 or l2 < 1e-4:
                remove_idx = i
                break
            dot = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))
            ang = math.degrees(math.acos(dot))
            if ang < min_dev:
                min_dev = ang
                remove_idx = i
        if remove_idx != -1 and min_dev < 38.0:
            pts.pop(remove_idx)
        else:
            break
    return pts

def orthogonalize(poly):
    """Make any 4-vertex quadrilateral into a perfectly orthogonal 90-deg symmetric rectangle."""
    if len(poly) != 4:
        return poly
    p0, p1, p2, p3 = poly
    cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4
    cy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4
    
    # Vector along primary side (p1-p0 and p2-p3)
    v1x, v1y = p1[0] - p0[0], p1[1] - p0[1]
    v2x, v2y = p2[0] - p3[0], p2[1] - p3[1]
    vx = (v1x + v2x) / 2
    vy = (v1y + v2y) / 2
    len_v = math.hypot(vx, vy)
    if len_v < 1e-4: return poly
    ux, uy = vx / len_v, vy / len_v
    
    # Perpendicular unit vector (-uy, ux)
    px, py = -uy, ux
    
    # Measure width along perp (p3-p0 and p2-p1)
    w1 = (p3[0] - p0[0]) * px + (p3[1] - p0[1]) * py
    w2 = (p2[0] - p1[0]) * px + (p2[1] - p1[1]) * py
    w = (abs(w1) + abs(w2)) / 2
    
    half_l = len_v / 2
    half_w = w / 2
    
    quad = [
        [round(cx - ux * half_l - px * half_w, 2), round(cy - uy * half_l - py * half_w, 2)],
        [round(cx + ux * half_l - px * half_w, 2), round(cy + uy * half_l - py * half_w, 2)],
        [round(cx + ux * half_l + px * half_w, 2), round(cy + uy * half_l + py * half_w, 2)],
        [round(cx - ux * half_l + px * half_w, 2), round(cy - uy * half_l + py * half_w, 2)]
    ]
    return ensure_ccw(quad)

def stroke_polyline(pts, width=5.0):
    """Turn a polyline [(x0, y0), (x1, y1), ...] into a closed ribbon polygon with given stroke width."""
    if len(pts) < 2: return []
    unique_pts = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - unique_pts[-1][0], p[1] - unique_pts[-1][1]) > 0.5:
            unique_pts.append(p)
    half = len(unique_pts) // 2
    if len(unique_pts) >= 4 and math.hypot(unique_pts[0][0] - unique_pts[-1][0], unique_pts[0][1] - unique_pts[-1][1]) < 1.0:
        unique_pts = unique_pts[:half + 1]

    if len(unique_pts) < 2: return []
    
    half_w = width / 2.0
    left_side = []
    right_side = []
    
    for i in range(len(unique_pts)):
        p = unique_pts[i]
        if i == 0:
            dx = unique_pts[1][0] - p[0]
            dy = unique_pts[1][1] - p[1]
        elif i == len(unique_pts) - 1:
            dx = p[0] - unique_pts[i-1][0]
            dy = p[1] - unique_pts[i-1][1]
        else:
            dx = unique_pts[i+1][0] - unique_pts[i-1][0]
            dy = unique_pts[i+1][1] - unique_pts[i-1][1]
        
        L = math.hypot(dx, dy)
        if L < 1e-4: nx, ny = 0, 1
        else: nx, ny = -dy / L, dx / L
        
        left_side.append((round(p[0] + nx * half_w, 2), round(p[1] + ny * half_w, 2)))
        right_side.append((round(p[0] - nx * half_w, 2), round(p[1] - ny * half_w, 2)))
        
    return ensure_ccw(left_side + right_side[::-1])

def clean_name(s):
    if not s: return ""
    s = html.unescape(s)
    s = re.sub(r"_x([0-9A-Fa-f]{2,4})_", lambda m: chr(int(m.group(1), 16)), s)
    return s.replace("_", " ").strip()

def poly_angle(poly):
    """Calculate the principal orientation angle (degrees) of a polygon along its longest edge."""
    max_len = 0.0
    best_ang = 0.0
    n = len(poly)
    for i in range(n):
        p1 = poly[i]
        p2 = poly[(i + 1) % n]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        L = math.hypot(dx, dy)
        if L > max_len:
            max_len = L
            best_ang = math.degrees(math.atan2(dy, dx))
    while best_ang > 90: best_ang -= 180
    while best_ang <= -90: best_ang += 180
    return round(best_ang, 1)

def build():
    svg_file = "gf ewalk penta dan kawasan.svg"
    tree = ET.parse(svg_file)
    root = tree.getroot()
    vb = [float(x) for x in root.get("viewBox", "0 0 1759.47 1195").split()]
    
    scale = 0.18729  # matching bsb-GF scale
    origin = [vb[0] + vb[2]/2, vb[1] + vb[3]/2]
    
    def norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    # 0. Load Live CMS Tenant Data & 3D Logos
    with open("data/directory.json", "r", encoding="utf-8") as f:
        dir_data = json.load(f)
    gf_tenants = [t for t in dir_data.get("tenants", []) if t.get("floor") == "gf"]
    
    with open("data/3d/bsb-GF.json", "r", encoding="utf-8") as f:
        bsb_gf = json.load(f)
    bsb_units = {norm(u["id"]): u for u in bsb_gf.get("units", [])}

    t_by_shape = {norm(t.get("unitShape", "")): t for t in gf_tenants if t.get("unitShape")}
    t_by_name = {norm(t.get("name", "")): t for t in gf_tenants if t.get("name")}
    t_by_id = {t["id"]: t for t in dir_data.get("tenants", [])}

    ALIASES = {
        "starbuck": "starbucks-gf-ewalk",
        "starbucks": "starbucks-gf-ewalk",
        "jco": "j-co-gf",
        "fore": "fore-coffee-gf",
        "jete": "jete-gf",
        "owl": "optik-melawai-gf",
        "polo": "polo-ug",
        "ur": "urban-republic-gf",
        "djournal": "djournal-coffee-gf",
        "loccitane": "l-occitane-gf",
        "victorysecret": "victorias-secret-gf",
        "shemshusi": "shem-sushi-gf",
        "playwork": "playworks-gf",
        "ceterawood": "et-cetera-and-wood-gf",
        "everbeast": "everbest-gf",
        "opticseis": "optik-seis-gf",
        "mississipi": "mississippi-gf",
        "cf": "c-and-f-perfume-gf",
        "bodyshop": "the-body-shop-gf"
    }

    def find_tenant(raw_id, data_name, bld):
        candidates = [
            norm(f"{bld}-gf-{raw_id}"),
            norm(f"{bld}-gf-{data_name}"),
            norm(raw_id),
            norm(data_name),
            norm(f"{bld}-{raw_id}"),
            norm(f"{bld}-{data_name}")
        ]
        for c in candidates:
            if c in t_by_shape: return t_by_shape[c]
            if c in t_by_name: return t_by_name[c]
            if c in ALIASES and ALIASES[c] in t_by_id: return t_by_id[ALIASES[c]]
        return None

    ground_slabs = []
    mall_slabs = []
    ruko_slabs = []
    roads = []
    units = []
    facilities = []

    # 1. Base-5: Master Superblock Site, Jalan Utama, and Pembatas Lajur
    base5_children = root.findall(f".//{NS}g[@id=\"base-5\"]/*")
    for i, el in enumerate(base5_children):
        eid = el.get("id") or ""
        dname = el.get("data-name") or ""
        tag = el.tag.replace(NS, "")
        t = parse_transform(el.get("transform", ""))
        
        if i == 0:
            polys = shape_points(el)
            for poly in polys:
                ground_slabs.append({
                    "id": "site-ground",
                    "name": "Lahan Terbuka Kawasan Superblock BSB",
                    "kind": "master_ground",
                    "poly": poly
                })
        elif "pembatas" in (eid + dname).lower():
            raw_pts = []
            if tag in ("polygon", "polyline"):
                v = [float(x) for x in re.findall(NUM, el.get("points", ""))]
                raw_pts = list(zip(v[0::2], v[1::2]))
            elif tag == "path":
                subs = path_subpaths(el.get("d", ""))
                if subs: raw_pts = subs[0]
            if t != (1, 0, 0, 1, 0, 0):
                raw_pts = apply_mat(t, raw_pts)
            
            ribbon = stroke_polyline(raw_pts, width=5.0)
            if len(ribbon) >= 3:
                roads.append({
                    "id": eid or f"pembatas-lajur-{i}",
                    "name": "Pembatas Lajur (Median Jalan)",
                    "kind": "divider",
                    "poly": ribbon
                })
        elif "jalan" in (eid + dname).lower() or i == 4:
            polys = shape_points(el)
            for poly in polys:
                roads.append({
                    "id": "jalan-utama",
                    "name": "Jalan Utama Kawasan BSB",
                    "kind": "road",
                    "poly": poly
                })

    # 2. Mall Podiums (E-Walk & Pentacity)
    for el in root.findall(f".//{NS}g[@id=\"ewalk\"]/{NS}g[@id=\"base\"]/*"):
        for poly in shape_points(el):
            mall_slabs.append({"name": "Podium Mall E-Walk", "building": "ewalk", "poly": poly})

    for el in root.findall(f".//{NS}g[@id=\"penta\"]/{NS}g[@id=\"base-2\"]/*"):
        for poly in shape_points(el):
            mall_slabs.append({"name": "Podium Mall Pentacity", "building": "pentacity", "poly": poly})

    # 3. Ruko Slabs (5 Clean Podium Clusters matching Blok A, B, C, D, E)
    block_names = ["Blok A", "Blok B", "Blok C", "Blok D", "Blok E"]
    for i, el in enumerate(root.findall(f".//{NS}g[@id=\"gedung\"]/{NS}g[@id=\"base-4\"]/*")):
        bname = block_names[i] if i < len(block_names) else f"Blok {i+1}"
        for poly in shape_points(el):
            ruko_slabs.append({
                "id": f"podium-ruko-{i+1}",
                "name": f"Podium Ruko {bname}",
                "building": "ruko",
                "block": bname,
                "poly": poly
            })

    # 4. E-Walk Mall Tenants (52) linked with real CMS data, live angles & 3D logos
    for el in root.findall(f".//{NS}g[@id=\"ewalk\"]/{NS}g[@id=\"tenant\"]/*"):
        rid = el.get("id") or ""
        dname = el.get("data-name") or ""
        clean_d = clean_name(dname or rid)
        t = find_tenant(rid, dname, "ewalk")
        
        bu = bsb_units.get(norm(t.get("unitShape", ""))) or bsb_units.get(norm(f"ewalk-gf-{rid}")) if t else None
        logo_3d = bu.get("logo") if bu else None
        
        real_title = t.get("name") if t else (clean_d.title() if clean_d else "Toko E-Walk")
        logo_cms = t.get("logo") if t else None
        photo = t.get("photo") if t else None
        category = t.get("category", "Retail") if t else "Retail"

        for poly in shape_points(el):
            a = poly_area(poly)
            if a < 2: continue
            cen = poly_centroid(poly); bbox = poly_bbox(poly)
            is_anchor = bool((t and t.get("anchor")) or a > 7000 or (t and t.get("name") in ("Executive & Colorbox", "Uniqlo", "H&M")))
            
            # Match live orientation angle and label dimensions
            bu_lbl = bu.get("label") if bu and bu.get("label") else None
            if bu_lbl:
                lbl_ang = bu_lbl.get("angle", 0)
                lbl_w = bu_lbl.get("w", math.sqrt(a * (scale**2)))
                lbl_h = bu_lbl.get("h", lbl_w * 0.5)
            else:
                lbl_ang = poly_angle(poly)
                lbl_w = round(math.sqrt(a * (scale**2)), 1)
                lbl_h = round(lbl_w * 0.5, 1)

            label_data = {
                "x": round((cen[0] - origin[0]) * scale, 2),
                "y": round((cen[1] - origin[1]) * scale, 2),
                "angle": lbl_ang,
                "w": lbl_w,
                "h": lbl_h
            }

            units.append({
                "id": f"ewalk-gf-{rid or clean_d or len(units)+1}",
                "name": real_title,
                "kind": "anchor" if is_anchor else ("kiosk" if a < 15 else "tenant"),
                "building": "ewalk",
                "category": category,
                "logo_3d": logo_3d,
                "logo_cms": logo_cms,
                "photo": photo,
                "label": label_data,
                "poly": poly,
                "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0],
                "area": round(a * (scale**2), 1),
                "is_half": False
            })

    # 5. Pentacity Mall Tenants (35) linked with real CMS data, live angles & 3D logos
    for el in root.findall(f".//{NS}g[@id=\"penta\"]/{NS}g[@id=\"tenant-2\"]/*"):
        rid = el.get("id") or ""
        dname = el.get("data-name") or ""
        clean_d = clean_name(dname or rid)
        t = find_tenant(rid, dname, "pentacity")
        
        bu = bsb_units.get(norm(t.get("unitShape", ""))) or bsb_units.get(norm(f"pentacity-gf-{rid}")) if t else None
        logo_3d = bu.get("logo") if bu else None
        
        real_title = t.get("name") if t else (clean_d.title() if clean_d else "Toko Pentacity")
        logo_cms = t.get("logo") if t else None
        photo = t.get("photo") if t else None
        category = t.get("category", "Retail") if t else "Retail"

        for poly in shape_points(el):
            a = poly_area(poly)
            if a < 2: continue
            cen = poly_centroid(poly); bbox = poly_bbox(poly)
            is_anchor = bool((t and t.get("anchor")) or a > 7000 or (t and t.get("name") in ("Uniqlo", "H&M", "Executive & Colorbox")))
            
            bu_lbl = bu.get("label") if bu and bu.get("label") else None
            if bu_lbl:
                lbl_ang = bu_lbl.get("angle", 0)
                lbl_w = bu_lbl.get("w", math.sqrt(a * (scale**2)))
                lbl_h = bu_lbl.get("h", lbl_w * 0.5)
            else:
                lbl_ang = poly_angle(poly)
                lbl_w = round(math.sqrt(a * (scale**2)), 1)
                lbl_h = round(lbl_w * 0.5, 1)

            label_data = {
                "x": round((cen[0] - origin[0]) * scale, 2),
                "y": round((cen[1] - origin[1]) * scale, 2),
                "angle": lbl_ang,
                "w": lbl_w,
                "h": lbl_h
            }

            units.append({
                "id": f"pentacity-gf-{rid or clean_d or len(units)+1}",
                "name": real_title,
                "kind": "anchor" if is_anchor else ("kiosk" if a < 15 else "tenant"),
                "building": "pentacity",
                "category": category,
                "logo_3d": logo_3d,
                "logo_cms": logo_cms,
                "photo": photo,
                "label": label_data,
                "poly": poly,
                "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0],
                "area": round(a * (scale**2), 1),
                "is_half": False
            })

    # 6. RUKO Units — Blok A–E (157 individual shops) are straightened to clean 90° rectangles
    # Elements > 157 are southern sidewalk/pavement slabs and highway entrance features, NOT tall buildings!
    ruko_children = root.findall(f".//{NS}g[@id=\"gedung\"]/{NS}g[@id=\"ruko\"]/*")
    for raw_idx, el in enumerate(ruko_children):
        tag = el.tag.replace(NS, "")
        polys = shape_points(el)
        if not polys: continue
        
        # Elements 0 to 157 belong to the 5 northern blocks (Blok A to E)
        if raw_idx <= 157:
            if raw_idx <= 30:
                bname = "Blok A"
                bnum = raw_idx + 1
            elif raw_idx <= 66:
                bname = "Blok B"
                bnum = raw_idx - 30
            elif raw_idx <= 92:
                bname = "Blok C"
                bnum = raw_idx - 66
            elif raw_idx <= 120:
                bname = "Blok D"
                bnum = raw_idx - 92
            else:
                bname = "Blok E"
                bnum = raw_idx - 120 if raw_idx < 123 else raw_idx - 121

            for poly in polys:
                a = poly_area(poly)
                if a < 1.5: continue
                
                # Straighten to clean orthogonal 90° rectangles
                poly = simplify_to_quad(poly)
                if len(poly) == 4:
                    poly = orthogonalize(poly)
                else:
                    poly = ensure_ccw(poly)
                    
                cen = poly_centroid(poly); bbox = poly_bbox(poly)
                disp_name = f"Ruko {bname} #{bnum:02d}" if isinstance(bnum, int) else str(bnum)
                
                units.append({
                    "id": f"ruko-{raw_idx}",
                    "name": disp_name,
                    "kind": "ruko",
                    "building": "ruko",
                    "block": bname,
                    "poly": poly,
                    "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0],
                    "area": round(a * (scale**2), 1),
                    "is_half": False
                })
        else:
            # Elements 158..164: Ruko / Gedung bagian bawah dari SVG user
            # PERTAHANKAN 100% BENTUK ASLI SVG (jangan simplify_to_quad, jangan orthogonalize)
            for poly in polys:
                a = poly_area(poly)
                if a < 1.5: continue
                poly = ensure_ccw(poly)
                cen = poly_centroid(poly); bbox = poly_bbox(poly)
                disp_name = f"Ruko Selatan #{raw_idx - 157}"
                units.append({
                    "id": f"ruko-{raw_idx}",
                    "name": disp_name,
                    "kind": "ruko",
                    "building": "ruko",
                    "block": "Ruko Selatan",
                    "poly": poly,
                    "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0],
                    "area": round(a * (scale**2), 1),
                    "is_half": False
                })

    # 7. Future Development / Half-height Kavling from other-3
    for el in root.findall(f".//{NS}g[@id=\"other-3\"]/*"):
        name = clean_name(el.get("id") or el.get("data-name") or "Perluasan")
        for poly in shape_points(el):
            a = poly_area(poly); cen = poly_centroid(poly); bbox = poly_bbox(poly)
            units.append({
                "id": f"future-{name}",
                "name": name.title(),
                "kind": "future_plot",
                "building": "kawasan",
                "poly": ensure_ccw(poly),
                "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0],
                "area": round(a * (scale**2), 1),
                "is_half": True
            })

    # 8. Lobbies
    for el in root.findall(f".//{NS}g[@id=\"ewalk\"]/{NS}g[@id=\"other\"]/*"):
        name = clean_name(el.get("id") or el.get("data-name") or "Lobi")
        for poly in shape_points(el):
            a = poly_area(poly); cen = poly_centroid(poly); bbox = poly_bbox(poly)
            units.append({"id": f"ewalk-other-{name}", "name": name.title(), "kind": "lobby", "building": "ewalk", "poly": ensure_ccw(poly), "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0], "area": round(a * (scale**2), 1), "is_half": False})

    for el in root.findall(f".//{NS}g[@id=\"penta\"]/{NS}g[@id=\"other-2\"]/*"):
        name = clean_name(el.get("id") or el.get("data-name") or "Lobi")
        for poly in shape_points(el):
            a = poly_area(poly); cen = poly_centroid(poly); bbox = poly_bbox(poly)
            units.append({"id": f"pentacity-other-{name}", "name": name.title(), "kind": "lobby", "building": "pentacity", "poly": ensure_ccw(poly), "box": [round(cen[0], 1), round(cen[1], 1), round(bbox[2], 1), round(bbox[3], 1), 0], "area": round(a * (scale**2), 1), "is_half": False})

    # 9. Facilities (Escalators, Lifts, Toilets)
    for gpath, bld in [(f".//{NS}g[@id=\"ewalk\"]/{NS}g[@id=\"fasilitas\"]/*", "ewalk"), (f".//{NS}g[@id=\"penta\"]/{NS}g[@id=\"fasilitas-2\"]/*", "pentacity")]:
        for el in root.findall(gpath):
            name = clean_name(el.get("id") or el.get("data-name") or "")
            polys = shape_points(el)
            if polys:
                cen = poly_centroid(polys[0])
                ftype = "escalator" if "eskalat" in name.lower() or "excalat" in name.lower() else ("lift" if "lift" in name.lower() else "toilet")
                facilities.append({
                    "id": name or f"{bld}-fac-{len(facilities)+1}",
                    "name": name.title() if name else ftype.title(),
                    "type": ftype,
                    "p": [round(cen[0], 2), round(cen[1], 2)],
                    "building": bld
                })

    # 10. Traffic Flow Markings — Hapus total sesuai permintaan user ("marka jalan juga hapus")
    traffic_arrows = []

    model = {
        "title": "BSB Superblock GF & Kawasan 3D (Real Live Tenants, One-Way Lane Markings & Front Ruko)",
        "artboard": vb,
        "origin": origin,
        "m_per_unit": scale,
        "height_standards": {
            "mall_slab_h": 1.2,
            "mall_tenant_h": 4.5,
            "mall_anchor_h": 4.5,
            "mall_kiosk_h": 2.2,
            "ruko_slab_h": 0.6,
            "ruko_h": 5.5,
            "half_h": 1.8,
            "road_h": 0.08,
            "divider_h": 0.20
        },
        "ground_slabs": ground_slabs,
        "mall_slabs": mall_slabs,
        "ruko_slabs": ruko_slabs,
        "roads": roads,
        "traffic_arrows": traffic_arrows,
        "units": units,
        "facilities": facilities,
        "counts": {
            "ground_slabs": len(ground_slabs),
            "mall_slabs": len(mall_slabs),
            "ruko_slabs": len(ruko_slabs),
            "roads": len(roads),
            "mall_tenants": len([u for u in units if u["kind"] in ("tenant", "anchor", "kiosk") and u["building"] in ("ewalk", "pentacity")]),
            "ruko_units": len([u for u in units if u["kind"] == "ruko" and u.get("block") in ("Blok A", "Blok B", "Blok C", "Blok D", "Blok E")]),
            "ruko_selatan": len([u for u in units if u["kind"] == "ruko" and u.get("block") == "Ruko Selatan"]),
            "future_half_units": len([u for u in units if u.get("is_half")]),
            "lobbies": len([u for u in units if u["kind"] == "lobby"]),
            "facilities": len(facilities)
        }
    }
    
    os.makedirs("data/3d", exist_ok=True)
    out_file = "data/3d/preview-kawasan-GF.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2)
        
    print(f"Generated {out_file}:")
    print("  Counts:", model["counts"])

if __name__ == "__main__":
    build()
