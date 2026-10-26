#!/usr/bin/env python3
"""Place a 3D floor model (data/3d/<mall>-<floor>.json) onto a kiosk floor of data/directory.json.

The kiosk's tenants, graph nodes, kiosks and routes are in the floor SVG's units (an isometric drawing);
the 3D model is in metres from the Illustrator plan. This finds the affine transform between them:
  1. rough fit: directory tenant pins -> centroid of the 3D unit with the same name (needs >= 3 names);
  2. refine: align the walkable corridor of the floor SVG (its colour is sampled under the graph
     nodes) with the corridor of the 3D model (slab minus units) using OpenCV ECC.
It then links directory tenants to 3D units (pin inside / near the unit AND the names agree), picks the
orthographic camera angle that matches the drawing, and writes the entry into data/3d/floors.json.

Usage (repository root):
  python3 tools/3d/register_floor.py --model data/3d/ewalk-LG.json --kiosk-floor lg-ewalk [--check out.png]
Needs numpy + opencv-python-headless and Google Chrome / Chromium (to rasterise the floor SVG).
A floor shared by both buildings (gf, ug) has one drawing per building: tools/3d/merge_floor.py fits each with
fit_model(..., building=) and joins them into one model.
"""
import argparse
import difflib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
           "google-chrome", "chromium", "chromium-browser", r"C:\Program Files\Google\Chrome\Application\chrome.exe"]


QUALIFIERS = {"ewalk", "penta", "pentacity", "lg", "gf", "ug", "ff", "sf", "1f", "2f"}  # "xxi-ewalk-ff" names Cinema XXI
NUM_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "satu": "1", "dua": "2", "tiga": "3", "empat": "4", "lima": "5"}


def norm(s):
    s = re.sub(r"[a-z]+", lambda m: NUM_WORDS.get(m.group(0), m.group(0)), (s or "").lower().replace("&", "and"))
    return re.sub(r"[^a-z0-9]", "", s)


def unqualified(s):
    """A drawn name without the building / floor words the drawing adds ("xxi-ewalk-ff" -> "xxi")."""
    words = [w for w in re.split(r"[\s_-]+", s or "") if w]
    kept = [w for w in words if w.lower() not in QUALIFIERS]
    return " ".join(kept or words)


def names_agree(a, b):
    """Same shop despite small spelling differences in the drawing: "ichiban shusi" / "Ichiban Sushi", "ramen one" / "Ramen 1"."""
    a, b = norm(unqualified(a)), norm(unqualified(b))
    if a == b:
        return len(a) >= 2  # "X8"
    return len(a) >= 3 and len(b) >= 3 and (a in b or b in a or difflib.SequenceMatcher(None, a, b).ratio() >= 0.8)


def centroid(poly):
    P = np.asarray(poly, float)
    x, y = P[:, 0], P[:, 1]
    c = x * np.roll(y, -1) - np.roll(x, -1) * y
    A = c.sum() / 2
    if abs(A) < 1e-9:
        return P.mean(0)
    return np.array([((x + np.roll(x, -1)) * c).sum() / (6 * A), ((y + np.roll(y, -1)) * c).sum() / (6 * A)])


def closest_on(cnt, p):
    """Closest point to p on a closed outline."""
    P = cnt.reshape(-1, 2).astype(float)
    A, B = P, np.roll(P, -1, 0)
    d = B - A
    t = np.clip(((p - A) * d).sum(1) / np.maximum((d * d).sum(1), 1e-12), 0, 1)
    Q = A + d * t[:, None]
    return Q[np.argmin(((Q - p) ** 2).sum(1))]


def render_svg(svg_path, w, h, chrome):
    exe = next((c for c in ([chrome] if chrome else CHROMES) if c and (os.path.exists(c) or shutil.which(c))), None)
    if not exe:
        sys.exit("Chrome/Chromium not found; pass --chrome")
    tmp = tempfile.mkdtemp(prefix="reg3d-")
    page = os.path.join(tmp, "page.html")
    with open(page, "w") as f:
        f.write(f'<!doctype html><body style="margin:0;background:#fff"><img src="file://{os.path.abspath(svg_path)}" '
                f'style="width:{w}px;height:{h}px;display:block"></body>')
    out = os.path.join(tmp, "floor.png")
    subprocess.run([shutil.which(exe) or exe, "--headless=new", f"--user-data-dir={tmp}/prof", "--allow-file-access-from-files",
                    f"--window-size={int(math.ceil(w))},{int(math.ceil(h))}", "--hide-scrollbars", "--virtual-time-budget=5000",
                    f"--screenshot={out}", f"file://{page}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    img = cv2.imread(out)
    shutil.rmtree(tmp, ignore_errors=True)
    if img is None:
        sys.exit("could not rasterise the floor SVG")
    return img


def closest_view(L):
    """Orthographic camera (azimuth, polar) whose projection of the floor best matches the drawing."""
    Li = np.linalg.inv(L)  # metres -> drawing units
    best = None
    for th in np.arange(-180, 180, 0.25):
        for ph in np.arange(15, 85, 0.25):
            a, f = math.radians(th), math.radians(ph)
            P = np.array([[math.cos(a), -math.sin(a)], [math.cos(f) * math.sin(a), math.cos(f) * math.cos(a)]])
            k = (P * Li).sum() / (P * P).sum()
            if k <= 0:  # a mirrored / upside-down fit is not a camera
                continue
            e = np.linalg.norm(k * P - Li) / np.linalg.norm(Li)
            if best is None or e < best[0]:
                best = (e, th, ph)
    return {"azimuth": round(float(best[1]), 2), "polar": round(float(best[2]), 2), "fit_error": round(float(best[0]), 3)}


def outline_fit(img, B, shape):
    """Rough fit without shared names: the model's outline onto the old drawing's building silhouette, the old drawing's
    projection taken from `shape` (another floor of the same building), then turned / scaled / moved (best overlap)."""
    sil = (np.abs(img.astype(int) - img[0, 0].astype(int)).sum(2) > 24).astype(np.uint8)  # everything but the background
    sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    S = np.asarray(shape, float)
    Si = np.linalg.inv(S)
    outer = [np.asarray(s["outer"], float) for s in B["slab"]]
    pts = np.vstack(outer)
    area_m = sum(abs(cv2.contourArea(o.astype(np.float32))) for o in outer)
    ys, xs = np.nonzero(sil)
    c_old = np.array([xs.mean(), ys.mean()])
    best = None
    for deg in np.arange(-45, 45.1, 1.0):
        th = math.radians(deg)
        Rt = np.array([[math.cos(th), math.sin(th)], [-math.sin(th), math.cos(th)]])  # R(-th)
        Q = (Si @ Rt @ pts.T).T
        k = math.sqrt(sil.sum() / max(1e-9, abs(np.linalg.det(Si)) * area_m))
        Q = Q * k
        Q = Q - Q.mean(0) + c_old
        m = np.zeros_like(sil)
        off = 0
        for o in outer:
            n = len(o)
            cv2.fillPoly(m, [np.round(Q[off:off + n]).astype(np.int32)], 1)
            off += n
        iou = (m & sil).sum() / max(1, (m | sil).sum())
        if best is None or iou > best[0]:
            best = (iou, th, k, pts.mean(0), Q.mean(0))
    iou, th, k, cm, cq = best
    Rz = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]]) / k
    L0 = Rz @ S  # old -> metres
    t0 = cm - L0 @ cq
    M0 = np.hstack([L0, t0[:, None]])
    # refine on the silhouette
    L0i = np.linalg.inv(L0)
    maskB = np.zeros_like(sil)
    for o in outer:
        cv2.fillPoly(maskB, [np.round((L0i @ (o - t0).T).T).astype(np.int32)], 1)
    blur = lambda m: cv2.GaussianBlur(m.astype(np.float32), (0, 0), 4)  # noqa: E731
    try:
        _, warp = cv2.findTransformECC(blur(sil), blur(maskB), np.eye(2, 3, dtype=np.float32), cv2.MOTION_AFFINE,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6), None, 5)
        M0 = M0 @ np.vstack([warp, [0, 0, 1]])
    except cv2.error:
        pass
    print(f"  outline fit: overlap {iou:.3f}, turned {math.degrees(th):.1f} deg")
    return M0


def fit_model(D, B, fl, building=None, chrome=None, shape=None, outline=False, refine=True):
    """Affine old floor units -> model metres. With `building` (a floor shared by both buildings) only that building's
    tenants pair up, and only the old corridor around the model's outline is aligned. `shape` (the 2x2 part of another
    floor's fit, same old drawing style) lets two shared names do for the rough fit, or with `outline` none at all:
    the model's outline is fitted onto the old drawing's building silhouette (for floors whose few tenants are anchors
    with their pin at the entrance)."""
    vb = fl["viewBox"]
    tenants = [t for t in D["tenants"] if t["floor"] == fl["id"] and (not building or t.get("building") == building)]
    nodes = [n for n in D["graph"]["nodes"] if n["floor"] == fl["id"]]
    units = [u for u in B["units"] if u.get("poly")]
    named = [u for u in units if u.get("name")]

    # 1. rough fit from names
    pairs, pair_units = [], []
    for t in tenants:
        u = next((u for u in named if names_agree(u["name"], t["name"])), None)
        if u:
            pairs.append(((t["x"], t["y"]), centroid(u["poly"])))
            pair_units.append(u)
    svg_path = os.path.join(ROOT, fl["svg"])
    img = render_svg(svg_path, vb[2], vb[3], chrome)
    if outline:
        if shape is None:
            sys.exit("--outline needs --shape-from <a fitted floor of the same building>")
        M0 = outline_fit(img, B, shape)
    elif len(pairs) >= 3:
        X = np.array([[p[0][0], p[0][1], 1] for p in pairs])
        Y = np.array([p[1] for p in pairs])
        M0 = np.linalg.lstsq(X, Y, rcond=None)[0].T  # 2x3, metres = M0 @ [x, y, 1]
        # pins stand at the shop door, not in the middle: pull each pin onto its own unit (ICP on the outlines)
        # (trimmed: the worst quarter is left out each round, a pin at the wrong shop or a name drawn twice doesn't pull)
        cnts = [np.array(u["poly"], np.float32).reshape(-1, 1, 2) for u in pair_units]
        if len(pairs) >= 6:
            for _ in range(15):
                P = (M0 @ X.T).T
                Y = np.array([p if cv2.pointPolygonTest(c, (float(p[0]), float(p[1])), False) >= 0 else closest_on(c, p) for p, c in zip(P, cnts)])
                err = np.linalg.norm(Y - P, axis=1)
                keep = err <= max(np.percentile(err, 75), 0.5)
                M0 = np.linalg.lstsq(X[keep], Y[keep], rcond=None)[0].T
    elif len(pairs) == 2 and shape is not None:  # the other floor's shape, turned / scaled / moved onto the two pairs
        S = np.asarray(shape, float)
        (p1, q1), (p2, q2) = [(S @ np.asarray(p, float), np.asarray(q, float)) for p, q in pairs]
        z = complex(*(q2 - q1)) / complex(*(p2 - p1))
        Rz = np.array([[z.real, -z.imag], [z.imag, z.real]])
        L0 = Rz @ S
        M0 = np.hstack([L0, (q1 - Rz @ p1)[:, None]])
    else:
        sys.exit(f"only {len(pairs)} tenants share a name between the kiosk floor and the model; need 3"
                 + (" (or 2 with --shape-from <a fitted floor of the same building>)" if len(pairs) == 2 else ""))

    # 2. refine on the walkable area
    H, W = img.shape[:2]
    samples = np.array([img[int(round(n["y"])), int(round(n["x"]))] for n in nodes
                        if 0 <= n["x"] < W and 0 <= n["y"] < H], float)
    floor_bgr = np.median(samples, 0)
    maskA = (np.linalg.norm(img.astype(float) - floor_bgr, axis=2) < 18).astype(np.uint8)
    maskA = cv2.morphologyEx(maskA, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    L0, t0 = M0[:, :2], M0[:, 2]
    L0i = np.linalg.inv(L0)
    to_px = lambda P: np.round((L0i @ (np.asarray(P, float) - t0).T).T).astype(np.int32)  # noqa: E731
    maskB = np.zeros((H, W), np.uint8)
    for s in B["slab"]:
        cv2.fillPoly(maskB, [to_px(s["outer"])], 1)
    if building:  # the other building's corridors are not in this model
        near = cv2.dilate(maskB, np.ones((61, 61), np.uint8))
        maskA = maskA * near
        nodes = [n for n in nodes if 0 <= n["x"] < W and 0 <= n["y"] < H and near[int(n["y"]), int(n["x"])]]
    for u in units:
        cv2.fillPoly(maskB, [to_px(u["poly"])], 0)
    blur = lambda m: cv2.GaussianBlur(m.astype(np.float32), (0, 0), 6)  # noqa: E731
    warp = np.eye(2, 3, dtype=np.float32)
    if refine:
        try:
            cc, warp = cv2.findTransformECC(blur(maskA), blur(maskB), warp, cv2.MOTION_AFFINE,
                                            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 400, 1e-6), None, 5)
        except cv2.error as e:
            sys.exit(f"alignment did not converge ({e}); check that the model and the kiosk floor are the same floor")
    else:
        cc = cv2.computeECC(blur(maskA), blur(maskB))
    M = np.hstack([L0, t0[:, None]]) @ np.vstack([warp, [0, 0, 1]])
    L, t = M[:, :2], M[:, 2]
    to_m = lambda x, y: L @ [x, y] + t  # noqa: E731

    # 3. links: pin inside / close to a unit and the names agree
    cnts = {u["id"]: np.array(u["poly"], np.float32).reshape(-1, 1, 2) for u in units}
    links, report = {}, []
    for tn in tenants:
        p = to_m(tn["x"], tn["y"])
        dist = {uid: -cv2.pointPolygonTest(c, (float(p[0]), float(p[1])), True) for uid, c in cnts.items()}
        uid = min(dist, key=dist.get)
        u = next(x for x in units if x["id"] == uid)
        if dist[uid] <= 3 and names_agree(u.get("name"), tn["name"]):
            links[uid] = tn["id"]
            report.append(f"  linked   {tn['id']:34s} -> {uid}")
        else:
            report.append(f"  NOT LINKED {tn['id']:32s} (pin on 3D unit {uid} '{u.get('name') or 'unnamed'}', {max(0, dist[uid]):.1f} m away)")
    inside = sum(1 for n in nodes for c in cnts.values()
                 if cv2.pointPolygonTest(c, tuple(float(v) for v in to_m(n["x"], n["y"])), True) > 2.5)
    return {"M": M, "ecc": float(cc), "links": links, "report": report, "tenants": tenants, "nodes": nodes, "inside": inside, "img": img}


def check_image(path, img, fits, nodes):
    """Old floor with every fitted model drawn on it (linked units red, others orange) and the graph nodes."""
    vis = img.copy()
    for B, M, links in fits:
        L, t = M[:, :2], M[:, 2]
        Li = np.linalg.inv(L)
        px = lambda P: np.round((Li @ (np.asarray(P, float) - t).T).T).astype(np.int32)  # noqa: E731
        for u in B["units"]:
            if u.get("poly"):
                cv2.polylines(vis, [px(u["poly"])], True, (0, 0, 255) if u["id"] in links else (0, 140, 255), 2)
        for s in B["slab"]:
            cv2.polylines(vis, [px(s["outer"])], True, (255, 0, 255), 2)
    for n in nodes:
        cv2.circle(vis, (int(n["x"]), int(n["y"])), 4, (255, 120, 0), -1)
    cv2.imwrite(path, vis)
    print(f"check image: {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="data/3d/<mall>-<floor>.json")
    ap.add_argument("--kiosk-floor", required=True, help="floor id in data/directory.json, e.g. lg-ewalk")
    ap.add_argument("--directory", default=os.path.join(ROOT, "data", "directory.json"))
    ap.add_argument("--registry", default=os.path.join(ROOT, "data", "3d", "floors.json"))
    ap.add_argument("--chrome", default=None)
    ap.add_argument("--check", default=None, help="write an overlay image to check the fit")
    ap.add_argument("--shape-from", default=None, help="a fitted floor of the same building (e.g. lg-ewalk) whose old drawing has the same style: two shared names are then enough")
    ap.add_argument("--outline", action="store_true", help="with --shape-from: rough fit from the building outline instead of tenant names")
    ap.add_argument("--no-refine", action="store_true", help="keep the rough fit (skip the corridor alignment), e.g. when the old floor has little corridor")
    a = ap.parse_args()

    if os.path.exists(a.registry) and (json.load(open(a.registry)).get("floors", {}).get(a.kiosk_floor) or {}).get("frame") == "plan":
        sys.exit(f"{a.kiosk_floor} already keeps its CMS coordinates in the drawing's units (frame \"plan\"): nothing to register.\n"
                 f"After re-converting the drawing refresh the CMS plan instead: CMS > Peta 3D, or php tools/3d/rebase_floor.php --floor {a.kiosk_floor} --plan-only --apply")
    D = json.load(open(a.directory))
    B = json.load(open(a.model if os.path.isabs(a.model) else os.path.join(ROOT, a.model)))
    fl = next((f for f in D["floors"] if f["id"] == a.kiosk_floor), None)
    if not fl:
        sys.exit(f"floor {a.kiosk_floor} not in directory.json")
    if fl.get("building") == "both":
        sys.exit(f"{fl['id']} is shared by both buildings: fit and join one drawing per building with tools/3d/merge_floor.py")
    shape = None
    if a.shape_from:
        other = json.load(open(a.registry))["floors"].get(a.shape_from) or {}
        T = (other.get("legacy") or {}).get("toMetres") or other.get("toMetres")
        if not T:
            sys.exit(f"{a.shape_from} has no fit in the registry")
        shape = np.array(T, float)[:, :2]
    r = fit_model(D, B, fl, chrome=a.chrome, shape=shape, outline=a.outline, refine=not a.no_refine)
    M, links = r["M"], r["links"]
    view = closest_view(M[:, :2])

    reg = json.load(open(a.registry)) if os.path.exists(a.registry) else {"version": 1, "floors": {}}
    model_rel = os.path.relpath(a.model if os.path.isabs(a.model) else os.path.join(ROOT, a.model), ROOT)
    prev = reg["floors"].get(fl["id"], {})
    reg["floors"][fl["id"]] = {
        "model": model_rel,
        "edits": prev.get("edits") or f"data/3d/edits/{os.path.basename(model_rel)}",
        "toMetres": [[round(float(v), 6) for v in row] for row in M],
        "view": prev.get("view_locked") and prev.get("view") or {"azimuth": view["azimuth"], "polar": view["polar"]},
        "tenants": links,
        "registered": time.strftime("%Y-%m-%d %H:%M"), "ecc": round(r["ecc"], 4), "viewFit": view["fit_error"],
    }
    os.makedirs(os.path.dirname(a.registry), exist_ok=True)
    with open(a.registry, "w") as f:
        json.dump(reg, f, indent=1, ensure_ascii=False)
    print(f"{fl['id']}: alignment {r['ecc']:.3f}, view azimuth {view['azimuth']} polar {view['polar']} (fit {view['fit_error']}), "
          f"{len(links)}/{len(r['tenants'])} tenants linked, {r['inside']}/{len(r['nodes'])} graph nodes deep inside a unit")
    print("\n".join(r["report"]))
    print(f"-> {os.path.relpath(a.registry, ROOT)}")
    if a.check:
        check_image(a.check, r["img"], [(B, M, links)], r["nodes"])

if __name__ == "__main__":
    main()
