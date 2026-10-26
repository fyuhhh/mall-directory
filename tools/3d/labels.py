"""Label-box helpers for the 3D floor converter: the biggest text-friendly rectangle inside a unit."""
import math

import cv2
import numpy as np


def max_rect(binary, aspect):
    """Largest text-friendly axis-aligned rectangle of ones. Returns (x, y, w, h)."""
    H, W = binary.shape
    heights = np.zeros(W + 1, np.int32)
    best = (-1.0, 0, 0, 0, 0)
    for y in range(H):
        heights[:W] = np.where(binary[y] > 0, heights[:W] + 1, 0)
        stack = []
        for x in range(W + 1):
            hgt = int(heights[x])
            start = x
            while stack and stack[-1][1] >= hgt:
                sx, sh = stack.pop()
                w = x - sx
                if sh > 0 and w > 0:
                    score = min(sh, w / aspect) + 1e-3 * math.sqrt(w * sh)
                    if score > best[0]:
                        best = (score, sx, y - sh + 1, w, sh)
                start = sx
            stack.append((start, hgt))
    return best[1:] if best[0] > 0 else None


def rect_at_angle(mask, angle, aspect=2.6, max_side=110):
    """Best label rectangle whose long side runs along `angle` (deg, y-down, clockwise)."""
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return None
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    crop = mask[y0:y1, x0:x1].astype(np.uint8)
    h, w = crop.shape
    diag = int(math.ceil(math.hypot(w, h))) + 4
    canvas = np.zeros((diag, diag), np.uint8)
    ox, oy = (diag - w) // 2, (diag - h) // 2
    canvas[oy:oy + h, ox:ox + w] = crop
    c = (diag / 2.0, diag / 2.0)
    M = cv2.getRotationMatrix2D(c, angle, 1.0)  # maps direction `angle` onto +x
    rot = cv2.warpAffine(canvas, M, (diag, diag), flags=cv2.INTER_NEAREST)
    f = min(1.0, max_side / float(diag))
    small = cv2.resize(rot, (max(1, int(diag * f)), max(1, int(diag * f))), interpolation=cv2.INTER_NEAREST) if f < 1 else rot
    if f < 1:
        small = cv2.erode(small, np.ones((2, 2), np.uint8))
    r = max_rect(small, aspect)
    if r is None:
        return None
    rx, ry, rw, rh = [v / f for v in r]
    cxr, cyr = rx + rw / 2.0, ry + rh / 2.0
    Mi = cv2.invertAffineTransform(M)
    cx = Mi[0, 0] * cxr + Mi[0, 1] * cyr + Mi[0, 2] - ox + x0
    cy = Mi[1, 0] * cxr + Mi[1, 1] * cyr + Mi[1, 2] - oy + y0
    return cx, cy, rw, rh


def label_box(mask):
    ys, xs = np.nonzero(mask)
    pts = np.column_stack([xs, ys]).astype(np.float32)
    (_, _), (w, h), ang = cv2.minAreaRect(pts)
    axis = ang if w >= h else ang + 90.0
    cands = set()
    for a in (axis, axis + 90.0, 0.0, 90.0):
        while a > 90:
            a -= 180
        while a <= -90:
            a += 180
        cands.add(round(a, 1))
    best = None
    for a in cands:
        r = rect_at_angle(mask, a)
        if not r:
            continue
        cx, cy, rw, rh = r
        score = min(rh, rw / 2.6) * (1.0 + 0.04 * (abs(a) < 1))  # slight preference for horizontal text
        if best is None or score > best[0]:
            best = (score, cx, cy, a, rw, rh)
    if not best:
        return None
    _, cx, cy, a, rw, rh = best
    if a > 89.9:  # read bottom-to-top rather than top-to-bottom
        a -= 180.0
    return {"cx": cx, "cy": cy, "angle": a, "w": rw, "h": rh}
