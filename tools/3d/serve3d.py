#!/usr/bin/env python3
"""Local server for the kiosk, the phone page and the 3D editor, without PHP.

Serves the repository as static files and adds the editor's save API:
  GET  /api/3d/ping                    -> {"ok": true}
  POST /api/3d/edits?floor=<floorId>   body {"units": {...}} -> the "edits" file named for that floor in data/3d/floors.json
  POST /api/3d/logo?name=<tenant>      body PNG bytes -> assets/logos/custom/<slug>-<time>.png, returns {"path": ...}
Other /api/* paths answer 404, so the kiosk falls back to its static snapshots (data/version.json etc.).
Binds to 127.0.0.1 only.

Usage: python3 tools/3d/serve3d.py [--port 8000]
  kiosk : http://localhost:8000/?attract=0
  editor: http://localhost:8000/editor3d.html
"""
import argparse
import json
import os
import re
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REGISTRY = os.path.join(ROOT, "data", "3d", "floors.json")
MAX_EDITS = 2 * 1024 * 1024
MAX_LOGO = 8 * 1024 * 1024


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.split("?")[0].endswith((".json", ".js", ".html", ".css")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/3d/" in self.path:
            super().log_message(fmt, *args)

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if 0 < n <= limit else None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/3d/ping":
            return self.reply(200, {"ok": True})
        if path.startswith("/api/"):
            return self.reply(404, {"error": "no PHP API in local mode"})
        return super().do_GET()

    def do_HEAD(self):
        if urlparse(self.path).path.startswith("/api/"):
            self.send_response(404)
            self.end_headers()
            return
        return super().do_HEAD()

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/3d/edits":
            floor = q.get("floor", "")
            reg = json.load(open(REGISTRY)) if os.path.exists(REGISTRY) else {"floors": {}}
            entry = reg.get("floors", {}).get(floor)
            if not entry or not re.fullmatch(r"data/3d/edits/[A-Za-z0-9_.-]+\.json", entry.get("edits", "")):
                return self.reply(400, {"error": "unknown 3D floor"})
            try:
                data = json.loads(self.body(MAX_EDITS) or b"")
            except ValueError:
                return self.reply(400, {"error": "bad json"})
            if not isinstance(data, dict) or not isinstance(data.get("units", {}), dict):
                return self.reply(400, {"error": "expected {units: {...}}"})
            data["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            write_atomic(os.path.join(ROOT, entry["edits"]), json.dumps(data, indent=1, ensure_ascii=False).encode())
            return self.reply(200, {"ok": True, "path": entry["edits"]})
        if url.path == "/api/3d/logo":
            raw = self.body(MAX_LOGO)
            if not raw or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                return self.reply(400, {"error": "expected a PNG body"})
            slug = re.sub(r"[^a-z0-9]+", "-", q.get("name", "logo").lower()).strip("-")[:40] or "logo"
            rel = f"assets/logos/custom/{slug}-{int(time.time())}.png"
            write_atomic(os.path.join(ROOT, rel), raw)
            return self.reply(200, {"ok": True, "path": rel})
        return self.reply(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=ROOT))
    print(f"Serving {ROOT}\n  kiosk : http://localhost:{a.port}/?attract=0\n  editor: http://localhost:{a.port}/editor3d.html")
    srv.serve_forever()


if __name__ == "__main__":
    main()
