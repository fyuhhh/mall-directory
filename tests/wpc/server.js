#!/usr/bin/env node
/*
 * WP-C test server: static app under /bsb-directory/ + a mock of the WP-A public API (CMS_SPEC §4.4).
 * http://localhost:<port> is a secure context, so the Service Worker works.
 *   node tests/wpc/server.js [port=8787]
 * Control (tests only):  POST /__ctl/state {mode:'old'|'v2'|'legacy', status, promos, directoryVersion, kiosk:{perfMode,..}, commands:[..]}
 *                        (breakData: true -> data/directory.json answers 500, to test the localStorage fallback)
 *                        GET  /__ctl/log   -> received pings / telemetry / acks / phone beacons
 * mode 'old'    = pre-CMS directory (tests/fixtures/directory.v1.json) + mock API
 * mode 'legacy' = pre-CMS directory, no API, no version/promos/status files (pre-CMS deployment)
 * mode 'real'   = files written by the WP-A publisher in data/ (+ mock API for ping/telemetry)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = +process.argv[2] || 8787, BASE = '/bsb-directory/';
const FIX = path.join(ROOT, 'tests', 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain' };
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const st = {
  mode: 'v2', key: 'testkey',
  status: readJ(path.join(FIX, 'status.v2.json')),
  promos: readJ(path.join(FIX, 'promos.v2.json')),
  kiosk: null, commands: [], minAppBuild: null, directoryVersion: null,
  log: { ping: [], telemetry: [], ack: [], phone: [], requests: 0 }
};
// old/legacy = frozen pre-CMS snapshot; v2 = WP-C fixture; real = whatever the WP-A publisher wrote to data/
function dirFile() { return st.mode === 'v2' ? path.join(FIX, 'directory.v2.json') : st.mode === 'real' ? path.join(ROOT, 'data', 'directory.json') : path.join(FIX, 'directory.v1.json'); }
function dirVersion() { if (st.directoryVersion) return st.directoryVersion; if (st.mode === 'old' || st.mode === 'legacy') return null; return readJ(dirFile()).meta.version; }
function versions() {
  const dv = dirVersion();
  return { directory: { version: dv, url: 'data/directory.json?v=' + dv, publishedAt: '2026-10-04T12:00:00+08:00' },
    promos: { version: st.promos.version, url: 'data/promos.json?v=' + st.promos.version },
    status: { version: st.status.version, url: 'data/status.json?v=' + st.status.version },
    serverTime: new Date().toISOString(), minAppBuild: st.minAppBuild };
}
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch (e) { r({ _raw: b }); } }); }); }
function authed(req) { return req.headers['x-kiosk-key'] === st.key && !!req.headers['x-kiosk-id']; }

http.createServer(async (req, res) => {
  st.log.requests++;
  const u = url.parse(req.url, true);
  let p = decodeURIComponent(u.pathname);
  if (p === '/__ctl/state' && req.method === 'POST') {
    const b = await body(req);
    ['mode', 'status', 'promos', 'kiosk', 'minAppBuild', 'directoryVersion', 'breakData'].forEach(k => { if (k in b) st[k] = b[k]; });
    if (b.commands) st.commands = st.commands.concat(b.commands);
    if (b.resetLog) st.log = { ping: [], telemetry: [], ack: [], phone: [], requests: 0 };
    return send(res, 200, { ok: true, versions: versions() });
  }
  if (p === '/__ctl/log') return send(res, 200, st.log);
  if (p === '/') { res.writeHead(302, { Location: BASE }); return res.end(); }
  if (!p.startsWith(BASE)) return send(res, 404, 'not found', 'text/plain');
  let rel = p.slice(BASE.length);
  const legacy = st.mode === 'legacy';

  // ---- mock API ----
  if (rel.startsWith('api/')) {
    if (legacy) return send(res, 404, { error: { code: 'not_found' } });
    const r = rel.slice(4);
    if (r === 'version' && req.method === 'GET') return send(res, 200, versions());
    if (r === 'kiosk/ping' && req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: { code: 'unauthenticated' } });
      const b = await body(req); b._at = Date.now(); b._kiosk = req.headers['x-kiosk-id']; st.log.ping.push(b);
      const cmds = st.commands.filter(c => !c._delivered); cmds.forEach(c => c._delivered = true);
      return send(res, 200, { data: { versions: versions(), commands: cmds.map(c => ({ id: c.id, cmd: c.cmd, payload: c.payload || null })), kiosk: st.kiosk, serverTime: new Date().toISOString() } });
    }
    if (r === 'kiosk/ack' && req.method === 'POST') { if (!authed(req)) return send(res, 401, {}); st.log.ack.push(await body(req)); return send(res, 200, { data: { ok: true } }); }
    if (r === 'telemetry' && req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: { code: 'unauthenticated' } });
      const b = await body(req); (b.events || []).forEach(e => st.log.telemetry.push(e));
      return send(res, 200, { data: { accepted: (b.events || []).length, rejected: 0 } });
    }
    if (r === 'telemetry/phone' && req.method === 'POST') { st.log.phone.push(await body(req)); res.writeHead(204); return res.end(); }
    return send(res, 404, { error: { code: 'not_found' } });
  }
  // ---- live snapshot channels ----
  if (rel === 'data/directory.json') {
    if (st.breakData) return send(res, 500, 'boom', 'text/plain');
    if (st.mode === 'v2' && st.directoryVersion) { const D = readJ(dirFile()); D.meta.version = st.directoryVersion; return send(res, 200, D); }
    return send(res, 200, fs.readFileSync(dirFile()));
  }
  if (st.mode === 'real' && /^data\/(status|promos|version)\.json$/.test(rel)) {
    if (rel === 'data/status.json' && st.statusOverride) return send(res, 200, st.status);
    return send(res, 200, fs.readFileSync(path.join(ROOT, rel)));
  }
  if (rel === 'data/status.json') return legacy ? send(res, 404, 'nf', 'text/plain') : send(res, 200, st.status);
  if (rel === 'data/promos.json') return legacy ? send(res, 404, 'nf', 'text/plain') : send(res, 200, st.promos);
  if (rel === 'data/version.json') return legacy ? send(res, 404, 'nf', 'text/plain') : send(res, 200, versions());
  // ---- static ----
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  fs.stat(f, (err, s) => {
    if (err || !s.isFile()) return send(res, 404, 'not found', 'text/plain');
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': type }); return res.end(); }
    send(res, 200, fs.readFileSync(f), type, { 'Cache-Control': 'no-cache' });
  });
}).listen(PORT, () => console.log('WP-C test server http://localhost:' + PORT + BASE));
