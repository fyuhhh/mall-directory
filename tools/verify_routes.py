#!/usr/bin/env python3
"""
verify_routes.py — Dijkstra from every kiosk to every tenant over data/directory.json.

Edge semantics (same as the UI must use):
  walk / lift / stairs / crossing  -> undirected
  escalator-up / escalator-down    -> directed, from edge[0] to edge[1]
Modes: default (everything) and --accessible (no escalators / stairs).

Usage: python3 tools/verify_routes.py [--accessible] [--samples N] [--json out.json]
"""
import json, os, sys, heapq
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = json.load(open(os.path.join(ROOT, 'data', 'directory.json'), encoding='utf-8'))
ACCESSIBLE = '--accessible' in sys.argv
NSAMPLES = int(sys.argv[sys.argv.index('--samples') + 1]) if '--samples' in sys.argv else 6

floors = {f['id']: f for f in D['floors']}
nodes = {n['id']: n for n in D['graph']['nodes']}
adj = defaultdict(list)
for e in D['graph']['edges']:
    a, b, c, t = e[0], e[1], e[2], e[3]
    if ACCESSIBLE and (t.startswith('escalator') or t == 'stairs'):
        continue
    adj[a].append((b, c, t))
    if not t.startswith('escalator'):
        adj[b].append((a, c, t))

# sanity checks on the contract
problems = []
ids = set(nodes)
for coll in ('tenants', 'kiosks', 'amenities'):
    for x in D[coll]:
        if x['node'] not in ids: problems.append(f'{coll} {x["id"]}: node {x["node"]} missing')
        if x['floor'] not in floors: problems.append(f'{coll} {x["id"]}: floor {x["floor"]} missing')
        vb = floors[x['floor']]['viewBox']
        if not (vb[0] <= x['x'] <= vb[0] + vb[2] and vb[1] <= x['y'] <= vb[1] + vb[3]):
            problems.append(f'{coll} {x["id"]}: point outside viewBox')
for e in D['graph']['edges']:
    if e[0] not in ids or e[1] not in ids: problems.append(f'edge {e} references missing node')
cats = {c['id'] for c in D['categories']}
for t in D['tenants']:
    if t['category'] not in cats: problems.append(f'tenant {t["id"]}: category {t["category"]!r}')
    if t['url'] and not t['url'].startswith('https://'): problems.append(f'tenant {t["id"]}: non-https url')
if len({t['id'] for t in D['tenants']}) != len(D['tenants']): problems.append('duplicate tenant ids')


def dijkstra(src):
    dist, prev = {src: 0.0}, {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]: continue
        for v, c, t in adj[u]:
            nd = d + c
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = (u, t); heapq.heappush(pq, (nd, v))
    return dist, prev


def path(prev, src, dst):
    out = [dst]
    while out[-1] != src:
        out.append(prev[out[-1]][0])
    return out[::-1]


def describe(prev, src, dst):
    p = path(prev, src, dst)
    steps, cur = [], nodes[p[0]]['floor']
    for i in range(1, len(p)):
        u, t = prev[p[i]]
        f = nodes[p[i]]['floor']
        if t != 'walk':
            steps.append(f'{t}: {floors[cur]["name"]} -> {floors[f]["name"]}')
        cur = f
    return p, steps


mode = 'ACCESSIBLE (lift / crossing only)' if ACCESSIBLE else 'DEFAULT'
print(f'== verify_routes  mode={mode}')
print(f'   floors={len(D["floors"])} tenants={len(D["tenants"])} kiosks={len(D["kiosks"])} '
      f'nodes={len(nodes)} edges={len(D["graph"]["edges"])}')
if problems:
    print('!! contract problems:'); [print('   ', p) for p in problems]
else:
    print('   contract checks OK (ids, floors, viewBox bounds, categories, https urls)')

results = {}
total_pairs = reach_pairs = 0
unreach_by_tenant = defaultdict(list)
for k in D['kiosks']:
    dist, prev = dijkstra(k['node'])
    results[k['id']] = (dist, prev)
    for t in D['tenants']:
        total_pairs += 1
        if t['node'] in dist: reach_pairs += 1
        else: unreach_by_tenant[t['id']].append(k['id'])

print(f'\n   reachable kiosk->tenant pairs: {reach_pairs}/{total_pairs} = {100*reach_pairs/total_pairs:.1f}%')
fully = [t for t in D['tenants'] if t['id'] not in unreach_by_tenant]
print(f'   tenants reachable from ALL kiosks: {len(fully)}/{len(D["tenants"])}')
if unreach_by_tenant:
    print('\n   UNREACHABLE (tenant <- kiosks that cannot reach it):')
    for tid, ks in sorted(unreach_by_tenant.items()):
        t = next(x for x in D['tenants'] if x['id'] == tid)
        print(f'    - {tid:38s} [{t["floor"]}] from {len(ks)}/{len(D["kiosks"])}: {", ".join(ks)}')

# reverse direction (tenant -> kiosk) matters for directed escalators
back_fail = 0
for t in D['tenants'][:]:
    dist, _ = dijkstra(t['node'])
    back_fail += sum(1 for k in D['kiosks'] if k['node'] not in dist)
print(f'\n   tenant->kiosk unreachable pairs (return trip): {back_fail}')

# samples with floor transitions
print('\n   SAMPLE ROUTES')
samples = []
for k in D['kiosks']:
    dist, prev = results[k['id']]
    ts = sorted((t for t in D['tenants'] if t['node'] in dist and t['floor'] != k['floor']), key=lambda t: -dist[t['node']])
    if ts: samples.append((k, ts[0])); samples.append((k, ts[len(ts)//2]))
for k, t in samples[:NSAMPLES * 2:2] + samples[1:NSAMPLES:2]:
    dist, prev = results[k['id']]
    p, steps = describe(prev, k['node'], t['node'])
    print(f'    {k["id"]} ({floors[k["floor"]]["short"]}) -> {t["name"]} ({floors[t["floor"]]["name"]}): '
          f'cost {dist[t["node"]]:.0f}, {len(p)} nodes')
    for s in steps: print(f'        · {s}')

if '--json' in sys.argv:
    out = sys.argv[sys.argv.index('--json') + 1]
    json.dump(dict(mode=mode, reachablePct=round(100*reach_pairs/total_pairs, 2), unreachable=unreach_by_tenant,
                   problems=problems), open(out, 'w'), indent=1)
sys.exit(1 if problems else 0)
