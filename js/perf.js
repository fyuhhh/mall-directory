/*
 * perf.js — performance profile (loaded FIRST, in <head>, right after config.js).
 * Decides 'full' | 'lite' and sets <html class="lite">. ES5 only (smart-TV browsers ≈ Chromium 68).
 * Priority: URL ?perf=lite|full  >  CMS perfMode (kiosks[].perfMode / ping response, cached in localStorage)
 *           >  config.perfMode  >  auto.
 * auto -> lite when any of: deviceMemory <= 2, hardwareConcurrency <= 4, Chromium < 90, no backdrop-filter,
 *         clientType smart_tv, or average frame time > 25 ms during the first 3 s of the attract animation.
 */
window.BSB = window.BSB || {};
(function (B) {
  var cfg = window.BSB_CONFIG || {};
  var de = document.documentElement;
  var q = null; try { q = new URLSearchParams(location.search).get('perf'); } catch (e) {}
  var LS = 'bsb-perf-cms';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function chromeVer() { var m = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(navigator.userAgent); return m ? +m[1] : null; }
  function supportsBackdrop() {
    try { return !!(window.CSS && CSS.supports && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))); }
    catch (e) { return false; }
  }

  // reasons the device looks weak (empty = looks fine)
  function autoReasons(clientType) {
    var r = [], v = chromeVer();
    if (navigator.deviceMemory && navigator.deviceMemory <= 2) r.push('deviceMemory<=2');
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) r.push('cores<=4');
    if (v && v < 90) r.push('chromium' + v);
    if (!supportsBackdrop()) r.push('no-backdrop');
    if (clientType === 'smart_tv') r.push('smart_tv');
    return r;
  }

  var P = B.perf = {
    mode: 'full', reason: 'default', lite: false, source: 'default',
    dprCap: 1.5,
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    listeners: []
  };

  function apply(mode, reason, source) {
    var changed = mode !== P.mode;
    P.mode = mode; P.lite = mode === 'lite'; P.reason = reason; P.source = source;
    if (P.lite) de.classList.add('lite'); else de.classList.remove('lite');
    de.setAttribute('data-perf', mode);
    if (window.gsap) tuneGsap();
    if (changed) for (var i = 0; i < P.listeners.length; i++) try { P.listeners[i](mode, reason); } catch (e) {}
    return changed;
  }

  // resolve with everything known so far; cmsMode/clientType come from the snapshot or the ping response
  P.resolve = function (cmsMode, clientType) {
    if (cmsMode !== undefined) lsSet(LS, cmsMode && cmsMode !== 'auto' ? cmsMode : (clientType === 'smart_tv' ? 'auto-tv' : null));
    var stored = lsGet(LS);
    if (q === 'lite' || q === 'full') return apply(q, 'url', 'url');
    if (stored === 'lite' || stored === 'full') return apply(stored, 'cms', 'cms');
    if (cfg.perfMode === 'lite' || cfg.perfMode === 'full') return apply(cfg.perfMode, 'config', 'config');
    var ct = clientType || (stored === 'auto-tv' ? 'smart_tv' : cfg.clientType);
    var r = autoReasons(ct);
    if (P.source === 'fps' && P.lite) return false;                        // measured slow -> stay lite
    return apply(r.length ? 'lite' : 'full', r.length ? 'auto:' + r.join(',') : 'auto', 'auto');
  };
  P.isAuto = function () { return P.source === 'auto' || P.source === 'default'; };
  P.onChange = function (fn) { P.listeners.push(fn); };

  // GSAP helpers: shorter (≤ 250 ms) or instant animations in lite mode
  P.dur = function (d) { return P.lite ? Math.min(d, 0.25) : d; };
  function tuneGsap() {
    try { gsap.ticker.lagSmoothing(P.lite ? 250 : 500, 33); } catch (e) {}
  }

  // average frame time over `ms` (default 3000) — switch to lite when > 25 ms (auto mode only)
  P.measure = function (ms, cb) {
    if (!window.requestAnimationFrame) return;
    var start = 0, last = 0, n = 0, sum = 0, end = (ms || 3000);
    function f(ts) {
      if (!start) { start = last = ts; return requestAnimationFrame(f); }
      sum += ts - last; n++; last = ts;
      if (ts - start < end) return requestAnimationFrame(f);
      var avg = sum / Math.max(1, n);
      P.lastFrameMs = Math.round(avg * 10) / 10;
      if (avg > 25 && !P.lite && P.isAuto()) { apply('lite', 'auto:frame' + Math.round(avg) + 'ms', 'fps'); if (cb) cb(true, avg); }
      else if (cb) cb(false, avg);
    }
    requestAnimationFrame(f);
  };

  P.resolve();
  if (window.gsap) tuneGsap();
  else document.addEventListener('DOMContentLoaded', function () { if (window.gsap) tuneGsap(); });

  // flex `gap` arrived in Chromium 84 -> older TV browsers get margin fallbacks in css/lite.css
  try {
    var t = document.createElement('div'); t.style.display = 'flex'; t.style.flexDirection = 'column'; t.style.rowGap = '1px';
    t.appendChild(document.createElement('div')); t.appendChild(document.createElement('div'));
    var check = function () { document.body.appendChild(t); var ok = t.scrollHeight === 1; document.body.removeChild(t); if (!ok) de.classList.add('no-flexgap'); };
    if (document.body) check(); else document.addEventListener('DOMContentLoaded', check);
  } catch (e) {}
})(window.BSB);
