/*
 * promos.js — attract-screen playlist from promos.json (CMS_SPEC §2.10, §6.6). ES5 only.
 *   slot 'attract-hero'      : card in .att-promo (520×380). image -> <img>, video -> muted inline video (lite: poster),
 *                              text/event -> colour card. Smooth weighted round-robin by `weight`.
 *   slot 'attract-fullscreen': takeover every N hero promos (default 4) for durationSec.
 *   filters: from/to, days (1=Mon..7=Sun), time window (mall local time), targets ('*' | [kioskId]).
 *   impressions: promo visible >= 1 s -> track('promo_imp', {p, ms}); tap -> track('promo_tap', {p}) + link action.
 *   Fallback when promos.json is missing/empty: config.promos placeholders (exactly the old look).
 */
window.BSB = window.BSB || {};
(function (B) {
  var cfg = window.BSB_CONFIG || {};
  var PLACEHOLDER_BG = ['linear-gradient(135deg,#1D1A17,#4A3B2A)', 'linear-gradient(135deg,#B8893B,#7A5320)', 'linear-gradient(135deg,#2F5BEA,#1A2F7A)'];

  function Playlist(opts) {
    this.box = opts.box;              // .att-promo element
    this.layer = opts.layer;          // element for fullscreen takeovers (#attract)
    this.lang = opts.lang || 'en';
    this.kioskId = opts.kioskId || null;
    this.onLink = opts.onLink || function () {};
    this.data = null; this.items = []; this.cw = {}; this.i = 0; this.heroCount = 0;
    this.timer = 0; this.running = false; this.cur = null; this.shownAt = 0; this.fullEvery = cfg.fullscreenEvery || 4;
    var self = this;
    this.box.addEventListener('pointerup', function (e) { self._tap(e); });
  }

  // ---- filtering (mall local time) ----
  function localParts(now) {
    var m = B.mallNow ? B.mallNow(now) : null;
    if (m) return m;
    var d = new Date(now); return { dow: d.getDay() || 7, min: d.getHours() * 60 + d.getMinutes() };
  }
  function toMin(s) { var p = String(s || '0:0').split(':'); return +p[0] * 60 + +(p[1] || 0); }
  Playlist.prototype.eligible = function (p, slot, now) {
    if (p.slot !== slot) return false;
    if (p.status && p.status !== 'active') return false;
    if (p.from && now < Date.parse(p.from)) return false;
    if (p.to && now > Date.parse(p.to)) return false;
    var lp = localParts(now);
    if (p.days && p.days.length && p.days.indexOf(lp.dow) < 0) return false;
    if (p.time && p.time.length === 2) {
      var a = toMin(p.time[0]), b = toMin(p.time[1]), m = lp.min;
      if (b === a) { /* all day */ } else if (b > a ? (m < a || m > b) : (m < a && m > b)) return false;
    }
    if (p.targets && p.targets !== '*' && (!this.kioskId || p.targets.indexOf(this.kioskId) < 0)) return false;
    if (p.kind === 'image' && !p.media) return false;
    if (p.kind === 'video' && !p.media && !p.poster) return false;
    return true;
  };
  Playlist.prototype.list = function (slot, now) {
    var self = this;
    return ((this.data && this.data.promos) || []).filter(function (p) { return self.eligible(p, slot, now || Date.now()); });
  };
  // smooth weighted round-robin (nginx style): deterministic, frequency proportional to weight, no bursts
  Playlist.prototype.pick = function (slot) {
    var L = this.list(slot), total = 0, best = null, self = this;
    if (!L.length) return null;
    L.forEach(function (p) {
      var w = Math.max(1, Math.min(10, +p.weight || 1)), k = slot + ':' + p.id;
      self.cw[k] = (self.cw[k] || 0) + w; total += w;
      if (!best || self.cw[k] > self.cw[slot + ':' + best.id]) best = p;
    });
    this.cw[slot + ':' + best.id] -= total;
    return best;
  };

  Playlist.prototype.setData = function (P) { this.data = P; this.cw = {}; if (this.running) { this._next(true); } };
  Playlist.prototype.setLang = function (l) { this.lang = l; };
  Playlist.prototype.featured = function () { return (this.data && this.data.featured && this.data.featured.length) ? this.data.featured : (cfg.featured || []); };

  Playlist.prototype.start = function () {
    if (this.running) return;
    this.running = true; this._next(true);
  };
  Playlist.prototype.stop = function () {
    this.running = false; clearTimeout(this.timer); this._endImpression(); this._closeFull(); this._pauseVideo();
  };

  // ---- impressions ----
  Playlist.prototype._beginImpression = function (p) { this._endImpression(); this.cur = p; this.shownAt = Date.now(); };
  Playlist.prototype._endImpression = function () {
    var p = this.cur; if (!p) return;
    var ms = Date.now() - this.shownAt; this.cur = null;
    if (p.id != null && !p._placeholder && ms >= 1000 && document.visibilityState !== 'hidden' && B.track) B.track('promo_imp', { p: p.id, ms: ms, slot: p.slot });
  };

  // ---- rendering ----
  function T(o, lang) { return !o ? '' : typeof o === 'string' ? o : (o[lang] || o.en || o.id || ''); }
  Playlist.prototype.cardHtml = function (p, idx) {
    var esc = B.esc, lang = this.lang, lite = B.perf && B.perf.lite;
    if (p._placeholder) {
      var en = lang === 'en';
      return '<div class="promo" style="background:' + PLACEHOLDER_BG[idx % PLACEHOLDER_BG.length] + '"><div class="pk">Promo · ' + (en ? 'Placeholder' : 'Contoh') + '</div><div class="pt">' +
        esc(en ? p.en : p.id) + '</div><div class="ps">' + esc(en ? p.subEn : p.subId) + '</div></div>';
    }
    var link = p.link && p.link.type && p.link.type !== 'none' ? ' data-link="1"' : '';
    var bg = p.bg ? (/^#[0-9a-f]{6}$/i.test(p.bg) ? 'linear-gradient(135deg,' + p.bg + ',' + shade(p.bg, -0.45) + ')' : '') : PLACEHOLDER_BG[idx % 3];
    if (p.kind === 'image' || (p.kind === 'video' && (lite || !p.media))) {
      var src = p.kind === 'video' ? (p.poster || '') : p.media;
      return '<div class="promo promo-media" data-pid="' + esc(p.id) + '"' + link + ' style="background:' + (p.bg || '#1D1A17') + '"><img src="' + esc(abs(src)) + '" alt="' + esc(T(p.title, lang)) + '" decoding="async"></div>';
    }
    if (p.kind === 'video') {
      return '<div class="promo promo-media" data-pid="' + esc(p.id) + '"' + link + ' style="background:#000"><video muted playsinline autoplay preload="auto"' +
        (p.poster ? ' poster="' + esc(abs(p.poster)) + '"' : '') + ' src="' + esc(abs(p.media)) + '"></video></div>';
    }
    // text / event: colour card like the original placeholder (without the "Placeholder" label)
    var kick = p.kind === 'event' ? (lang === 'en' ? 'Event' : 'Acara') : 'Promo';
    return '<div class="promo" data-pid="' + esc(p.id) + '"' + link + ' style="background:' + bg + '"><div class="pk">' + kick + '</div><div class="pt">' + esc(T(p.title, lang)) +
      '</div>' + (T(p.sub, lang) ? '<div class="ps">' + esc(T(p.sub, lang)) + '</div>' : '') + '</div>';
  };
  function abs(u) { return !u ? '' : /^(https?:)?\/\//.test(u) || u.charAt(0) === '/' ? u : B.ROOT + u; }
  function shade(hex, k) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    var f = function (c) { return Math.max(0, Math.min(255, Math.round(c * (1 + k)))); };
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }

  Playlist.prototype._next = function (instant) {
    var self = this;
    clearTimeout(this.timer);
    if (!this.running) return;
    var p = this.pick('attract-hero');
    var placeholders = (cfg.promos || []);
    if (!p) {
      if (!placeholders.length) return;
      var ph = placeholders[this.i % placeholders.length];
      p = { _placeholder: true, en: ph.en, id: ph.id, subEn: ph.subEn, subId: ph.subId, durationSec: 6 }; // config.promos shape
    }
    // fullscreen takeover every N hero promos
    if (!p._placeholder) {
      this.heroCount++;
      if (this.heroCount % this.fullEvery === 0) {
        var f = this.pick('attract-fullscreen');
        if (f) { this._showFull(f); return; }
      }
    }
    this._render(p, instant);
    var dur = Math.max(3, Math.min(30, +p.durationSec || (p._placeholder ? 6 : 8))) * 1000;
    this.i++;
    var v = this.box.querySelector('.promo:last-child video');
    if (v) {
      var done = false, go = function () { if (!done) { done = true; self._next(); } };
      v.addEventListener('ended', go);
      v.addEventListener('error', go);
      this.timer = setTimeout(go, dur + 500); // hard cap (durationSec ≤ 30)
      var pr = v.play && v.play(); if (pr && pr.catch) pr.catch(function () {});
    } else this.timer = setTimeout(function () { self._next(); }, dur);
  };
  Playlist.prototype._render = function (p, instant) {
    var box = this.box, old = box.firstChild;
    box.insertAdjacentHTML('beforeend', this.cardHtml(p, this.i));
    var nu = box.lastChild;
    var img = nu.querySelector && nu.querySelector('img');
    if (img) img.onerror = function () { img.style.display = 'none'; };
    this._beginImpression(p);
    var lite = B.perf && B.perf.lite;
    while (box.children.length > 2) box.removeChild(box.firstChild);
    old = box.children.length > 1 ? box.firstChild : null;
    if (instant || !window.gsap || !old) { if (old) box.removeChild(old); return; }
    if (lite) {
      gsap.fromTo(nu, { opacity: 0 }, { opacity: 1, duration: 0.25 });
      gsap.to(old, { opacity: 0, duration: 0.25, onComplete: function () { if (old.parentNode) old.parentNode.removeChild(old); } });
      return;
    }
    gsap.fromTo(nu, { opacity: 0, y: 30, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'power3.out' });
    gsap.to(old, { opacity: 0, duration: 0.6, onComplete: function () { if (old.parentNode) old.parentNode.removeChild(old); } });
  };
  Playlist.prototype._pauseVideo = function () { var v = this.box.querySelector('video'); if (v) try { v.pause(); } catch (e) {} };

  Playlist.prototype._showFull = function (p) {
    var self = this, lang = this.lang, lite = B.perf && B.perf.lite;
    this._closeFull();
    var el = document.createElement('div');
    el.className = 'promo-full';
    var media = p.kind === 'video' && !lite && p.media ? '<video muted playsinline autoplay src="' + B.esc(abs(p.media)) + '"' + (p.poster ? ' poster="' + B.esc(abs(p.poster)) + '"' : '') + '></video>'
      : (p.media || p.poster) ? '<img src="' + B.esc(abs(p.kind === 'video' ? (p.poster || p.media) : p.media)) + '" alt="">' : '<div class="pf-txt" style="background:' + B.esc(p.bg || '#1D1A17') + '"><b>' + B.esc(T(p.title, lang)) + '</b><span>' + B.esc(T(p.sub, lang)) + '</span></div>';
    el.innerHTML = media;
    el.setAttribute('data-pid', p.id);
    if (p.link && p.link.type && p.link.type !== 'none') el.setAttribute('data-link', '1');
    this.layer.appendChild(el);
    this.full = el;
    this._beginImpression(p);
    if (window.gsap) gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: lite ? 0.2 : 0.6 });
    var dur = Math.max(3, Math.min(30, +p.durationSec || 8)) * 1000;
    var v = el.querySelector('video');
    var end = function () { if (self.full !== el) return; self._closeFull(); if (self.running) self._next(); };
    if (v) { v.addEventListener('ended', end); v.addEventListener('error', end); }
    this.timer = setTimeout(end, dur);
    this._fullP = p;
  };
  Playlist.prototype._closeFull = function () {
    if (!this.full) return;
    this._endImpression();
    var el = this.full; this.full = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  };

  // tap on a promo card / takeover: returns true when handled (the attract screen should then NOT just close)
  Playlist.prototype.handleTap = function (target) {
    var el = target.closest && target.closest('[data-pid]');
    if (!el) return false;
    var id = el.getAttribute('data-pid'), p = null;
    ((this.data && this.data.promos) || []).forEach(function (x) { if (String(x.id) === id) p = x; });
    if (!p) return false;
    if (B.track) B.track('promo_tap', { p: p.id });
    if (!p.link || !p.link.type || p.link.type === 'none') return false;
    if (p.link.type === 'url') { this.showQr(p); return true; }
    this.stop();
    this.onLink(p.link, p);
    return true;
  };
  Playlist.prototype._tap = function () {};
  Playlist.prototype.showQr = function (p) {
    var self = this, el = document.createElement('div');
    el.className = 'promo-qr';
    el.innerHTML = '<div class="pq-card">' + (B.qrSvg ? B.qrSvg(p.link.ref, { margin: 1 }) : '') + '<b>' + B.esc(T(p.title, this.lang)) + '</b><span>' + B.esc(B.t('scanPromo')) + '</span><small>' + B.esc(B.t('tapToClose')) + '</small></div>';
    el.addEventListener('pointerup', function (e) { e.stopPropagation(); close(); });
    this.layer.appendChild(el);
    var to = setTimeout(close, 20000);
    function close() { clearTimeout(to); if (el.parentNode) el.parentNode.removeChild(el); }
    if (B.track) B.track('qr_shown', { t: 'promo:' + p.id });
  };

  B.Playlist = Playlist;
})(window.BSB);
