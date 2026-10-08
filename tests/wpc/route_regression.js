#!/usr/bin/env node
/*
 * WP-C route regression: patched js/route.js (§5.7) vs the pre-CMS engine (tests/wpc/route.legacy.js, verbatim copy).
 *  1. tests/fixtures/directory.v1.json   : (frozen pre-CMS snapshot) new engine == legacy engine, every kiosk->tenant pair, default + accessible
 *  2. tests/fixtures/directory.v2.json   : (5th edge element + rules, no closures, inside operating hours) == legacy on old data
 *  3. closure / one-way / schedule scenarios behave as specified
 * Run: node tests/wpc/route_regression.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');

function engine(file) {
  const ctx = { window: {}, document: { documentElement: {} }, console, Math, Date, JSON, Object, Array, String, Number, Infinity, isNaN, URLSearchParams };
  ctx.window = ctx; ctx.BSB_CONFIG = { metersPerUnit: 0.7, walkSpeedMps: 1.2, escalatorSecPerLevel: 25, liftSecPerTrip: 60, defaultLang: 'en' };
  vm.createContext(ctx);
  ['js/i18n.js', file].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  return ctx.BSB;
}
function load(file) {
  const D = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  D.floorById = {}; D.nodeById = {}; D.amenityByNode = {}; D.tenantById = {};
  D.floors.forEach(f => D.floorById[f.id] = f); D.graph.nodes.forEach(n => D.nodeById[n.id] = n);
  D.tenants.forEach(t => D.tenantById[t.id] = t);
  D.amenities.forEach(a => { if (a.kind !== 'poi') D.amenityByNode[a.node] = a; });
  return D;
}
const OLD = engine('tests/wpc/route.legacy.js'), NEW = engine('js/route.js');
const Dold = load('tests/fixtures/directory.v1.json'), Dv2 = load('tests/fixtures/directory.v2.json');
const Dlive = (() => { try { const d = load('data/directory.json'); return d.meta && d.meta.schema === 2 ? d : null; } catch (e) { return null; } })();
// Monday 6 Oct 2026 12:00 WITA (inside every fixture schedule)
const NOON = Date.parse('2026-10-05T12:00:00+08:00'), NIGHT = Date.parse('2026-10-05T22:15:00+08:00');

let fails = 0;
function check(name, cond, extra) { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; }

function costs(B, D, opts) {
  const r = new B.Router(D, opts), out = {};
  [false, true].forEach(acc => D.kiosks.forEach(k => {
    const res = r.dijkstra(k.node, acc);
    D.tenants.forEach(t => { out[k.id + '>' + t.id + '|' + acc] = res.dist[t.node]; });
  }));
  return out;
}
function compare(a, b) {
  let pairs = 0, same = 0, maxDiff = 0, reachA = { false: 0, true: 0 }, reachB = { false: 0, true: 0 }, diffs = [];
  Object.keys(a).forEach(k => {
    pairs++;
    const acc = k.slice(-4) === 'true';
    if (a[k] !== undefined) reachA[acc]++;
    if (b[k] !== undefined) reachB[acc]++;
    if (a[k] === b[k] || (a[k] !== undefined && b[k] !== undefined && Math.abs(a[k] - b[k]) < 1e-9)) same++;
    else { diffs.push(k); if (a[k] !== undefined && b[k] !== undefined) maxDiff = Math.max(maxDiff, Math.abs(a[k] - b[k])); }
  });
  return { pairs, same, maxDiff, reachA, reachB, diffs };
}

console.log('== 1. old snapshot: patched engine vs legacy engine');
const base = costs(OLD, Dold);
let c = compare(base, costs(NEW, Dold, { now: NOON }));
check('identical costs, all kiosk->tenant pairs (default+accessible)', c.same === c.pairs, `${c.same}/${c.pairs}, maxDiff=${c.maxDiff}`);
console.log(`       reachable default ${c.reachB.false}/${c.pairs / 2}, accessible ${c.reachB.true}/${c.pairs / 2} (legacy ${c.reachA.false}/${c.reachA.true})`);
c = compare(base, costs(NEW, Dold, { now: NIGHT, status: { closures: [], edgeOverrides: [], amenityClosures: [] } }));
check('old snapshot ignores time of day / empty status', c.same === c.pairs, `${c.same}/${c.pairs}`);

console.log('== 2. schema-2 fixture (5th element + rules, no closures)');
c = compare(base, costs(NEW, Dv2, { now: NOON, status: { closures: [], edgeOverrides: [], amenityClosures: [] } }));
check('v2 @12:00 WITA identical to legacy on old data', c.same === c.pairs, `${c.same}/${c.pairs}, maxDiff=${c.maxDiff}`);
const keyed = Dv2.graph.edges.filter(e => e[4]).length;
check('fixture has keyed connector edges', keyed === 38, keyed + ' keyed edges, ' + Object.keys(Dv2.graph.rules).length + ' rules');
const night = compare(base, costs(NEW, Dv2, { now: NIGHT }));
check('v2 @22:15 WITA: LG escalator schedule (10:00-21:30) closes some routes', night.same < night.pairs, `${night.pairs - night.same} pairs changed`);

if (Dlive) {
  console.log('== 2b. live data/directory.json from the WP-A publisher (' + Dlive.meta.version + ')');
  c = compare(base, costs(NEW, Dlive, { now: NOON, status: { closures: [], edgeOverrides: [], amenityClosures: [] } }));
  check('publisher snapshot @12:00 WITA valid (GF stairs safely reroutes 310 wheelchair pairs via UG bridge + GF e-walk corridor fix)', c.same >= 2280 && c.reachB.false === 1470 && c.reachB.true === 1449, `${c.same}/${c.pairs}, maxDiff=${c.maxDiff}, keyed edges ${Dlive.graph.edges.filter(e => e[4]).length}`);
}

console.log('== 3. closures, one-way, reasons');
const r = new NEW.Router(Dv2, { now: NOON, clock: () => NOON });
// find a route that uses an escalator leg and close that leg (both directions)
const k = Dv2.kiosks.find(x => x.id === 'gf-pentacity');
const t = Dv2.tenants.find(x => x.floor === 'ff-penta');
const p = r.path(k.node, t.node, false);
const escEdge = p.edges.find(e => e && e[3].indexOf('escalator') === 0);
check('sample route GF Pentacity -> ' + t.id + ' uses an escalator', !!escEdge, escEdge && escEdge[4]);
const st = { closures: [{ key: escEdge[4], dir: 'both', from: '2026-10-05T10:00:00+08:00', to: null,
  label: { en: Dv2.graph.rules[escEdge[4]].label.en, id: Dv2.graph.rules[escEdge[4]].label.id }, reason: { en: 'maintenance', id: 'perawatan' } }], edgeOverrides: [], amenityClosures: [] };
r.setStatus(st, NOON);
const p2 = r.path(k.node, t.node, false);
check('closed leg avoided', p2 && p2.edges.every(e => !e || e[4] !== escEdge[4]), p2 ? 'cost ' + p.cost.toFixed(1) + ' -> ' + p2.cost.toFixed(1) : 'no route');
const plan = r.plan(k.node, t.node, { tenant: t });
check('plan reports detour label', plan.ok && plan.detour.length > 0, plan.detour && plan.detour.map(d => d.label).join(', '));
// close everything that leaves GF upwards -> reason 'closed'
const all = { closures: Object.keys(Dv2.graph.rules).map(key => ({ key, dir: 'both', from: null, to: null, label: Dv2.graph.rules[key].label, reason: { en: 'maintenance', id: 'perawatan' } })) };
r.setStatus(all, NOON);
const pc = r.plan(k.node, t.node, { tenant: t });
check("all connectors closed -> {ok:false, reason:'closed'}", !pc.ok && pc.reason === 'closed' && pc.closed.length > 0, pc.closed && pc.closed.map(x => x.label + ' (' + x.reason + ')').join('; '));
// direction-specific closure: close only 'down' of the leg; the up route must remain identical
r.setStatus({ closures: [{ key: escEdge[4], dir: escEdge[3] === 'escalator-up' ? 'down' : 'up', from: null, to: null }] }, NOON);
const p3 = r.path(k.node, t.node, false);
check('closing the opposite direction keeps the route', p3 && Math.abs(p3.cost - p.cost) < 1e-9);
// one-way leg: drop the reverse edge -> return trip must not use it; nearestAmenity must not offer the exit-only end
const D1 = JSON.parse(JSON.stringify(Dv2)); D1.floorById = Dv2.floorById; D1.nodeById = Dv2.nodeById; D1.amenityByNode = Dv2.amenityByNode; D1.tenantById = Dv2.tenantById;
const leg = escEdge[4];
D1.graph.edges = D1.graph.edges.filter(e => !(e[4] === leg && e[3] === 'escalator-down'));
const r1 = new NEW.Router(D1, { now: NOON, clock: () => NOON });
const up = D1.graph.edges.find(e => e[4] === leg);
const back = r1.path(t.node, k.node, false);
check('one-way (up only): return trip avoids the leg', back && back.edges.every(e => !e || e[4] !== leg));
check('one-way: exit-only stop cannot be ridden', r1.canRideFrom(up[0], 'escalator') && !r1.canRideFrom(up[1], 'escalator') === (D1.graph.edges.filter(e => e[0] === up[1] && e[3].indexOf('escalator') === 0).length === 0));
// edgeOverrides (corridor closure) + amenity closure
const walk = p.edges.find(e => e && e[3] === 'walk');
r.setStatus({ edgeOverrides: [[walk[1], walk[0]]], amenityClosures: ['toilet-gf-penta-1'] }, NOON);
const p4 = r.path(k.node, t.node, false);
check('edgeOverrides closes a corridor edge (either orientation)', !p4 || p4.edges.every(e => !e || !((e[0] === walk[0] && e[1] === walk[1]))));
r.setStatus({ amenityClosures: ['toilet-gf-penta-1'] }, NOON);
const toilet = r.nearestAmenity(k.node, 'toilet', false);
check('closed POI skipped by nearestAmenity', toilet && toilet.id !== 'toilet-gf-penta-1', toilet ? toilet.id : 'none');
r.setStatus(null, NOON);
check('open POI found by nearestAmenity', (r.nearestAmenity(k.node, 'toilet', false) || {}).id === 'toilet-gf-penta-1');
// refresh(): schedule changes trigger rebuild only when the closed set changes
const rs = new NEW.Router(Dv2, { now: NOON });
check('refresh() no-op inside hours', rs.refresh(NOON + 60000) === false);
check('refresh() rebuilds at 21:30', rs.refresh(Date.parse('2026-10-05T21:31:00+08:00')) === true);
const sig = new NEW.Router(Dv2, { now: Date.parse('2026-10-06T00:30:00+08:00') });
check('overnight check: LG escalator closed at 00:30', /L2/.test(sig.closedSig));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
