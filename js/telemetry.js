/*
 * telemetry.js — kiosk analytics (CMS_SPEC §6.5). ES5 only.
 *   BSB.track(type, fields)  -> queued in IndexedDB (fallback: localStorage ring buffer), max 5 000 events (oldest dropped)
 *   flush every 60 s or when >= 50 events are queued; batch <= 500; POST <API>/telemetry with X-Kiosk-Id / X-Kiosk-Key.
 *   failure -> backoff 1, 2, 5, 10 min. Survives reloads and server outages.
 *   Sessions: BSB.tele.startSession() on first touch (attract closed), endSession() on idle -> session_end {value: ms}.
 */
window.BSB = window.BSB || {};
(function (B) {
  var cfg = window.BSB_CONFIG || {};
  var MAX = 5000, BATCH = 500, FLUSH_MS = 60000, FLUSH_AT = 50, BACKOFF = [60, 120, 300, 600];
  var TYPES = { session_start: 1, session_end: 1, search: 1, category_open: 1, az_open: 1, tenant_view: 1, route: 1, route_fail: 1,
    amenity_route: 1, qr_shown: 1, promo_imp: 1, promo_tap: 1, lang_switch: 1, floor_switch: 1, error: 1, perf_switch: 1 };

  // ---------------- storage: IndexedDB with localStorage fallback ----------------
  var LSK = 'bsb-tele-q';
  function lsStore() {
    function read() { try { return JSON.parse(localStorage.getItem(LSK) || '[]'); } catch (e) { return []; } }
    function write(a) { try { localStorage.setItem(LSK, JSON.stringify(a)); } catch (e) { a.splice(0, Math.ceil(a.length / 2)); try { localStorage.setItem(LSK, JSON.stringify(a)); } catch (e2) {} } }
    var seq = Date.now();
    return {
      kind: 'localStorage',
      add: function (evs, cb) { var a = read(); evs.forEach(function (e) { a.push({ k: ++seq, v: e }); }); if (a.length > MAX) a.splice(0, a.length - MAX); write(a); cb && cb(); },
      peek: function (n, cb) { cb(read().slice(0, n)); },
      del: function (keys, cb) { var s = {}; keys.forEach(function (k) { s[k] = 1; }); write(read().filter(function (x) { return !s[x.k]; })); cb && cb(); },
      count: function (cb) { cb(read().length); }
    };
  }
  function idbStore(db) {
    function os(mode) { return db.transaction('q', mode).objectStore('q'); }
    return {
      kind: 'indexedDB',
      add: function (evs, cb) {
        try {
          var tx = db.transaction('q', 'readwrite'), s = tx.objectStore('q');
          evs.forEach(function (e) { s.add(e); });
          tx.oncomplete = function () { trim(); cb && cb(); }; tx.onerror = function () { cb && cb(); };
        } catch (e) { cb && cb(); }
      },
      peek: function (n, cb) {
        var out = [];
        try {
          os('readonly').openCursor().onsuccess = function (ev) {
            var c = ev.target.result;
            if (c && out.length < n) { out.push({ k: c.key, v: c.value }); c.continue(); } else cb(out);
          };
        } catch (e) { cb(out); }
      },
      del: function (keys, cb) {
        try { var tx = db.transaction('q', 'readwrite'), s = tx.objectStore('q'); keys.forEach(function (k) { s.delete(k); }); tx.oncomplete = function () { cb && cb(); }; tx.onerror = function () { cb && cb(); }; }
        catch (e) { cb && cb(); }
      },
      count: function (cb) { try { os('readonly').count().onsuccess = function (ev) { cb(ev.target.result); }; } catch (e) { cb(0); } }
    };
    function trim() { // drop oldest beyond MAX
      store.count(function (n) {
        if (n <= MAX) return;
        var drop = n - MAX, keys = [];
        os('readonly').openCursor().onsuccess = function (ev) {
          var c = ev.target.result; if (c && keys.length < drop) { keys.push(c.key); c.continue(); } else store.del(keys);
        };
      });
    }
  }

  var store = null, pending = [], ready = false;
  function setStore(s) {
    store = s; ready = true;
    if (pending.length) { var p = pending; pending = []; store.add(p, function () { maybeFlush(); }); }
    store.count(function (n) { T.queueLen = n; });
  }
  try {
    if (!window.indexedDB) throw new Error('no idb');
    var req = indexedDB.open('bsb-telemetry', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('q', { autoIncrement: true }); };
    req.onsuccess = function () { setStore(idbStore(req.result)); };
    req.onerror = req.onblocked = function () { setStore(lsStore()); };
    setTimeout(function () { if (!ready) setStore(lsStore()); }, 3000);
  } catch (e) { setStore(lsStore()); }

  // ---------------- API ----------------
  var T = B.tele = { sid: null, sessionStart: 0, queueLen: 0, lastFlushOk: null, failures: 0, sent: 0 };
  function rid(n) { var s = '', a = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < n; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  T.rid = rid;

  B.track = function (type, fields) {
    if (!TYPES[type]) return;
    var e = { ts: Date.now(), type: type, sid: T.sid, lang: B.lang };
    if (fields) for (var k in fields) if (fields[k] !== undefined) e[k] = fields[k];
    T.queueLen++;
    if (!ready) pending.push(e); else store.add([e], maybeFlush);
  };
  T.startSession = function () {
    if (T.sid) return T.sid;
    T.sid = rid(12); T.sessionStart = Date.now();
    B.track('session_start');
    return T.sid;
  };
  T.endSession = function () {
    if (!T.sid) return;
    B.track('session_end', { value: Date.now() - T.sessionStart });
    T.sid = null; T.sessionStart = 0;
    T.flush();
  };

  var timer = 0, busy = false, nextAt = 0;
  function maybeFlush() { if (T.queueLen >= FLUSH_AT && Date.now() >= nextAt) T.flush(); }
  T.flush = function () {
    if (busy || !ready) return;
    var id = B.kioskIdentity ? B.kioskIdentity() : {};
    if (!id.key || !id.id) { store.count(function (n) { T.queueLen = n; }); return; } // unprovisioned kiosk: keep (capped) queue
    if (Date.now() < nextAt) return;
    busy = true;
    store.peek(BATCH, function (rows) {
      if (!rows.length) { busy = false; T.queueLen = 0; return; }
      var body = JSON.stringify({ kioskId: id.id, events: rows.map(function (r) { return r.v; }) });
      fetch(B.apiUrl('/telemetry'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Id': id.id, 'X-Kiosk-Key': id.key },
        body: body, cache: 'no-store' }).then(function (r) {
        // 2xx accepted; 4xx other than 401/408/429 = poison batch -> drop it so the queue cannot get stuck
        if (r.ok || (r.status >= 400 && r.status < 500 && [401, 408, 429].indexOf(r.status) < 0)) {
          store.del(rows.map(function (x) { return x.k; }), function () {
            T.sent += rows.length; T.failures = 0; nextAt = 0; T.lastFlushOk = Date.now(); busy = false;
            store.count(function (n) { T.queueLen = n; if (n >= FLUSH_AT) T.flush(); });
          });
        } else throw new Error('HTTP ' + r.status);
      }).catch(function () {
        T.failures++; nextAt = Date.now() + BACKOFF[Math.min(T.failures - 1, BACKOFF.length - 1)] * 1000; busy = false;
      });
    });
  };
  T.storeKind = function () { return store ? store.kind : null; };
  T.peekAll = function (cb) { if (store) store.peek(MAX, function (r) { cb(r.map(function (x) { return x.v; })); }); else cb(pending.slice()); };

  timer = setInterval(function () { T.flush(); }, (cfg.TELEMETRY_SEC || FLUSH_MS / 1000) * 1000);
  window.addEventListener('online', function () { nextAt = 0; T.flush(); });
  window.addEventListener('error', function (ev) { try { B.track('error', { msg: String(ev.message || ev.error || 'error').slice(0, 200) }); T.lastError = String(ev.message).slice(0, 200); } catch (e) {} });
})(window.BSB);
