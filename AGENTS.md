# BSB Directory — Project Architecture & Agent Memory

## 1. Project Overview
- **Name:** BSB Directory (e-Walk & Pentacity Mall Balikpapan)
- **Scope:** Interactive touchscreen kiosk application (`index.html`), mobile wayfinding page (`m/index.html`), and full administrative CMS (`cms/`).
- **Tech Stack:**
  - Frontend: Vanilla JavaScript (ES modules), CSS3, HTML5, SVG map rendering.
  - Backend / CMS: PHP 8.x, MySQL/MariaDB schema (`db/schema.sql`), JSON data layer (`data/directory.json`).
  - Wayfinding: A* graph routing engine across multiple floors connected by elevators, escalators, and bridges.
- **Local Dev Server:** `php -S 0.0.0.0:8000` (port 8000).
- **CMS URL (Mock Mode):** `http://localhost:8000/cms/login.html?mock=1`

---

## 2. Key Modules & Directory Structure
- `index.html`: Main Kiosk app entry point (1920x1080 landscape).
- `m/index.html`: Mobile companion app for scanned QR wayfinding.
- `cms/`: Admin interface for managing tenants, categories, floors, graph nodes, and connectors.
  - `cms/js/pages/connectors.js`: Escalator, lift, and bridge editor.
  - `cms/js/pages/graph.js`: Visual graph editor for corridor nodes and edges.
  - `cms/js/pages/kiosks.js`: Kiosk anchor placement and facing direction.
- `js/`: Core kiosk and wayfinding logic.
  - `js/kiosk.js`: Kiosk interaction, search, UI state, attract loop, QR modal.
  - `js/map.js`: SVG pan/zoom/camera management, route rendering overlay.
  - `js/route.js`: Client-side Dijkstra routing engine.
- `data/`:
  - `data/directory.json`: Compiled directory snapshot consumed by kiosk and phone.
  - `data/floors/`: SVG vector floor plans for Pentacity and E-Walk.
- `tests/`: Automated regression suites.
- `tools/`: Verification, export, and graph compiler scripts (`verify_routes.py`, `publish_directory.php`).

---

## 3. Verified Bug Fixes & Architectural Decisions
1. **Route Cutting Regression (Captain Gelato & Tea Break GF E-Walk):**
   - Corrected island stall boundary vertices in `data/directory.json` so corridors and navigation lines no longer cut through tenant polygons.
2. **Kiosk QR Modal Back Button:**
   - Fixed unhandled reference in `js/kiosk.js` where `closeQrModal()` lacked proper scope binding upon returning from tenant detail view.
3. **Service Worker Caching & Offline Sync:**
   - Sanitized service worker registration in `config.js` and `index.html` to avoid stale caching during active local development.
4. **Wayfinding Verification:**
   - All 2,940 routes (default and accessible) verified via `node tests/wpc/route_regression.js` and `python3 tools/verify_routes.py`.

---

## 4. CMS Elevator & Escalator Workflow
- **Bank:** Vertical elevator shaft or escalator pair.
- **Stop:** Doorway/entrance on a specific floor attached to the nearest corridor node.
- **Leg:** Vertical connection between two stops.
- To update or add an elevator:
  1. Add or select the Bank in `#/connectors`.
  2. Mark stops on the floor plan for each served floor.
  3. Toggle "Berhenti di lantai ini" (`isServed`).
  4. Run "Regenerate legs" to automatically compute two-way vertical edges.
  5. Click **Publish** to export changes to `data/directory.json`.

---

## 5. Verification Commands
- Route regression: `node tests/wpc/route_regression.js`
- Python route verification: `python3 tools/verify_routes.py`
