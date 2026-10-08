#!/usr/bin/env node
/*
 * WP-C end-to-end tests (headless Chromium via playwright-core) against tests/wpc/server.js (mock WP-A API).
 *   PW=<path to playwright-core> CHROME=<chromium executable> OUT=<screenshot dir> node tests/wpc/e2e.js [only=name,name]
 * Covers: old snapshot + v2 fixture load, live closure (fast poll and default 60 s poll), notice, commands, idle hot reload,
 *         lite mode (CPU 6×, Chromium-68 UA, single touch), CMS perfMode, SW offline, localStorage fallback,
 *         multi-floor leg list at 1920×1080 & 1512×780, phone closures + beacons, console errors.
 */
'use strict';
const path = require('path'), cp = require('child_process'), fs = require('fs'), http = require('http');
const PW = process.env.PW || '/Users/affanridha/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core';
const EXE = process.env.CHROME || '/Users/affanridha/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = (process.env.OUT || path.join(__dirname, 'out')) + '/';
const PORT = 8788, BASE = 'http://localhost:' + PORT + '/bsb-directory/';
const ONLY = (process.argv.find(a => a.startsWith('only=')) || '').slice(5).split(',').filter(Boolean);
const { chromium } = require(PW);
fs.mkdirSync(OUT, { recursive: true });

let server = null;
function startServer() {
  return new Promise(res => {
    server = cp.spawn(process.execPath, [path.join(__dirname, 'server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
    server.stdout.once('data', () => res());
  });
}
function stopServer() { return new Promise(res => { if (!server) return res(); server.once('exit', () => res()); server.kill(); server = null; }); }
function ctl(pathname, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: 'localhost', port: PORT, path: pathname, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], consoleErrors = [];
function ok(name, cond, info) { results.push({ name, ok: !!cond, info: info == null ? '' : String(info) }); console.log((cond ? '  ok   ' : '  FAIL ') + name + (info != null ? '  — ' + info : '')); }
const FIX = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', p), 'utf8'));
const DIR2 = FIX('directory.v2.json');
let sv = 1;
const statusWith = (extra) => Object.assign({ version: 'S' + String(++sv).padStart(4, '0') + '-202610041300', generated: new Date().toISOString(), closures: [], edgeOverrides: [], amenityClosures: [], notice: null }, extra || {});
async function reset(extra) { await ctl('/__ctl/state', Object.assign({ mode: 'v2', status: statusWith(), promos: FIX('promos.v2.json'), kiosk: null, directoryVersion: null, minAppBuild: null, breakData: false, resetLog: true }, extra || {})); }

async function newPage(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1920, height: 1080 }, serviceWorkers: opts.sw ? 'allow' : 'block' }, opts.ctx || {}));
  const page = await ctx.newPage();
  const tag = opts.tag || '?';
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text()} @${(m.location() || {}).url || ''}`); });
  page.on('pageerror', e => consoleErrors.push(`[${tag}] pageerror ${e.message}`));
  return { ctx, page };
}
async function ready(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.__kioskReady === true, null, { timeout: 20000 });
}
const T = {};

// ---------------------------------------------------------------- A. snapshots
T.old = async (b) => {
  await reset({ mode: 'old' });
  const { ctx, page } = await newPage(b, { tag: 'old' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5');
  const r = await page.evaluate(() => ({ v: BSB.D.version, pois: BSB.D.amenities.filter(a => a.kind === 'poi').length, keyed: BSB.D.graph.edges.filter(e => e[4]).length, lang: BSB.lang, att: document.getElementById('attWelcome').textContent }));
  ok('old snapshot loads (no meta.version, no 5th edge element)', r.v === null && r.keyed === 0, JSON.stringify(r));
  ok('default language EN + attract EN', r.lang === 'en' && r.att === 'Welcome to');
  await page.mouse.click(960, 980); await sleep(800);
  await page.evaluate(() => __kiosk.openRoute('andalas-ff-penta')); await sleep(9000);
  const p = await page.evaluate(() => ({ ok: __kiosk.state.plan.ok, legs: __kiosk.state.plan.legs.length, qr: document.getElementById('route').dataset.url }));
  ok('old snapshot: multi-floor route works', p.ok && p.legs === 3, JSON.stringify(p));
  ok('QR keeps &lang= and adds &s=<session>', /&lang=en/.test(p.qr) && /&s=[a-z0-9]{12}/.test(p.qr), p.qr);
  await page.screenshot({ path: OUT + 'A1_old_snapshot_route.png' });
  await ctx.close();
};
T.legacy = async (b) => {
  await reset({ mode: 'legacy' });
  const before = consoleErrors.length;
  const { ctx, page } = await newPage(b, { tag: 'legacy' });
  await ready(page, BASE + '?kiosk=gf-pentacity&poll=5');
  await sleep(7000);
  const r = await page.evaluate(() => ({ promos: BSB.promosData, status: BSB.statusData, card: document.querySelector('#attPromo .promo .pk').textContent, sync: BSB.syncState.reachable }));
  ok('legacy deployment (no API/promos/status): kiosk runs, placeholder promos', r.promos === null && r.status === null && /Placeholder/.test(r.card), JSON.stringify(r));
  const errs = consoleErrors.splice(before);
  ok('legacy: only expected 404 noise for missing optional files', errs.every(e => /Failed to load resource: .*404/.test(e)), errs.length + ' x 404 (promos/status/version/api)');
  await page.screenshot({ path: OUT + 'A2_legacy_attract.png' });
  await ctx.close();
};
T.v2 = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'v2' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5');
  ok('key removed from address bar', !/key=/.test(page.url()), page.url());
  const r = await page.evaluate(() => ({ v: BSB.D.version, pois: document.querySelectorAll('.mv-amen .poi').length, hero: __kiosk.playlist().list('attract-hero').map(p => p.id),
    card: document.querySelector('#attPromo [data-pid]') && document.querySelector('#attPromo [data-pid]').getAttribute('data-pid'), amen: document.querySelectorAll('#amenRow .amen-btn').length }));
  ok('v2 snapshot loads', r.v === 'D0001-202610041200', r.v);
  ok('POIs rendered on map (GF)', r.pois >= 3, r.pois + ' POI markers');
  ok('promo targeting: ug-ewalk-only promo filtered out', r.hero.indexOf(104) < 0 && r.hero.length === 3, JSON.stringify(r.hero));
  ok('promo card from promos.json on attract', !!r.card, 'pid ' + r.card);
  ok('home facilities: connectors + POI types (max 6)', r.amen === 6, r.amen);
  await page.screenshot({ path: OUT + 'B1_v2_attract_promo.png' });
  // wait for the fullscreen takeover (every 4th hero promo; 6 s each) and capture it
  let full = false; for (let i = 0; i < 30 && !full; i++) { await sleep(1000); full = await page.evaluate(() => !!document.querySelector('.promo-full')); }
  ok('attract-fullscreen takeover shown after 4 hero promos', full);
  if (full) await page.screenshot({ path: OUT + 'B2_v2_fullscreen_promo.png' });
  await page.mouse.click(960, 980); await sleep(900);
  await page.screenshot({ path: OUT + 'B3_v2_home.png' });
  await page.evaluate(() => __kiosk.openDetail('kfc-lg-penta')); await sleep(1800);
  const badge = await page.evaluate(() => document.querySelector('#detail .st-badge') && document.querySelector('#detail .st-badge').textContent);
  ok('temp_closed badge in detail', badge === 'Temporarily closed', badge);
  await page.screenshot({ path: OUT + 'B4_v2_detail_tempclosed.png' });
  await page.evaluate(() => __kiosk.openDetail('starbucks-gf-penta')); await sleep(800);
  const hrs = await page.evaluate(() => document.getElementById('detail').textContent.match(/Open today [0-9:–, ]+|Closed today/));
  ok('hoursWeek -> "Open today …"', !!hrs, hrs && hrs[0]);
  await page.evaluate(() => { __kiosk.setQuery('sepatu'); }); await sleep(1800);
  await page.evaluate(() => __kiosk.routeToAmenity('toilet')); await sleep(2500);
  const am = await page.evaluate(() => __kiosk.state.target && __kiosk.state.target.id);
  ok('nearest toilet (POI) route', am === 'toilet-gf-penta-1', am);
  await page.evaluate(() => BSB.tele.flush()); await sleep(1500);
  const log = await ctl('/__ctl/log');
  const types = {}; log.telemetry.forEach(e => types[e.type] = (types[e.type] || 0) + 1);
  ok('telemetry batch delivered (session/search/tenant_view/route…)', types.session_start && types.search && types.tenant_view && types.route, JSON.stringify(types));
  const hb = log.ping[log.ping.length - 1] || {};
  ok('heartbeat: perfActive + UA + clientType + versions', hb.perfActive === 'full' && /Chrome/.test(hb.ua) && hb.clientType === 'windows_pc' && hb.versions && hb.versions.directory === 'D0001-202610041200',
    JSON.stringify({ perfActive: hb.perfActive, clientType: hb.clientType, versions: hb.versions, swActive: hb.swActive, queueLen: hb.queueLen }));
  await ctx.close();
};

// ---------------------------------------------------------------- C. live closure
T.closure = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'closure' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5&attract=0');
  await page.evaluate(() => __kiosk.openRoute('andalas-ff-penta')); await sleep(10000);
  const before = await page.evaluate(() => ({ cost: __kiosk.state.plan.cost, keys: __kiosk.state.plan.legs.map(l => l.transition && l.transition.type).join(',') }));
  await page.screenshot({ path: OUT + 'C1_route_before_closure.png' });
  const L = DIR2.graph.rules;
  const t0 = Date.now();
  await ctl('/__ctl/state', { status: statusWith({ closures: [{ key: 'L5', dir: 'both', from: '2026-10-01T00:00:00+08:00', to: null, label: L.L5.label, reason: { en: 'maintenance', id: 'perawatan' } }] }) });
  await page.waitForFunction(() => BSB.statusData && BSB.statusData.closures.length === 1, null, { timeout: 20000 });
  const dt = Date.now() - t0;
  await sleep(9000);
  const after = await page.evaluate(() => ({ cost: __kiosk.state.plan.cost, detour: (__kiosk.state.plan.detour || []).map(d => d.label), closedMarkers: document.querySelectorAll('.mv-amen .amen.closed').length,
    note: document.querySelector('.r-detour') && document.querySelector('.r-detour').textContent, reloaded: performance.navigation.type }));
  ok('closure applied live without reload (poll=5 s)', after.detour.length && after.cost > before.cost && after.reloaded === 0, `${(dt / 1000).toFixed(1)} s; cost ${before.cost.toFixed(1)} -> ${after.cost.toFixed(1)}; ${after.note}`);
  await page.screenshot({ path: OUT + 'C2_route_after_closure_detour.png' });
  // close every connector -> "route closed" message
  await ctl('/__ctl/state', { status: statusWith({ closures: Object.keys(L).map(k => ({ key: k, dir: 'both', from: null, to: null, label: L[k].label, reason: { en: 'maintenance', id: 'perawatan' } })) }) });
  await page.waitForFunction(() => BSB.statusData && BSB.statusData.closures.length > 5, null, { timeout: 20000 });
  await sleep(1500);
  const err = await page.evaluate(() => document.querySelector('.r-err') && document.querySelector('.r-err').textContent);
  ok('all connectors closed -> routeClosed message', /is closed .*Information Desk/.test(err || ''), err);
  await page.screenshot({ path: OUT + 'C3_route_closed_message.png' });
  // markers on GF
  await page.evaluate(() => { document.querySelector('[data-back]').click(); }); await sleep(1500);
  await page.evaluate(() => __kiosk.map().showFloor('gf', { animate: false })); await sleep(500);
  const m = await page.evaluate(() => document.querySelectorAll('.mv-amen .amen.closed').length);
  ok('closed connectors get the wrench badge on the map', m > 0, m + ' markers');
  await page.screenshot({ path: OUT + 'C4_map_closed_connectors.png' });
  // notice banner + emergency
  await ctl('/__ctl/state', { status: statusWith({ notice: { level: 'warning', text: { en: 'Escalators on GF are under maintenance today.', id: 'Eskalator GF dalam perawatan hari ini.' }, to: null, kiosks: '*' } }) });
  await page.waitForSelector('#noticeBar', { timeout: 20000 });
  ok('notice banner (warning)', true);
  await page.screenshot({ path: OUT + 'C5_notice_warning.png' });
  await ctl('/__ctl/state', { status: statusWith({ notice: { level: 'emergency', text: { en: 'Please evacuate calmly via the nearest exit.', id: 'Harap evakuasi dengan tenang melalui pintu keluar terdekat.' }, to: null, kiosks: '*' } }) });
  await page.waitForSelector('#noticeEmg', { timeout: 20000 });
  ok('emergency notice overlay', true);
  await page.screenshot({ path: OUT + 'C6_notice_emergency.png' });
  await ctl('/__ctl/state', { status: statusWith() });
  await page.waitForFunction(() => !document.getElementById('noticeEmg'), null, { timeout: 20000 });
  ok('notice removed when status clears', true);
  await ctx.close();
};
// default poll (60 s ± 10 s): closure must be applied within 70 s
T.closure60 = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'closure60' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey');
  await sleep(12000); // after the first (5 s) poll, i.e. worst case = one full interval
  const t0 = Date.now();
  await ctl('/__ctl/state', { status: statusWith({ closures: [{ key: 'L5', dir: 'up', from: null, to: null, label: DIR2.graph.rules.L5.label, reason: { en: 'broken', id: 'rusak' } }] }) });
  await page.waitForFunction(() => BSB.statusData && BSB.statusData.closures.length === 1, null, { timeout: 80000, polling: 250 }).catch(() => {});
  const dt = (Date.now() - t0) / 1000;
  ok('closure applied with default POLL_SEC=60 within 70 s', dt <= 70, dt.toFixed(1) + ' s');
  await ctx.close();
};

// ---------------------------------------------------------------- E. commands + hot reload
T.commands = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'commands' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5');
  await ctl('/__ctl/state', { commands: [{ id: 17, cmd: 'identify' }] });
  await page.waitForSelector('.identify', { timeout: 15000 });
  await page.screenshot({ path: OUT + 'E1_identify.png' });
  // directory publish while a visitor is using the kiosk -> no reload until idle
  await page.mouse.click(960, 980); await sleep(500);
  await page.evaluate(() => __kiosk.openDetail('uniqlo-gf'));
  await ctl('/__ctl/state', { directoryVersion: 'D0002-202610041400' });
  await page.waitForFunction(() => BSB.syncState.prefetched === 'D0002-202610041400', null, { timeout: 30000 });
  await sleep(3000);
  const still = await page.evaluate(() => BSB.D.version);
  ok('new directory prefetched but NOT reloaded while in use', still === 'D0001-202610041200', still);
  const nav = page.waitForNavigation({ timeout: 20000 });
  await page.evaluate(() => __kiosk.goIdle());
  await nav; await page.waitForFunction(() => window.__kioskReady === true, null, { timeout: 20000 });
  const v = await page.evaluate(() => BSB.D.version);
  ok('reloaded on idle -> new directory version live', v === 'D0002-202610041400', v);
  // reload command (kiosk is idle on attract) + ack
  await ctl('/__ctl/state', { commands: [{ id: 18, cmd: 'reload' }] });
  const nav2 = page.waitForNavigation({ timeout: 30000 }).then(() => true, () => false);
  ok('reload command executes at idle', await nav2);
  await sleep(2000);
  const log = await ctl('/__ctl/log');
  ok('commands acked', log.ack.some(a => a.commandId === 17) && log.ack.some(a => a.commandId === 18), JSON.stringify(log.ack));
  await ctx.close();
};

// ---------------------------------------------------------------- G. lite mode
T.lite = async (b) => {
  await reset();
  const UA = 'Mozilla/5.0 (Linux; Android 9; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36';
  const { ctx, page } = await newPage(b, { tag: 'lite', ctx: { userAgent: UA, hasTouch: true } });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await ready(page, BASE + '?kiosk=ug-ewalk&key=testkey&poll=5');
  const r = await page.evaluate(() => ({ cls: document.documentElement.className, mode: BSB.perf.mode, reason: BSB.perf.reason, blob: getComputedStyle(document.querySelector('.blob')).display,
    bf: getComputedStyle(document.querySelector('.floor-switch')).backdropFilter, tiles: document.querySelectorAll('#attTrack .att-tile').length, touch: navigator.maxTouchPoints }));
  ok('lite auto-detected (Chromium 68 UA / smart_tv)', r.mode === 'lite' && /lite/.test(r.cls), r.reason);
  ok('lite: no blur blobs, no backdrop-filter, static marquee page', r.blob === 'none' && (r.bf === 'none' || !r.bf) && r.tiles <= 6, JSON.stringify(r));
  ok('ug-ewalk sees its targeted promo', await page.evaluate(() => __kiosk.playlist().list('attract-hero').some(p => p.id === 104)));
  await page.screenshot({ path: OUT + 'G1_lite_attract.png' });
  await page.touchscreen.tap(960, 980); await sleep(800);
  // fps during the route animation (single leg + transition legs)
  await page.evaluate(() => { window.__fr = []; let last = performance.now(); (function f(t) { window.__fr.push(t - last); last = t; if (window.__fr.length < 100000) requestAnimationFrame(f); })(last); });
  await page.evaluate(() => __kiosk.openRoute('matahari-ff-ewalk'));
  await sleep(8000);
  const fps = await page.evaluate(() => { const a = window.__fr.slice(5); const avg = a.reduce((x, y) => x + y, 0) / a.length; return { fps: Math.round(1000 / avg), n: a.length, p95: Math.round(a.slice().sort((x, y) => x - y)[Math.floor(a.length * .95)]) }; });
  ok('lite route animation >= 30 fps under 6x CPU throttle', fps.fps >= 30, JSON.stringify(fps));
  await sleep(3000);
  await page.screenshot({ path: OUT + 'G2_lite_route.png' });
  for (const f of ['lg-penta', 'sf-penta', 'sf-ewalk', 'ff-penta', 'lg-ewalk']) { await page.evaluate(id => __kiosk.map().showFloor(id, { animate: false }), f); await sleep(300); }
  const layers = await page.evaluate(() => document.querySelectorAll('.map-floor').length);
  ok('lite: at most 3 floor SVGs kept in the DOM', layers <= 3, layers + ' layers');
  await page.evaluate(() => BSB.sync.pollNow()); await sleep(2500);
  const log = await ctl('/__ctl/log'); const hb = log.ping[log.ping.length - 1] || {};
  ok('heartbeat reports perfActive=lite + smart_tv', hb.perfActive === 'lite' && hb.clientType === 'smart_tv', hb.perfActive + ' / ' + hb.clientType + ' / ' + hb.perfReason);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();
};
T.cmsLite = async (b) => {
  await reset({ kiosk: { perfMode: 'lite', clientType: 'windows_pc', defaultLang: 'en' } });
  const { ctx, page } = await newPage(b, { tag: 'cmsLite' });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5');
  await page.waitForFunction(() => BSB.perf.mode === 'lite', null, { timeout: 20000 });
  await page.evaluate(() => BSB.sync.pollNow()); await sleep(2500);
  const log = await ctl('/__ctl/log'); const hb = log.ping[log.ping.length - 1] || {};
  ok('CMS perfMode=lite (ping) -> lite + heartbeat perfActive=lite', hb.perfActive === 'lite' && hb.perfReason === 'cms', hb.perfActive + ' ' + hb.perfReason);
  ok('perf_switch telemetry event', (await page.evaluate(() => new Promise(r => BSB.tele.peekAll(r)))).some(e => e.type === 'perf_switch') || log.telemetry.some(e => e.type === 'perf_switch'));
  await page.evaluate(() => localStorage.removeItem('bsb-perf-cms'));
  await ctx.close();
};

// ---------------------------------------------------------------- H. offline
T.offline = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'offline', sw: true });
  await ready(page, BASE + '?kiosk=gf-pentacity&key=testkey&poll=5');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForFunction(() => window.__kioskReady === true && !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  // visit floors so the SVGs / logos are cached
  await page.evaluate(() => Promise.all(BSB.D.floors.map(f => BSB.loadFloorSvg(f.id))));
  await page.evaluate(() => BSB.warmAssets(BSB.assetsOf(BSB.D)).catch(e => String(e)));
  const sw = await page.evaluate(() => caches.keys());
  ok('Service Worker active + caches created', sw.some(k => /^bsb-shell-/.test(k)) && sw.indexOf('bsb-media-v1') >= 0, sw.join(', '));
  await stopServer();
  await page.reload();
  const up = await page.waitForFunction(() => window.__kioskReady === true, null, { timeout: 20000 }).then(() => true, () => false);
  ok('server down: kiosk boots from Service Worker cache', up);
  await page.mouse.click(960, 980); await sleep(600);
  await page.evaluate(() => __kiosk.openRoute('matahari-ff-ewalk')); await sleep(11000);
  const st = await page.evaluate(() => ({ ok: __kiosk.state.plan.ok, q: BSB.tele.queueLen, reach: BSB.syncState.reachable }));
  ok('offline: routing works, telemetry queued, sync marks server unreachable', st.ok && st.q > 0 && st.reach === false, JSON.stringify(st));
  await page.screenshot({ path: OUT + 'H1_offline_route.png' });
  await startServer(); await reset();
  await page.evaluate(() => BSB.tele.flush()); await sleep(2000);
  const log = await ctl('/__ctl/log');
  ok('server back: queued telemetry delivered', log.telemetry.length >= st.q, log.telemetry.length + ' events');
  await ctx.close();
};
T.lsFallback = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'lsFallback' }); // SW blocked = old TV browser / plain HTTP
  await ready(page, BASE + '?kiosk=gf-pentacity');
  await ctl('/__ctl/state', { breakData: true });
  await page.reload(); await page.waitForFunction(() => window.__kioskReady === true, null, { timeout: 20000 });
  ok('no SW + data fetch fails: snapshot restored from localStorage', await page.evaluate(() => BSB.offlineSnap === true && BSB.D.tenants.length === 210));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const scr = await page.waitForSelector('#offlineScr', { timeout: 10000 }).then(() => true, () => false);
  ok('no SW + no saved snapshot: "Connecting…" screen with retry', scr);
  await page.screenshot({ path: OUT + 'H2_connecting_screen.png' });
  await ctl('/__ctl/state', { breakData: false });
  await ctx.close();
};

// ---------------------------------------------------------------- I. leg list layout
T.legs = async (b) => {
  await reset();
  for (const vp of [[1920, 1080], [1512, 780]]) {
    for (const [kid, tid, tag] of [['gf-pentacity', 'andalas-ff-penta', '3leg'], ['lg-pentacity', 'bsb-karaoke-and-club-lg-ewalk', '5leg']]) {
      const { ctx, page } = await newPage(b, { tag: 'legs', ctx: { viewport: { width: vp[0], height: vp[1] } } });
      await ready(page, BASE + `?kiosk=${kid}&attract=0`);
      await page.evaluate(id => __kiosk.openRoute(id), tid);
      await page.waitForFunction(() => document.querySelectorAll('#legs .leg.done').length === document.querySelectorAll('#legs .leg').length, null, { timeout: 60000 });
      await sleep(1200);
      const m = await page.evaluate(() => { const l = document.getElementById('legs'); const vis = [...l.querySelectorAll('.leg:not(.tr)')].filter(e => e.offsetTop + e.offsetHeight <= l.clientHeight + l.scrollTop + 2).length; return { legs: __kiosk.state.plan.legs.length, visibleLegHeaders: vis, client: l.clientHeight, scroll: l.scrollHeight }; });
      ok(`leg list ${vp.join('x')} ${tag}: all leg headers visible after playback`, m.visibleLegHeaders === m.legs, JSON.stringify(m));
      await page.screenshot({ path: OUT + `I_legs_${tag}_${vp.join('x')}_done.png` });
      await page.evaluate(() => document.querySelector('#legs .leg[data-leg="1"]').click()); await sleep(4000);
      await page.screenshot({ path: OUT + `I_legs_${tag}_${vp.join('x')}_leg2.png` });
      await ctx.close();
    }
  }
};

// ---------------------------------------------------------------- J. phone
T.phone = async (b) => {
  await reset();
  const { ctx, page } = await newPage(b, { tag: 'phone', ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await page.goto(BASE + 'm/?k=gf-pentacity&t=andalas-ff-penta&a=0&lang=en&s=abcdefabcdef');
  await page.waitForFunction(() => window.__phoneReady === true, null, { timeout: 20000 });
  await sleep(1500);
  await page.screenshot({ path: OUT + 'J1_phone_start.png' });
  await page.click('#startBtn'); await sleep(1500);
  const log = await ctl('/__ctl/log');
  ok('phone beacons qr_scan + nav_start (with kiosk session id)', log.phone.some(e => e.type === 'qr_scan' && e.sid === 'abcdefabcdef') && log.phone.some(e => e.type === 'nav_start'), log.phone.map(e => e.type).join(','));
  const L = DIR2.graph.rules;
  await ctl('/__ctl/state', { status: statusWith({ closures: Object.keys(L).map(k => ({ key: k, dir: 'both', from: null, to: null, label: L[k].label, reason: { en: 'maintenance', id: 'perawatan' } })) }) });
  await page.goto(BASE + 'm/?k=gf-pentacity&t=andalas-ff-penta&a=0&lang=en');
  await sleep(2500);
  const msg = await page.evaluate(() => !document.getElementById('scrErr').hidden && document.getElementById('errTxt').textContent);
  ok('phone respects closures (route closed message)', /is closed/.test(msg || ''), msg);
  await page.screenshot({ path: OUT + 'J2_phone_route_closed.png' });
  await ctl('/__ctl/state', { status: statusWith({ closures: [{ key: 'L5', dir: 'both', from: null, to: null, label: L.L5.label, reason: { en: 'maintenance', id: 'perawatan' } }] }) });
  await page.goto(BASE + 'm/?k=gf-pentacity&t=andalas-ff-penta&a=0&lang=en');
  await page.waitForFunction(() => window.__phoneReady === true, null, { timeout: 20000 });
  const steps = await page.evaluate(() => document.getElementById('stepsStart').textContent);
  ok('phone detours around a closed escalator leg', !/Escalator A · Pentacity/.test(steps) && /escalator|lift/i.test(steps), (steps.match(/Take [^.]*?to [A-Z][a-z]+ [A-Z][a-z]+/g) || []).join(' | '));
  await ctx.close();
};

// chained escalators GF→UG→1F→2F (stacked stops share a node): every floor listed, visited during playback, phone steps floor by floor
T.chain = async (b) => {
  await reset();
  for (const lang of ['en', 'id']) {
    const { ctx, page } = await newPage(b, { tag: 'chain' });
    await ready(page, BASE + `?kiosk=gf-pentacity&attract=0&lang=${lang}`);
    const visited = [];
    await page.exposeFunction('__floorSeen', f => visited.push(f));
    await page.evaluate(() => { const m = __kiosk.map(), o = m.onFloor; m.onFloor = function (f) { window.__floorSeen(f); if (o) o.apply(this, arguments); }; });
    await page.evaluate(() => __kiosk.openRoute('matahari-sf-ewalk'));
    await page.waitForFunction(() => document.querySelector('#legs .leg.tr.cont.on'), null, { timeout: 30000 });
    await sleep(1500);
    await page.screenshot({ path: OUT + `L_chain_${lang}_dwell_${await page.evaluate(() => __kiosk.map().floor)}.png` });
    await page.waitForFunction(() => document.querySelectorAll('#legs .leg.done').length === document.querySelectorAll('#legs .leg').length, null, { timeout: 60000 });
    await sleep(1200);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#legs .leg')].map(e => e.textContent.trim().slice(0, 70)));
    const via = await page.evaluate(() => (document.querySelector('.stat-via') || {}).textContent);
    ok(`chain ${lang}: every hop listed (3 transition rows) + via chip`, rows.length === 5 && /UG · 1F/.test(via || ''), JSON.stringify(rows) + ' | ' + via);
    ok(`chain ${lang}: playback visits GF → UG → 1F E-Walk → 2F E-Walk`, ['ug', 'ff-ewalk', 'sf-ewalk'].every(f => visited.indexOf(f) >= 0) && visited.indexOf('ug') < visited.indexOf('ff-ewalk'), visited.join(' → '));
    await page.screenshot({ path: OUT + `L_chain_${lang}_done.png` });
    await ctx.close();
  }
  const { ctx, page } = await newPage(b, { tag: 'chainPhone', ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await page.goto(BASE + 'm/?k=gf-pentacity&t=matahari-sf-ewalk&a=0&lang=en');
  await page.waitForFunction(() => window.__phoneReady === true, null, { timeout: 20000 });
  await sleep(1200);
  await page.screenshot({ path: OUT + 'L_chain_phone_steps.png', fullPage: true });
  await page.click('#startBtn'); await sleep(600);
  const sheets = [];
  for (let i = 0; i < 12; i++) {
    const st = await page.evaluate(() => __phone.state());
    if (st.kind === 'transition') {
      sheets.push(await page.evaluate(() => document.getElementById('flBtn').textContent + ' [' + document.getElementById('flSeq').textContent + '] map=' + document.querySelector('.map-floor[style*="visible"]').dataset.floor));
      await sleep(900);
      if (sheets.length === 2) await page.screenshot({ path: OUT + 'L_chain_phone_sheet_UG.png' });
    }
    if (st.ci >= st.total - 1) break;
    await page.evaluate(() => __phone.next()); await sleep(500);
  }
  ok('phone: floor change sheet steps floor by floor (UG, 1F, 2F)', sheets.length === 3 && /UG/.test(sheets[0]) && /1F/.test(sheets[1]) && /2F/.test(sheets[2]), sheets.join(' | '));
  await ctx.close();
};

// WP-A publisher output (data/*.json written by the real publisher) through the mock server + XAMPP (if running)
T.real = async (b) => {
  await reset({ mode: 'real' });
  const { ctx, page } = await newPage(b, { tag: 'real' });
  await ready(page, BASE + '?kiosk=ug-pentacity&key=testkey&poll=5');
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'version.json'), 'utf8'));
  const r = await page.evaluate(() => ({ v: BSB.D.version, s: BSB.statusData && BSB.statusData.version, p: BSB.promosData && BSB.promosData.version, keyed: BSB.D.graph.edges.filter(e => e[4]).length }));
  ok('WP-A publisher snapshot loads (directory/promos/status)', r.v === live.directory.version && r.s === live.status.version && r.p === live.promos.version, JSON.stringify(r));
  await page.mouse.click(960, 980); await sleep(600);
  await page.evaluate(() => __kiosk.openRoute('matahari-sf-ewalk')); await sleep(8000);
  ok('WP-A snapshot: multi-floor route', await page.evaluate(() => __kiosk.state.plan.ok && __kiosk.state.plan.legs.length > 1));
  await page.screenshot({ path: OUT + 'K1_wpa_snapshot_route.png' });
  await ctx.close();
  const x = await new Promise(res => http.get('http://localhost/bsb-directory/index.html', r => res(r.statusCode)).on('error', () => res(0)));
  if (x === 200) {
    const before = consoleErrors.length;
    const { ctx: c2, page: p2 } = await newPage(b, { tag: 'xampp' });
    await ready(p2, 'http://localhost/bsb-directory/?kiosk=gf-pentacity&poll=5');
    await sleep(7000);
    const s2 = await p2.evaluate(() => ({ v: BSB.D.version, mode: BSB.syncState.mode, reach: BSB.syncState.reachable }));
    const errs = consoleErrors.splice(before);
    ok('XAMPP (real Apache, publisher files): kiosk loads, sync falls back to data/version.json', s2.v && s2.reach === true, JSON.stringify(s2) + '; console: ' + (errs.length ? errs.length + ' x ' + errs[0].replace(/@.*/, '') : 'clean'));
    await c2.close();
  }
};

(async () => {
  await startServer();
  const browser = await chromium.launch({ executablePath: EXE });
  const names = Object.keys(T).filter(n => !ONLY.length || ONLY.indexOf(n) >= 0);
  for (const n of names) {
    console.log('== ' + n);
    try { await T[n](browser); } catch (e) { ok(n + ' crashed', false, e.message.split('\n')[0]); if (!server) await startServer(); }
  }
  await browser.close(); await stopServer();
  // offline scenarios intentionally produce connection-refused / 500 errors; everything else counts
  const expected = consoleErrors.filter(e => /^\[(offline|lsFallback)\] Failed to load resource: (net::ERR_CONNECTION_REFUSED|the server responded with a status of 500)/.test(e));
  const unexpected = consoleErrors.filter(e => expected.indexOf(e) < 0);
  console.log('\nconsole errors: ' + unexpected.length + ' unexpected, ' + expected.length + ' expected (simulated outages)'); unexpected.forEach(e => console.log('   ' + e));
  ok('no unexpected console errors', unexpected.length === 0, unexpected.length);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(OUT + 'results.json', JSON.stringify({ results, consoleErrors }, null, 1));
  process.exit(failed.length ? 1 : 0);
})();
