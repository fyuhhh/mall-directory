/*
 * Route engine — faithful JS port of tools/verify_routes.py (Dijkstra) + leg splitting + turn-by-turn text.
 * Edge semantics: walk / lift / stairs / crossing undirected; escalator-up / escalator-down directed (edge[0] -> edge[1]).
 * Accessible mode drops escalator* and stairs edges.
 */
window.BSB = window.BSB || {};
(function (B) {
  function MinHeap() { this.a = []; }
  MinHeap.prototype.push = function (d, v) {
    var a = this.a, i = a.length; a.push([d, v]);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l][0] < a[m][0]) m = l;
        if (r < n && a[r][0] < a[m][0]) m = r;
        if (m === i) break; var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };

  function Router(D) {
    this.D = D;
    this.cfg = window.BSB_CONFIG || {};
    this.adj = { false: this._build(false), true: this._build(true) };
    this.cache = {};
  }

  Router.prototype._build = function (accessible) {
    var adj = {};
    this.D.graph.nodes.forEach(function (n) { adj[n.id] = []; });
    this.D.graph.edges.forEach(function (e) {
      var a = e[0], b = e[1], c = e[2], t = e[3];
      if (accessible && (t.indexOf('escalator') === 0 || t === 'stairs')) return;
      adj[a].push([b, c, t]);
      if (t.indexOf('escalator') !== 0) adj[b].push([a, c, t]);
    });
    return adj;
  };

  Router.prototype.dijkstra = function (src, accessible) {
    var key = src + '|' + !!accessible;
    if (this.cache[key]) return this.cache[key];
    var adj = this.adj[!!accessible], dist = {}, prev = {}, pq = new MinHeap();
    dist[src] = 0; pq.push(0, src);
    while (pq.a.length) {
      var top = pq.pop(), d = top[0], u = top[1];
      if (d > dist[u]) continue;
      var es = adj[u];
      for (var i = 0; i < es.length; i++) {
        var v = es[i][0], nd = d + es[i][1];
        if (dist[v] === undefined || nd < dist[v]) { dist[v] = nd; prev[v] = [u, es[i][2]]; pq.push(nd, v); }
      }
    }
    var res = { dist: dist, prev: prev };
    this.cache[key] = res;
    return res;
  };

  Router.prototype.path = function (src, dst, accessible) {
    var r = this.dijkstra(src, accessible);
    if (r.dist[dst] === undefined) return null;
    var nodes = [dst], types = [null];
    while (nodes[0] !== src) { var p = r.prev[nodes[0]]; types[0] = p[1]; nodes.unshift(p[0]); types.unshift(null); }
    return { nodes: nodes, types: types, cost: r.dist[dst] }; // types[i] = type of edge (i-1 -> i)
  };

  Router.prototype.nearestAmenity = function (src, type, accessible) {
    var r = this.dijkstra(src, accessible), best = null, bd = Infinity;
    this.D.amenities.forEach(function (a) {
      if (a.type !== type) return;
      if (type === 'escalator' && !(a.toFloors || []).length) return; // dangling escalator ends
      var d = r.dist[a.node];
      if (d !== undefined && d < bd) { bd = d; best = a; }
    });
    return best;
  };

  // ---------------- geometry helpers ----------------
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function heading(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }
  function normDeg(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    return { d: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t: t };
  }
  function simplify(pts, tol) { // Douglas–Peucker, returns indices
    var keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    (function rec(i, j) {
      if (j <= i + 1) return;
      var md = -1, mi = -1;
      for (var k = i + 1; k < j; k++) { var d = segDist(pts[k], pts[i], pts[j]).d; if (d > md) { md = d; mi = k; } }
      if (md > tol) { keep[mi] = true; rec(i, mi); rec(mi, j); }
    })(0, pts.length - 1);
    var out = []; keep.forEach(function (k, i) { if (k) out.push(i); });
    return out;
  }
  B.geo = { dist: dist, heading: heading, normDeg: normDeg, segDist: segDist };

  Router.prototype.m2u = function (floorId) { // metres -> svg units on that floor
    return 1 / ((this.D.floorById[floorId].unitScale || 1) * this.cfg.metersPerUnit);
  };

  // ---------------- plan: legs + steps ----------------
  Router.prototype.plan = function (srcNode, dstNode, opts) {
    opts = opts || {};
    var D = this.D, self = this, lang = B.lang;
    var p = this.path(srcNode, dstNode, !!opts.accessible);
    if (!p) return { ok: false };
    var N = D.nodeById;

    // 1. split into walking legs separated by transitions (consecutive transitions are merged: lift chains, through-escalators)
    var legs = [], cur = { floor: N[p.nodes[0]].floor, nodes: [p.nodes[0]] };
    for (var i = 1; i < p.nodes.length; i++) {
      var id = p.nodes[i], t = p.types[i];
      if (t === 'walk' && N[id].floor === cur.floor) { cur.nodes.push(id); continue; }
      var last = legs[legs.length - 1];
      if (cur.nodes.length === 1 && last && last.transition && sameKind(last.transition.type, t)) {
        last.transition.toNode = id; cur = { floor: N[id].floor, nodes: [id] }; continue;
      }
      cur.transition = { type: t, fromNode: p.nodes[i - 1], toNode: id };
      legs.push(cur); cur = { floor: N[id].floor, nodes: [id] };
    }
    legs.push(cur);

    var totalM = 0, secs = 0, cfg = this.cfg;
    var dstTenant = opts.tenant || null;
    legs.forEach(function (leg, li) {
      var f = D.floorById[leg.floor], k = (f.unitScale || 1) * cfg.metersPerUnit;
      leg.pts = leg.nodes.map(function (n) { return { x: N[n].x, y: N[n].y, node: n }; });
      leg.cum = [0];
      for (var j = 1; j < leg.pts.length; j++) leg.cum.push(leg.cum[j - 1] + dist(leg.pts[j - 1], leg.pts[j]) * k);
      leg.meters = leg.cum[leg.cum.length - 1];
      totalM += leg.meters;
      if (leg.transition) {
        var tr = leg.transition, fromF = D.floorById[N[tr.fromNode].floor], toF = D.floorById[N[tr.toNode].floor];
        tr.fromFloor = fromF.id; tr.toFloor = toF.id;
        tr.dir = toF.level > fromF.level ? 'up' : toF.level < fromF.level ? 'down' : 'same';
        tr.levels = Math.abs(toF.level - fromF.level);
        tr.amenity = D.amenityByNode[tr.fromNode] || null;
        if (tr.type === 'lift') secs += cfg.liftSecPerTrip;
        else if (tr.type.indexOf('escalator') === 0 || tr.type === 'stairs') secs += cfg.escalatorSecPerLevel * Math.max(1, tr.levels);
        tr.text = self.transitionText(tr, lang);
        tr.short = self.transitionShort(tr, lang);
      }
      leg.steps = self.buildSteps(leg, li, legs.length, dstTenant, lang);
    });
    secs += totalM / cfg.walkSpeedMps;
    return { ok: true, accessible: !!opts.accessible, legs: legs, meters: totalM, seconds: secs, cost: p.cost, tenant: dstTenant,
      srcNode: srcNode, dstNode: dstNode };
  };
  function sameKind(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.indexOf('escalator') === 0 && b.indexOf('escalator') === 0;
  }

  Router.prototype.transitionShort = function (tr, lang) {
    var toF = this.D.floorById[tr.toFloor], fl = B.floorLabel(toF);
    var id = lang !== 'en';
    if (tr.type === 'crossing') return id ? 'Jembatan → ' + fl : 'Bridge → ' + fl;
    if (tr.type === 'lift') return (id ? 'Lift → ' : 'Lift → ') + fl;
    return (id ? 'Eskalator → ' : 'Escalator → ') + fl;
  };

  Router.prototype.transitionText = function (tr, lang) {
    var toF = this.D.floorById[tr.toFloor], fl = B.floorLong(toF), id = lang !== 'en';
    var am = tr.amenity ? B.amenityName(tr.amenity) : '';
    var bank = am.replace(/ · .*$/, '');
    if (tr.type === 'crossing') return id ? 'Seberangi jembatan penghubung ke ' + fl : 'Cross the link bridge to ' + fl;
    if (tr.type === 'lift') return id ? (tr.dir === 'down' ? 'Turun' : 'Naik') + ' lift ke ' + fl : 'Take the lift ' + (tr.dir === 'down' ? 'down' : 'up') + ' to ' + fl;
    var verb = id ? (tr.dir === 'down' ? 'Turun' : 'Naik') : (tr.dir === 'down' ? 'Take' : 'Take');
    if (id) return verb + ' ' + (bank || 'eskalator') + ' ke ' + fl;
    return 'Take ' + (bank || 'the escalator') + ' ' + (tr.dir === 'down' ? 'down' : 'up') + ' to ' + fl;
  };

  Router.prototype.landmarkNear = function (floorId, pt, maxM, exclude) {
    var u = maxM * this.m2u(floorId), best = null, bd = Infinity;
    this.D.tenants.forEach(function (t) {
      if (t.floor !== floorId || (exclude && exclude[t.id])) return;
      var d = Math.hypot(t.x - pt.x, t.y - pt.y);
      if (d < u && d < bd) { bd = d; best = t; }
    });
    return best;
  };

  Router.prototype.landmarksAlong = function (floorId, pts, maxM, exclude) {
    var u = maxM * this.m2u(floorId), found = [];
    this.D.tenants.forEach(function (t) {
      if (t.floor !== floorId || (exclude && exclude[t.id])) return;
      var bd = Infinity, at = 0, total = 0, acc = 0;
      for (var i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
      for (i = 1; i < pts.length; i++) {
        var s = segDist(t, pts[i - 1], pts[i]), L = dist(pts[i - 1], pts[i]);
        if (s.d < bd) { bd = s.d; at = (acc + s.t * L) / (total || 1); }
        acc += L;
      }
      if (bd < u && at > 0.15 && at < 0.9) found.push({ t: t, d: bd, at: at });
    });
    found.sort(function (a, b) { return (b.t.logo ? 1 : 0) - (a.t.logo ? 1 : 0) || a.d - b.d; });
    return found.slice(0, 1).map(function (f) { return f.t; });
  };

  function roundM(m) { return m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5; }
  B.roundM = roundM;

  Router.prototype.buildSteps = function (leg, li, nLegs, dstTenant, lang) {
    var self = this, id = lang !== 'en', floorId = leg.floor;
    var m2u = this.m2u(floorId), pts = leg.pts, steps = [];
    if (pts.length < 2) {
      if (leg.transition) steps.push({ floor: floorId, pts: [pts[0], pts[0]], startM: 0, endM: 0, meters: 0, end: pts[0],
        text: leg.transition.text, kind: 'transition' });
      else steps.push({ floor: floorId, pts: [pts[0], pts[0]], startM: 0, endM: 0, meters: 0, end: pts[0], text: id ? 'Tujuan ada di sini' : 'Destination is here', kind: 'arrive' });
      return steps;
    }
    var keep = simplify(pts, 1.2 * m2u);
    // turn vertices among simplified points
    var turns = [0];
    for (var k = 1; k < keep.length - 1; k++) {
      var a = pts[keep[k - 1]], b = pts[keep[k]], c = pts[keep[k + 1]];
      var dIn = (leg.cum[keep[k]] - leg.cum[keep[k - 1]]), dOut = (leg.cum[keep[k + 1]] - leg.cum[keep[k]]);
      var ang = normDeg(heading(b, c) - heading(a, b));
      if ((Math.abs(ang) >= 35 && dIn >= 2.5 && dOut >= 2.5) || Math.abs(ang) >= 70) turns.push(keep[k]);
    }
    turns.push(pts.length - 1);
    // drop segments shorter than 2 m (merge into next)
    var t2 = [turns[0]];
    for (k = 1; k < turns.length; k++) {
      if (k < turns.length - 1 && leg.cum[turns[k]] - leg.cum[t2[t2.length - 1]] < 2) continue;
      t2.push(turns[k]);
    }
    turns = t2;
    var excl = {}; if (dstTenant) excl[dstTenant.id] = true;
    var usedLm = {};
    for (k = 1; k < turns.length; k++) {
      var i0 = turns[k - 1], i1 = turns[k], seg = pts.slice(i0, i1 + 1), meters = leg.cum[i1] - leg.cum[i0];
      var isLast = k === turns.length - 1, txt = '';
      var lmEx = Object.assign({}, excl, usedLm);
      var passing = this.landmarksAlong(floorId, seg, 7, lmEx);
      passing.forEach(function (t) { usedLm[t.id] = true; });
      var mtxt = (id ? '±' : '~') + roundM(meters) + '\u00A0m';
      if (k === 1 && li === 0) txt = id ? 'Dari titik “Anda di sini”, jalan ' + mtxt : 'From “You are here”, walk ' + mtxt;
      else if (k === 1) txt = id ? 'Setelah tiba, jalan ' + mtxt : 'After arriving, walk ' + mtxt;
      else txt = id ? 'Jalan lurus ' + mtxt : 'Go straight ' + mtxt;
      if (passing.length) txt += (id ? ' melewati ' : ' past ') + passing.map(function (t) { return t.brand || t.name; }).join(id ? ' dan ' : ' and ');
      var kind = 'walk', turnDir = 0;
      if (!isLast) {
        var a2 = pts[Math.max(i0, i1 - 1)], b2 = pts[i1], c2 = pts[Math.min(pts.length - 1, i1 + 1)];
        // use longer baselines for stable angles
        a2 = pts[i0]; c2 = pts[turns[k + 1]];
        var ang2 = normDeg(heading(a2, b2) - heading(b2, c2)) * -1;
        turnDir = ang2;
        var lm = this.landmarkNear(floorId, b2, 8, Object.assign({}, excl, usedLm));
        if (lm) usedLm[lm.id] = true;
        txt += ', ' + turnWord(ang2, id) + (lm ? (id ? ' dekat ' : ' near ') + (lm.brand || lm.name) : '');
        kind = 'turn';
      } else if (li < nLegs - 1 && leg.transition) {
        var am = leg.transition.amenity;
        var target = am ? B.amenityName(am).replace(/ · .*$/, '') : (leg.transition.type === 'crossing' ? (id ? 'jembatan' : 'the bridge') : 'lift');
        if (leg.transition.type === 'lift') target = id ? 'lift' : 'the lift';
        if (leg.transition.type === 'crossing') target = id ? 'jembatan penghubung' : 'the link bridge';
        txt += (id ? ' sampai ' : ' to ') + target;
        kind = 'to-transition';
      } else {
        txt += id ? '. ' + (dstTenant ? dstTenant.name : 'Tujuan') + ' ada di depan Anda' : '. ' + (dstTenant ? dstTenant.name : 'Destination') + ' is ahead of you';
        kind = 'arrive';
      }
      steps.push({ floor: floorId, pts: seg, startM: leg.cum[i0], endM: leg.cum[i1], meters: meters, end: pts[i1],
        text: txt, kind: kind, turn: turnDir, landmark: passing[0] || null });
    }
    if (leg.transition) {
      var last = pts[pts.length - 1];
      steps.push({ floor: floorId, pts: [last, last], startM: leg.meters, endM: leg.meters, meters: 0, end: last,
        text: leg.transition.text, kind: 'transition', transition: leg.transition });
    }
    return steps;
  };

  function turnWord(ang, id) {
    var a = Math.abs(ang), right = ang > 0;
    if (a >= 150) return id ? 'lalu putar balik' : 'then make a U-turn';
    if (a >= 60) return id ? (right ? 'lalu belok kanan' : 'lalu belok kiri') : (right ? 'then turn right' : 'then turn left');
    return id ? (right ? 'lalu serong kanan' : 'lalu serong kiri') : (right ? 'then bear right' : 'then bear left');
  }

  // point at distance m along leg polyline (metres) -> {x,y,seg}
  B.pointAtM = function (leg, m) {
    var c = leg.cum, p = leg.pts;
    if (m <= 0) return { x: p[0].x, y: p[0].y, i: 0 };
    for (var i = 1; i < c.length; i++) {
      if (c[i] >= m) {
        var t = (m - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
        return { x: p[i - 1].x + t * (p[i].x - p[i - 1].x), y: p[i - 1].y + t * (p[i].y - p[i - 1].y), i: i };
      }
    }
    var L = p[p.length - 1]; return { x: L.x, y: L.y, i: p.length - 1 };
  };

  B.Router = Router;
})(window.BSB);
