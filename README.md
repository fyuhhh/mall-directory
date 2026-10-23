# BSB Directory — e-Walk & Pentacity (prototype UI)

Touchscreen mall directory + wayfinding for Balikpapan Superblock (e-Walk & Pentacity, PAM Group),
plus a phone page that continues the guidance after scanning a QR code.
Plain HTML/CSS/JS, no build step. Everything the kiosk needs is local (GSAP, QR lib, fonts, icons are vendored),
so the kiosk works offline. Only the phone needs network access to the kiosk server.

## Run

**Setup after `git clone` / `git pull` (database, CMS login, checks): see [`CARA_MENJALANKAN.md`](CARA_MENJALANKAN.md)** — `php tools/setup.php import` then `php tools/setup.php check`.

XAMPP Apache serves the folder:

| What | URL |
|---|---|
| Kiosk (default kiosk `gf-pentacity`) | http://localhost/bsb-directory/ |
| Another kiosk | `http://localhost/bsb-directory/?kiosk=ug-ewalk` (ids: `lg-pentacity, gf-ewalk-left, gf-ewalk-right, gf-pentacity, ug-ewalk, ug-pentacity, ff-pentacity`) |
| Skip the attract screen (testing) | `?attract=0` · open a tenant directly: `?t=uniqlo-gf` · English: `?lang=en` |
| Override the QR base for this launch | `?base=https://xxxx.trycloudflare.com/bsb-directory` |
| Phone page | `/m/?k=<kioskId>&t=<tenantId>&a=<0|1>` e.g. http://localhost/bsb-directory/m/?k=gf-pentacity&t=cinema-xxi-sf-penta&a=0 |

Windows kiosk PC: `kiosk/start-kiosk.bat` (Edge `--kiosk … --edge-kiosk-type=fullscreen`, pinch/overscroll disabled).
Autostart and PC hardening: `kiosk/README-kiosk.txt`.

## Files

```
index.html            kiosk app (1920×1080 landscape: left panel 740 px + map stage)
m/index.html          phone page (portrait)
config.js             PUBLIC_BASE, DEFAULT_KIOSK, mapNorthDeg, metersPerUnit, idle timeout, language, featured/promos
css/base.css          design tokens + shared map styles     css/kiosk.css · css/phone.css
js/data.js            loads data/directory.json, indexes, floor-SVG cache (each SVG fetched & parsed once)
js/route.js           Dijkstra (port of tools/verify_routes.py), leg splitting, Indonesian/English turn-by-turn text
js/map.js             MapView shared by kiosk & phone: camera (pan / pinch / wheel / fly-to), floor transitions,
                      screen-space overlay (route glow + draw animation, You-are-here, destination pin, connectors, dot)
js/search.js          fuzzy search (name / brand / keywords / category + Indonesian synonyms, typo tolerant)
js/kiosk.js           kiosk UI: attract screen, search (on-screen QWERTY or a physical keyboard: type, ↓ ↑, Enter, Esc), categories, A–Z, filters, detail, route playback, QR
js/phone.js           phone UI: compass arrow, calibration, pedometer, steps, floor-change sheet, arrival
js/icons.js js/qr.js  vendored Lucide icons (ISC) · QR → inline SVG (qrcode-generator, MIT, assets/vendor)
js/map3d.js           MapView3D: same API, renders floors listed in data/3d/floors.json as 3D (Three.js r147, MIT, assets/vendor)
js/scene3d.js         3D floor scene shared by kiosk, phone and editor3d.html (roof names/logos, facility icons)
editor3d.html         3D roof editor (name/logo overrides); saves through the CMS API (CMS > Peta 3D) or tools/3d/serve3d.py
tools/3d/             Illustrator SVG → 3D model, registration, rebase of CMS data onto the drawing, local server without PHP
tools/dev_router.php  router for PHP's built-in server: php -S 127.0.0.1:8000 tools/dev_router.php (kiosk + CMS + API)
docs/screens/         verification screenshots
```

3D floors (360° turn, layers, roof names/logos from the CMS; every floor, GF and UG joined from one drawing per building): see `docs/3D.md`. Local run with the CMS: `php -S 127.0.0.1:8000 tools/dev_router.php` (PHP 8 + MariaDB); without PHP: `python3 tools/3d/serve3d.py --port 8000`.

`data/` and `tools/` are the data layer and are not modified by the UI.

## Testing the phone page from a real phone

The QR on the kiosk encodes `${PUBLIC_BASE}/m/?k=…&t=…&a=…`. By default PUBLIC_BASE is the page origin
(`http://localhost/...`), which a phone cannot open — in dev mode the kiosk shows an orange warning under the QR.

1. **Same Wi-Fi / LAN (quick):** find the Mac/PC IP (`ipconfig getifaddr en0` on macOS, `ipconfig` on Windows),
   then set `PUBLIC_BASE: 'http://192.168.x.x/bsb-directory'` in `config.js` (or open the kiosk with `?base=…`).
   The page, map and steps work over http, but current Chrome (Android) and Safari (iOS) only deliver orientation/motion
   sensors to secure (HTTPS) pages, so expect fallback mode (map + manual steps) over a plain LAN IP.
2. **HTTPS tunnel (needed for the compass, especially iOS):**
   ```
   brew install cloudflared          # Windows: winget install Cloudflare.cloudflared
   cloudflared tunnel --url http://localhost:80
   ```
   It prints `https://<random>.trycloudflare.com`. Set `PUBLIC_BASE: 'https://<random>.trycloudflare.com/bsb-directory'`.
   Why: iOS Safari only exposes `DeviceOrientationEvent.requestPermission()` (compass) and motion data on HTTPS pages,
   and the permission prompt must come from a user tap — that is what the **Mulai Navigasi** button does.
   Production: host the `m/` page (plus `data/`, `js/`, `css/`, `assets/`) on a real HTTPS domain.

Phone behaviour:
- **Compass mode** (sensors granted): Find-My-style arrow = bearing to a point ~6 m ahead on the route − device heading + map north.
  Because `mapNorthDeg` is unknown, the first time the phone asks to *“point the top of the phone at <landmark>”* and saves the
  offset in `localStorage` (`bsb-north-<kioskId>`). Setting `mapNorthDeg` in `config.js` skips this.
- **Pedometer:** peaks in |accelerationIncludingGravity| (high-pass, 280 ms refractory) → each step moves the dot 0.7 m along the
  route and auto-advances steps within a floor. Floor changes always wait for “Saya sudah di UG — Lanjut”.
- **Manual correction:** “Sudah sampai sini” jumps to the next waypoint, ‹ goes back, tapping a step in the list jumps there.
- **Fallback** (desktop / denied / http on iOS): arrow points in map direction, map + step list + manual Next.

## Estimates (not measured)

| Item | Value | Where |
|---|---|---|
| metres per cost unit | 0.7 m (Pentacity GF corridor ≈ 280 units ≈ 200 m) | `config.metersPerUnit` |
| detail-floor scale | `floor.unitScale` from the data layer (±30 %) | data |
| walking speed / stride | 1.2 m/s · 0.7 m | config |
| escalator / lift time | 25 s per level / 60 s per trip | config |
| map north, kiosk facing | unknown → phone calibration; kiosk instructions avoid absolute directions on the first step | config / data |

Turn words (lurus / serong / belok kiri-kanan) are computed on the drawn polylines. The plans are isometric illustrations;
an affine drawing keeps left/right correct but distorts angles, so a single north offset is only approximate.

## Verification done

Headless Chromium (Playwright) with touch emulation, 1920×1080 kiosk and 390×844 phone — screenshots in `docs/screens/`.
No console errors. JS router reproduces `tools/verify_routes.py` exactly (1470/1470 kiosk→tenant routes, 1449 in accessible mode,
identical costs on sampled pairs). Touch pinch/pan/tap on the map, idle → attract reset, simulated `deviceorientationabsolute`
(arrow rotates −90° when the phone turns +90°) and `devicemotion` (12 steps at 2 Hz → dot advanced 8.4 m and auto-advanced a step).
Route animation measured at ~16.7 ms/frame (60 fps) on the dev Mac.

## TODO for production

- Admin panel (tenants, logos, promos, opening hours, closures) instead of editing JSON; content sync to kiosks.
- Real kiosk positions + `facingDeg` per kiosk (so the first instruction can say “jalan ke kanan”), true north (`mapNorthDeg`),
  escalator directions (up-only/down-only) → drop wrong-way edges.
- Measured scale (a few tape/laser distances per floor) to replace the `metersPerUnit` estimate.
- Missing map data: toilets, musholla, ATM, info desk, parking entrances, 2F E-Walk corridors & lift (see data report).
- HTTPS hosting for the phone page; analytics (searches, routes); accessibility audit (contrast, screen reader on phone);
  kiosk watchdog (auto reload on error / nightly restart).
