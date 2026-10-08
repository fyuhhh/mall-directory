/*
 * sw.js — BSB Directory offline cache (CMS_SPEC §6.3). Scope = app root (/bsb-directory/).
 * Registered by index.html and m/index.html as  sw.js?v=<APP_BUILD>  -> a new build = a new SW (old shell cache deleted).
 * Requires a secure context (HTTPS or http://localhost). Without it the page falls back to localStorage (§6.4).
 *
 * Strategies
 *   shell (html/js/css/fonts/vendor/brand)            : precached; stale-while-revalidate
 *   navigation (index.html, m/)                         : network-first (3 s) -> cache (ignoring ?kiosk=..) -> offline.html
 *   data/{directory,promos,status,version}.json, api/version : network-first (3 s) -> last cached copy
 *   data/directory.json?v=, data/releases/, media/          : cache-first (immutable, versioned names)
 *   assets/logos/, data/floors/ (legacy fixed names)         : stale-while-revalidate (offline copy, refreshed in background)
 *   api/kiosk/*, api/telemetry*, api/admin/*, cms/*, every non-GET : network only, never cached
 */
'use strict';
var BUILD = (function () { try { return new URL(self.location.href).searchParams.get('v') || 'dev'; } catch (e) { return 'dev'; } })();
var SHELL = 'bsb-shell-' + BUILD, JSONC = 'bsb-json-v2', MEDIA = 'bsb-media-v2';
var SCOPE = self.registration ? self.registration.scope : new URL('./', self.location.href).href;
var SHELL_FILES = [
  'index.html', 'm/index.html', 'offline.html', 'config.js',
  'css/base.css', 'css/kiosk.css', 'css/phone.css', 'css/lite.css', 'css/runtime.css',
  'js/perf.js', 'js/icons.js', 'js/i18n.js', 'js/data.js', 'js/route.js', 'js/search.js', 'js/qr.js', 'js/map.js',
  'js/kiosk.js', 'js/phone.js', 'js/telemetry.js', 'js/sync.js', 'js/promos.js',
  'assets/vendor/gsap.min.js', 'assets/vendor/qrcode.min.js',
  'assets/fonts/PlusJakartaSans-latin.woff2', 'assets/fonts/PlusJakartaSans-latin-ext.woff2',
  'assets/brand/ewalk.webp', 'assets/brand/pentacity.webp'
];
var TIMEOUT = 3000;

function abs(p) { return new URL(p, SCOPE).href; }

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(SHELL).then(function (c) {
    // one by one: a single missing file must not break the install
    return Promise.all(SHELL_FILES.map(function (p) {
      return fetch(abs(p), { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(abs(p), r); }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return (k.indexOf('bsb-shell-') === 0 && k !== SHELL) || (k.indexOf('bsb-json-') === 0 && k !== JSONC) || (k.indexOf('bsb-media-') === 0 && k !== MEDIA);
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (ev) {
  var d = ev.data || {};
  if (d.type === 'skipWaiting') self.skipWaiting();
  if (d.type === 'warm' && d.urls) caches.open(MEDIA).then(function (c) {
    d.urls.forEach(function (u) { caches.match(u).then(function (hit) { if (!hit) fetch(u).then(function (r) { if (r.ok) c.put(u, r); }).catch(function () {}); }); });
  });
});

function rel(url) { return url.href.indexOf(SCOPE) === 0 ? url.href.slice(SCOPE.length) : null; }

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;                                   // POST telemetry/ping/admin: untouched
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var r = rel(url); if (r == null) return;
  var path = r.split('?')[0];
  if (/^(api\/(kiosk|telemetry|admin)|cms\/)/.test(path)) return;     // network only
  if (req.headers.get('range')) return;                                // video range requests: let the browser handle
  if (url.searchParams.get('probe') === '1') return;                   // sync.js reachability probes must hit the network

  if (req.mode === 'navigate') { ev.respondWith(navigate(req)); return; }
  if (/^data\/(directory|promos|status|version)\.json$/.test(path) && !url.search.match(/[?&]v=/) || path === 'api/version' ||
      /^api\/(directory|promos|status)\.json$/.test(path) || /^tests\/fixtures\/[^/]+\.json$/.test(path)) {
    ev.respondWith(networkFirst(req, JSONC, { ignoreSearch: true })); return;
  }
  if ((/^data\/directory\.json$/.test(path) && url.search.match(/[?&]v=/)) || /^(data\/releases|media)\//.test(path)) {
    ev.respondWith(cacheFirst(req, MEDIA)); return;                     // content-addressed / versioned -> immutable
  }
  if (/^(assets\/logos|data\/floors|tests\/fixtures\/media)\//.test(path)) {
    ev.respondWith(staleWhileRevalidate(req, MEDIA)); return;           // legacy fixed names: cache, refresh in background
  }
  if (/^(index\.html|config\.js|css\/|js\/|assets\/(vendor|fonts|brand)\/|offline\.html|m\/index\.html)/.test(path)) {
    ev.respondWith(staleWhileRevalidate(req)); return;
  }
  // anything else: network, cached copy if offline
  ev.respondWith(fetch(req).catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (h) { return h || Response.error(); }); }));
});

function timeout(ms, p) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
  });
}
function keyOf(req, ignoreSearch) { if (!ignoreSearch) return req; var u = new URL(req.url); return u.origin + u.pathname; }

function networkFirst(req, cacheName, opt) {
  var key = keyOf(req, opt && opt.ignoreSearch);
  var net = fetch(req, { cache: 'no-cache' }).then(function (r) {
    if (r && r.ok) { var c = r.clone(); caches.open(cacheName).then(function (cc) { cc.put(key, c); }); }
    return r;
  });
  return timeout(TIMEOUT, net).catch(function () {
    return caches.match(key).then(function (hit) { return hit || net; });   // slow server: cached copy; nothing cached: keep waiting
  }).then(function (r) {
    if (r && (r.ok || r.type === 'opaqueredirect')) return r;
    return caches.match(key).then(function (hit) { return hit || r; });     // 5xx/404 from a broken server -> last good copy
  }, function () { return caches.match(key).then(function (hit) { return hit || Response.error(); }); });
}

function cacheFirst(req, cacheName) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (r) {
      if (r && r.ok) { var c = r.clone(); caches.open(cacheName).then(function (cc) { cc.put(req, c); }); }
      return r;
    });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName || SHELL).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req, { cache: 'no-cache' }).then(function (r) { if (r && r.ok) c.put(keyOf(req, true), r.clone()); return r; });
      if (hit) { net.catch(function () {}); return hit; }
      return net.catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (h) { return h || Response.error(); }); });
    });
  });
}

function navigate(req) {
  var u = new URL(req.url), p = rel(u).split('?')[0];
  var shell = abs(/^m(\/|$)/.test(p) ? 'm/index.html' : (p === '' || p === 'index.html') ? 'index.html' : p);
  var net = fetch(req).then(function (r) {
    if (r && r.ok && (p === '' || /index\.html$|^m\/?$/.test(p))) { var c = r.clone(); caches.open(SHELL).then(function (cc) { cc.put(shell, c); }); }
    return r;
  });
  return timeout(TIMEOUT, net).then(function (r) {
    if (r.ok) return r;
    return caches.match(shell).then(function (h) { return h || r; });
  }).catch(function () {
    return caches.match(shell).then(function (h) {
      return h || net.catch(function () { return caches.match(abs('offline.html')); }).then(function (x) { return x || caches.match(abs('offline.html')); });
    });
  });
}
