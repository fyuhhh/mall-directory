<?php
declare(strict_types=1);

/** Graph editor API (§4.5 Graph): GET per lantai, batch ops transaksional, uji rute. */
final class GraphApi
{
    public static function register(Router $r): void
    {
        $r->get('/admin/graph', [self::class, 'get'], ['admin' => true]);
        $r->post('/admin/graph/ops', [self::class, 'ops'], ['admin' => true, 'perm' => ['graph.edit', 'tenants.place']]);
        $r->post('/admin/validate/route', [self::class, 'route'], ['admin' => true]);
    }

    public static function floorRow(string $id): array
    {
        $f = Db::one('SELECT f.*, m.path svg_path FROM floors f JOIN media m ON m.id=f.svg_media_id WHERE f.id=?', [$id]);
        if (!$f) throw ApiError::notFound('Lantai');
        return $f;
    }

    public static function get(): void
    {
        $fid = (string)Http::q('floor', '');
        $f = self::floorRow($fid);
        $floors = [];
        foreach (Db::all('SELECT * FROM floors') as $x) $floors[$x['id']] = $x;
        $nodes = Db::all('SELECT id, x, y, label FROM graph_nodes WHERE floor_id=? ORDER BY id', [$fid]);
        $byId = [];
        foreach ($nodes as $n) $byId[(int)$n['id']] = $n + ['floor_id' => $fid];
        $edges = Db::all('SELECT e.* FROM graph_edges e JOIN graph_nodes a ON a.id=e.node_a WHERE a.floor_id=? ORDER BY e.id', [$fid]);
        $closures = [];
        foreach (Db::all('SELECT id, edge_id, direction, starts_at, ends_at, reason_id FROM closures WHERE edge_id IS NOT NULL AND (ends_at IS NULL OR ends_at > NOW())') as $c)
            $closures[(int)$c['edge_id']][] = ['id' => (int)$c['id'], 'from' => Util::iso($c['starts_at']), 'to' => Util::iso($c['ends_at']), 'reasonId' => $c['reason_id']];
        $edgeDto = function ($e) use ($byId, $floors, $closures) {
            $a = $byId[(int)$e['node_a']] ?? null; $b = $byId[(int)$e['node_b']] ?? null;
            $auto = ($a && $b) ? Snapshot::walkCost($a, $b, $floors) : null;
            return ['id' => (int)$e['id'], 'a' => (int)$e['node_a'], 'b' => (int)$e['node_b'], 'enabled' => (bool)(int)$e['is_enabled'],
                'costOverride' => $e['cost_override'] === null ? null : (float)$e['cost_override'], 'cost' => $e['cost_override'] !== null ? (float)$e['cost_override'] : $auto,
                'autoCost' => $auto, 'scheduleId' => $e['schedule_id'] === null ? null : (int)$e['schedule_id'], 'label' => $e['label'], 'type' => $e['type'] ?? 'walk',
                'activeClosures' => $closures[(int)$e['id']] ?? []];
        };
        $tenants = Db::all("SELECT t.id, COALESCE(t.name_override, b.name) name, b.category_id, t.x, t.y, t.node_id, t.unit_shape_id, t.status, t.is_published FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE t.floor_id=? ORDER BY t.id", [$fid]);
        $kiosks = Db::all('SELECT id, name, x, y, node_id, facing_deg FROM kiosks WHERE floor_id=? ORDER BY id', [$fid]);
        $amen = Db::all('SELECT id, type_id, x, y, node_id FROM amenities WHERE floor_id=? ORDER BY id', [$fid]);
        $stops = Db::all('SELECT s.*, b.type bank_type, n.x, n.y FROM connector_stops s JOIN connector_banks b ON b.id=s.bank_id JOIN graph_nodes n ON n.id=s.node_id WHERE s.floor_id=? ORDER BY s.id', [$fid]);
        $legs = Snapshot::legsFull();
        $num = fn($v) => $v === null ? null : (float)$v;
        Http::ok([
            'revision' => Revisions::get('map'),
            'floor' => ['id' => $f['id'], 'level' => (int)$f['level'], 'building' => $f['building'], 'viewBox' => [(float)$f['vb_x'], (float)$f['vb_y'], (float)$f['vb_w'], (float)$f['vb_h']],
                'svgUrl' => $f['svg_path'], 'unitScale' => (float)$f['unit_scale']],
            'nodes' => array_map(fn($n) => ['id' => (int)$n['id'], 'x' => (float)$n['x'], 'y' => (float)$n['y'], 'label' => $n['label']], $nodes),
            'edges' => array_map($edgeDto, $edges),
            'attachments' => [
                'tenants' => array_map(fn($t) => ['id' => $t['id'], 'name' => $t['name'], 'x' => $num($t['x']), 'y' => $num($t['y']), 'nodeId' => $t['node_id'] === null ? null : (int)$t['node_id'],
                    'unitShapeId' => $t['unit_shape_id'], 'categoryId' => $t['category_id'], 'status' => $t['status'], 'isPublished' => (bool)(int)$t['is_published']], $tenants),
                'kiosks' => array_map(fn($k) => ['id' => $k['id'], 'name' => $k['name'], 'x' => (float)$k['x'], 'y' => (float)$k['y'], 'nodeId' => $k['node_id'] === null ? null : (int)$k['node_id'], 'facingDeg' => $k['facing_deg'] === null ? null : (int)$k['facing_deg']], $kiosks),
                'amenities' => array_map(fn($a) => ['id' => $a['id'], 'typeId' => $a['type_id'], 'x' => (float)$a['x'], 'y' => (float)$a['y'], 'nodeId' => $a['node_id'] === null ? null : (int)$a['node_id']], $amen),
                'stops' => array_map(function ($s) use ($legs) {
                    $L = [];
                    foreach ($legs as $l) {
                        if ((int)$l['lower_stop_id'] === (int)$s['id']) $L[] = ['id' => (int)$l['id'], 'toFloor' => $l['upper_floor'], 'direction' => $l['direction'], 'enabled' => (bool)(int)$l['is_enabled']];
                        elseif ((int)$l['upper_stop_id'] === (int)$s['id']) $L[] = ['id' => (int)$l['id'], 'toFloor' => $l['lower_floor'], 'direction' => $l['direction'], 'enabled' => (bool)(int)$l['is_enabled']];
                    }
                    return ['id' => (int)$s['id'], 'bankId' => $s['bank_id'], 'bankType' => $s['bank_type'], 'type' => $s['bank_type'], 'x' => (float)$s['x'], 'y' => (float)$s['y'], 'publicId' => $s['public_id'], 'nodeId' => (int)$s['node_id'], 'isServed' => (bool)(int)$s['is_served'], 'legs' => $L];
                }, $stops),
            ],
        ]);
    }

    // ================================================================= ops
    public static function ops(): void
    {
        $b = Http::body();
        $u = Auth::require();
        $full = Permissions::has($u['role'], 'graph.edit');
        $ops = $b['ops'] ?? null;
        if (!is_array($ops) || !$ops) throw ApiError::validation(['ops' => 'array']);
        if (count($ops) > 2000) throw ApiError::validation(['ops' => 'max_2000']);
        if (!array_key_exists('revision', $b)) throw ApiError::validation(['revision' => 'required']);
        $spurTenant = null;
        if (!$full) {
            foreach ($ops as $o) {
                if (!in_array($o['op'] ?? '', ['addNode', 'splitEdge', 'addEdge', 'attach'], true)) throw ApiError::forbidden('Izin tenants.place hanya boleh addNode/splitEdge/addEdge/attach tenant');
                if (($o['op'] ?? '') === 'attach') { if (($o['entity'] ?? '') !== 'tenant') throw ApiError::forbidden('Hanya attach tenant'); $spurTenant = (string)$o['id']; }
            }
            if ($spurTenant === null) throw ApiError::forbidden('Batch penempatan harus berisi attach tenant');
        }
        $res = Db::tx(function () use ($b, $ops, $spurTenant) {
            $cur = (int)Db::val("SELECT rev FROM revisions WHERE scope='map' FOR UPDATE");
            if ((int)$b['revision'] !== $cur) throw ApiError::conflict('Graph sudah diubah pengguna lain — muat ulang', ['currentRevision' => $cur]);
            $idMap = []; $summary = []; $touchContent = false;
            $floors = [];
            foreach (Db::all('SELECT * FROM floors') as $f) $floors[$f['id']] = $f;
            $ref = function ($v, string $field) use (&$idMap): int {
                if (is_string($v) && isset($idMap[$v])) return (int)$idMap[$v];
                if (is_string($v) && preg_match('/^n?(\d+)$/', $v, $m)) return (int)$m[1];
                if (is_int($v) || (is_numeric($v) && (int)$v == $v)) return (int)$v;
                throw ApiError::validation([$field => 'unknown_ref:' . json_encode($v)]);
            };
            $node = function (int $id, string $field) {
                $n = Db::one('SELECT * FROM graph_nodes WHERE id=?', [$id]);
                if (!$n) throw ApiError::validation([$field => 'node_not_found:' . $id]);
                return $n;
            };
            $inBox = function (string $fid, $x, $y, string $field) use ($floors) {
                $f = $floors[$fid] ?? null;
                if (!$f) throw ApiError::validation([$field => 'floor_not_found']);
                if (!is_numeric($x) || !is_numeric($y)) throw ApiError::validation([$field => 'x_y_number']);
                if ($x < $f['vb_x'] || $y < $f['vb_y'] || $x > $f['vb_x'] + $f['vb_w'] || $y > $f['vb_y'] + $f['vb_h']) throw ApiError::validation([$field => 'outside_viewbox']);
            };
            $spurLabel = $spurTenant !== null ? 'spur:' . $spurTenant : null;
            $addEdge = function (int $a, int $c, array $attr = []) use ($node) {
                if ($a === $c) throw ApiError::validation(['ops' => 'self_loop']);
                $na = $node($a, 'a'); $nb = $node($c, 'b');
                if ($na['floor_id'] !== $nb['floor_id']) throw ApiError::validation(['ops' => 'E_EDGE_FLOOR: edge walk lintas lantai dilarang (pakai konektor)']);
                [$x, $y] = $a < $c ? [$a, $c] : [$c, $a];
                $ex = Db::val('SELECT id FROM graph_edges WHERE node_a=? AND node_b=?', [$x, $y]);
                if ($ex) return (int)$ex;
                return Db::insert('graph_edges', ['node_a' => $x, 'node_b' => $y, 'type' => ($attr['type'] ?? 'walk') === 'stairs' ? 'stairs' : 'walk', 'is_enabled' => $attr['is_enabled'] ?? 1,
                    'cost_override' => $attr['cost_override'] ?? null, 'schedule_id' => $attr['schedule_id'] ?? null, 'label' => $attr['label'] ?? null]);
            };
            foreach ($ops as $i => $o) {
                $op = (string)($o['op'] ?? '');
                $F = "ops.$i";
                switch ($op) {
                    case 'addNode':
                        $fid = (string)($o['floor'] ?? '');
                        $inBox($fid, $o['x'] ?? null, $o['y'] ?? null, $F);
                        $label = $spurLabel ?? (isset($o['label']) && $o['label'] !== '' ? mb_substr((string)$o['label'], 0, 80) : null);
                        $id = Db::insert('graph_nodes', ['floor_id' => $fid, 'x' => round((float)$o['x'], 2), 'y' => round((float)$o['y'], 2), 'label' => $label]);
                        if (isset($o['tmp'])) $idMap[(string)$o['tmp']] = $id;
                        $summary[] = "addNode n$id";
                        break;
                    case 'moveNode':
                        $id = $ref($o['id'] ?? null, $F); $n = $node($id, $F);
                        $inBox($n['floor_id'], $o['x'] ?? null, $o['y'] ?? null, $F);
                        Db::update('graph_nodes', ['x' => round((float)$o['x'], 2), 'y' => round((float)$o['y'], 2)], ['id' => $id]);
                        $summary[] = "moveNode n$id";
                        break;
                    case 'updateNode':
                        $id = $ref($o['id'] ?? null, $F); $node($id, $F);
                        Db::update('graph_nodes', ['label' => isset($o['label']) && $o['label'] !== '' ? mb_substr((string)$o['label'], 0, 80) : null], ['id' => $id]);
                        $summary[] = "updateNode n$id";
                        break;
                    case 'splitEdge':
                        $eid = $ref($o['edge'] ?? null, $F);
                        $e = Db::one('SELECT * FROM graph_edges WHERE id=?', [$eid]);
                        if (!$e) throw ApiError::validation([$F => 'edge_not_found']);
                        $na = $node((int)$e['node_a'], $F);
                        $inBox($na['floor_id'], $o['x'] ?? null, $o['y'] ?? null, $F);
                        $nid = Db::insert('graph_nodes', ['floor_id' => $na['floor_id'], 'x' => round((float)$o['x'], 2), 'y' => round((float)$o['y'], 2), 'label' => $spurLabel]);
                        Db::exec('DELETE FROM graph_edges WHERE id=?', [$eid]);
                        $attr = ['is_enabled' => (int)$e['is_enabled'], 'schedule_id' => $e['schedule_id'], 'label' => $e['label'], 'type' => $e['type']];
                        $e1 = $addEdge((int)$e['node_a'], $nid, $attr); $e2 = $addEdge($nid, (int)$e['node_b'], $attr);
                        if (isset($o['tmp'])) { $idMap[(string)$o['tmp']] = $nid; $idMap[$o['tmp'] . '.e1'] = $e1; $idMap[$o['tmp'] . '.e2'] = $e2; }
                        $summary[] = "splitEdge e$eid → n$nid (e$e1,e$e2)";
                        break;
                    case 'addEdge':
                        $a = $ref($o['a'] ?? null, $F); $c = $ref($o['b'] ?? null, $F);
                        $attr = ['is_enabled' => isset($o['enabled']) ? (Util::bool($o['enabled']) ? 1 : 0) : 1,
                            'cost_override' => isset($o['costOverride']) && $o['costOverride'] !== null ? round((float)$o['costOverride'], 2) : null,
                            'schedule_id' => isset($o['scheduleId']) && $o['scheduleId'] !== null ? (int)$o['scheduleId'] : null,
                            'label' => isset($o['label']) && $o['label'] !== '' ? mb_substr((string)$o['label'], 0, 80) : null,
                            'type' => ($o['type'] ?? 'walk') === 'stairs' ? 'stairs' : 'walk'];
                        $id = $addEdge($a, $c, $attr);
                        if (isset($o['tmp'])) $idMap[(string)$o['tmp']] = $id;
                        $summary[] = "addEdge e$id n$a-n$c";
                        break;
                    case 'updateEdge':
                        $id = $ref($o['id'] ?? null, $F);
                        if (!Db::val('SELECT id FROM graph_edges WHERE id=?', [$id])) throw ApiError::validation([$F => 'edge_not_found']);
                        $row = [];
                        if (array_key_exists('enabled', $o)) $row['is_enabled'] = Util::bool($o['enabled']) ? 1 : 0;
                        if (array_key_exists('costOverride', $o)) { if ($o['costOverride'] !== null && (!is_numeric($o['costOverride']) || $o['costOverride'] < 0)) throw ApiError::validation([$F => 'costOverride>=0']); $row['cost_override'] = $o['costOverride'] === null ? null : round((float)$o['costOverride'], 2); }
                        if (array_key_exists('scheduleId', $o)) { if ($o['scheduleId'] !== null && !Db::val('SELECT id FROM schedules WHERE id=?', [(int)$o['scheduleId']])) throw ApiError::validation([$F => 'schedule_not_found']); $row['schedule_id'] = $o['scheduleId'] === null ? null : (int)$o['scheduleId']; }
                        if (array_key_exists('label', $o)) $row['label'] = $o['label'] === null || $o['label'] === '' ? null : mb_substr((string)$o['label'], 0, 80);
                        if (array_key_exists('type', $o)) { if (!in_array($o['type'], ['walk', 'stairs'], true)) throw ApiError::validation([$F => 'type_walk|stairs']); $row['type'] = $o['type']; }
                        if ($row) Db::update('graph_edges', $row, ['id' => $id]);
                        $summary[] = "updateEdge e$id " . implode(',', array_keys($row));
                        break;
                    case 'deleteEdge':
                        $id = $ref($o['id'] ?? null, $F);
                        if (!Db::exec('DELETE FROM graph_edges WHERE id=?', [$id])) throw ApiError::validation([$F => 'edge_not_found']);
                        $summary[] = "deleteEdge e$id";
                        break;
                    case 'deleteNode':
                        $id = $ref($o['id'] ?? null, $F); $node($id, $F);
                        $refs = self::nodeRefs($id);
                        if ($refs['stops']) throw ApiError::conflict("Node n$id adalah stop konektor — hapus lewat modul konektor", ['refs' => $refs]);
                        if (array_filter($refs) && empty($o['force'])) throw ApiError::conflict("Node n$id masih dipakai", ['refs' => $refs]);
                        foreach (['tenants', 'kiosks', 'amenities', 'events'] as $t) Db::exec("UPDATE $t SET node_id=NULL WHERE node_id=?", [$id]);
                        if ($refs['tenants']) $touchContent = true;
                        Db::exec('DELETE FROM graph_nodes WHERE id=?', [$id]);
                        $summary[] = "deleteNode n$id" . (array_filter($refs) ? ' (force: ' . json_encode($refs) . ')' : '');
                        break;
                    case 'mergeNodes':
                        $keep = $ref($o['keep'] ?? null, $F); $rem = $ref($o['remove'] ?? null, $F);
                        if ($keep === $rem) throw ApiError::validation([$F => 'same_node']);
                        $nk = $node($keep, $F); $nr = $node($rem, $F);
                        if ($nk['floor_id'] !== $nr['floor_id']) throw ApiError::validation([$F => 'different_floor']);
                        foreach (Db::all('SELECT * FROM graph_edges WHERE node_a=? OR node_b=?', [$rem, $rem]) as $e) {
                            $other = (int)$e['node_a'] === $rem ? (int)$e['node_b'] : (int)$e['node_a'];
                            Db::exec('DELETE FROM graph_edges WHERE id=?', [$e['id']]);
                            if ($other !== $keep) $addEdge($keep, $other, ['is_enabled' => (int)$e['is_enabled'], 'cost_override' => null, 'schedule_id' => $e['schedule_id'], 'label' => $e['label'], 'type' => $e['type']]);
                        }
                        foreach (['tenants', 'kiosks', 'amenities', 'events'] as $t) Db::exec("UPDATE $t SET node_id=? WHERE node_id=?", [$keep, $rem]);
                        if (Db::val('SELECT COUNT(*) FROM connector_stops WHERE node_id=?', [$rem])) {
                            if (Db::val('SELECT COUNT(*) FROM connector_stops s1 JOIN connector_stops s2 ON s1.bank_id=s2.bank_id WHERE s1.node_id=? AND s2.node_id=?', [$rem, $keep])) throw ApiError::conflict('Kedua node adalah stop bank yang sama');
                            Db::exec('UPDATE connector_stops SET node_id=? WHERE node_id=?', [$keep, $rem]);
                        }
                        Db::exec('DELETE FROM graph_nodes WHERE id=?', [$rem]);
                        $touchContent = true;
                        $summary[] = "mergeNodes n$rem → n$keep";
                        break;
                    case 'attach':
                        $ent = (string)($o['entity'] ?? ''); $eid = (string)($o['id'] ?? '');
                        $nid = $ref($o['node'] ?? null, $F); $n = $node($nid, $F);
                        $tbl = ['tenant' => 'tenants', 'kiosk' => 'kiosks', 'amenity' => 'amenities'][$ent] ?? null;
                        if (!$tbl) throw ApiError::validation([$F => 'entity_tenant|kiosk|amenity']);
                        $row = Db::one("SELECT id, floor_id FROM $tbl WHERE id=?", [$eid]);
                        if (!$row) throw ApiError::validation([$F => $ent . '_not_found']);
                        if ($row['floor_id'] !== $n['floor_id']) throw ApiError::validation([$F => 'E_NODE_FLOOR: node di lantai ' . $n['floor_id']]);
                        if ($ent === 'amenity' && Db::val('SELECT id FROM connector_stops WHERE node_id=?', [$nid])) throw ApiError::validation([$F => 'W_POI_NODE']);
                        Db::exec("UPDATE $tbl SET node_id=? WHERE id=?", [$nid, $eid]);
                        if ($ent === 'tenant') $touchContent = true;
                        $summary[] = "attach $ent $eid → n$nid";
                        break;
                    default:
                        throw ApiError::validation([$F => 'unknown_op:' . $op]);
                }
            }
            $rev = Revisions::bump('map');
            if ($touchContent) Revisions::bump('content');
            Audit::log('graph_ops', 'graph', null, count($ops) . ' op: ' . mb_substr(implode('; ', $summary), 0, 200), null, ['ops' => $summary]);
            return ['revision' => $rev, 'idMap' => (object)$idMap];
        });
        Http::ok($res);
    }

    public static function nodeRefs(int $id): array
    {
        return [
            'tenants' => Db::col('SELECT id FROM tenants WHERE node_id=?', [$id]),
            'kiosks' => Db::col('SELECT id FROM kiosks WHERE node_id=?', [$id]),
            'amenities' => Db::col('SELECT id FROM amenities WHERE node_id=?', [$id]),
            'events' => array_map('strval', Db::col('SELECT id FROM events WHERE node_id=?', [$id])),
            'stops' => Db::col('SELECT public_id FROM connector_stops WHERE node_id=?', [$id]),
        ];
    }

    /**
     * Node pintu di ujung spur (tenant/fasilitas/kiosk/"spur:" berderajat ≤ 1): koridor tidak boleh disambung lewat situ,
     * kalau tidak rute ke tempat lain menembus toko itu.
     */
    public static function doorLeaves(string $floorId): array
    {
        $deg = [];
        foreach (Db::all('SELECT e.node_a, e.node_b FROM graph_edges e JOIN graph_nodes a ON a.id=e.node_a WHERE a.floor_id=?', [$floorId]) as $e) {
            $deg[(int)$e['node_a']] = ($deg[(int)$e['node_a']] ?? 0) + 1; $deg[(int)$e['node_b']] = ($deg[(int)$e['node_b']] ?? 0) + 1;
        }
        $out = [];
        foreach (Db::col("SELECT node_id FROM tenants WHERE floor_id=? AND node_id IS NOT NULL UNION SELECT node_id FROM amenities WHERE floor_id=? AND node_id IS NOT NULL
            UNION SELECT node_id FROM kiosks WHERE floor_id=? AND node_id IS NOT NULL UNION SELECT id FROM graph_nodes WHERE floor_id=? AND label LIKE 'spur:%'", [$floorId, $floorId, $floorId, $floorId]) as $id)
            if (($deg[(int)$id] ?? 0) <= 1) $out[(int)$id] = true;
        return $out;
    }

    /** Hubungkan node baru ke koridor terdekat (proyeksi ke edge walk; spur bila > 3 unit). Return node id baru.
     *  $corridorOnly: abaikan spur ke pintu tenant/fasilitas lain (doorLeaves). */
    public static function snapToCorridor(string $floorId, float $x, float $y, ?string $label = null, bool $corridorOnly = false): int
    {
        $skip = $corridorOnly ? self::doorLeaves($floorId) : [];
        $new = Db::insert('graph_nodes', ['floor_id' => $floorId, 'x' => round($x, 2), 'y' => round($y, 2), 'label' => $label]);
        self::connectNode($new, $floorId, $x, $y, $label, $skip);
        return $new;
    }

    /** Sambungkan node yang sudah ada ke edge walk terdekat yang tidak menyentuh $skip (split edge, atau spur bila jauh). */
    public static function connectNode(int $new, string $floorId, float $x, float $y, ?string $label = null, array $skip = []): void
    {
        $best = null;
        $rows = Db::all('SELECT e.id, e.node_a, e.node_b, a.x ax, a.y ay, b.x bx, b.y by_, e.is_enabled, e.schedule_id, e.label, e.type FROM graph_edges e
            JOIN graph_nodes a ON a.id=e.node_a JOIN graph_nodes b ON b.id=e.node_b WHERE a.floor_id=? AND e.is_enabled=1', [$floorId]);
        foreach ($rows as $r) {
            if ((int)$r['node_a'] === $new || (int)$r['node_b'] === $new || isset($skip[(int)$r['node_a']]) || isset($skip[(int)$r['node_b']])) continue;
            $dx = $r['bx'] - $r['ax']; $dy = $r['by_'] - $r['ay']; $L = $dx * $dx + $dy * $dy;
            $t = $L > 0 ? max(0, min(1, (($x - $r['ax']) * $dx + ($y - $r['ay']) * $dy) / $L)) : 0;
            $px = $r['ax'] + $t * $dx; $py = $r['ay'] + $t * $dy;
            $d = hypot($x - $px, $y - $py);
            if ($best === null || $d < $best['d']) $best = ['d' => $d, 't' => $t, 'px' => $px, 'py' => $py, 'e' => $r];
        }
        if (!$best) return;
        $e = $best['e'];
        // titik proyeksi: ujung edge bila t≈0/1, selain itu split edge
        if ($best['t'] < 0.02) $proj = (int)$e['node_a'];
        elseif ($best['t'] > 0.98) $proj = (int)$e['node_b'];
        else {
            if ($best['d'] <= 3) { // node baru langsung di koridor: split edge di node baru
                Db::exec('DELETE FROM graph_edges WHERE id=?', [$e['id']]);
                foreach ([(int)$e['node_a'], (int)$e['node_b']] as $o) { [$p, $q] = $o < $new ? [$o, $new] : [$new, $o];
                    Db::insert('graph_edges', ['node_a' => $p, 'node_b' => $q, 'type' => $e['type'], 'is_enabled' => 1, 'schedule_id' => $e['schedule_id'], 'label' => $e['label']]); }
                return;
            }
            $proj = Db::insert('graph_nodes', ['floor_id' => $floorId, 'x' => round($best['px'], 2), 'y' => round($best['py'], 2), 'label' => $label]);
            Db::exec('DELETE FROM graph_edges WHERE id=?', [$e['id']]);
            foreach ([(int)$e['node_a'], (int)$e['node_b']] as $o) { [$p, $q] = $o < $proj ? [$o, $proj] : [$proj, $o];
                Db::insert('graph_edges', ['node_a' => $p, 'node_b' => $q, 'type' => $e['type'], 'is_enabled' => 1, 'schedule_id' => $e['schedule_id'], 'label' => $e['label']]); }
        }
        if ($proj !== $new) { [$p, $q] = $proj < $new ? [$proj, $new] : [$new, $proj]; Db::insert('graph_edges', ['node_a' => $p, 'node_b' => $q, 'is_enabled' => 1]); }
    }

    // ================================================================= uji rute
    public static function route(): void
    {
        $b = Http::body();
        [$D] = Snapshot::directory();
        $resolve = function ($v) use ($D) {
            if (is_array($v)) {
                $t = (string)($v['type'] ?? ''); $id = (string)($v['id'] ?? '');
                foreach (['tenant' => 'tenants', 'kiosk' => 'kiosks', 'amenity' => 'amenities'] as $k => $coll) if ($t === $k) foreach ($D[$coll] as $x) if ($x['id'] === $id) return $x['node'];
                return null;
            }
            if (is_numeric($v)) return 'n' . (int)$v;
            if (is_string($v) && preg_match('/^n\d+$/', $v)) return $v;
            return null;
        };
        $from = $resolve($b['from'] ?? null); $to = $resolve($b['to'] ?? null);
        if (!$from || !$to) throw ApiError::validation(['from' => 'node id | {type:tenant|kiosk|amenity,id}']);
        $acc = Util::bool($b['accessible'] ?? false);
        $filter = !empty($b['now']) ? RouteCheck::openFilter($D, Publisher::liveJson('status'), time()) : null;
        $adj = RouteCheck::adjacency($D, $acc, $filter);
        [$dist, $prev] = RouteCheck::dijkstra($adj, $from, true);
        if (!isset($dist[$to])) { Http::ok(['ok' => false, 'reason' => 'noroute', 'from' => $from, 'to' => $to, 'accessible' => $acc]); return; }
        $p = RouteCheck::path($prev, $from, $to);
        $nodeFloor = []; $nodeById = [];
        foreach ($D['graph']['nodes'] as $n) { $nodeFloor[$n['id']] = $n['floor']; $nodeById[$n['id']] = $n; }
        $trans = [];
        foreach ($p['types'] as $i => $t) if ($t !== 'walk') $trans[] = ['type' => $t, 'from' => $p['nodes'][$i], 'to' => $p['nodes'][$i + 1], 'fromFloor' => $nodeFloor[$p['nodes'][$i]], 'toFloor' => $nodeFloor[$p['nodes'][$i + 1]]];
        $path = array_map(fn($id) => ['id' => (int)substr($id, 1), 'floor' => $nodeById[$id]['floor'], 'x' => $nodeById[$id]['x'], 'y' => $nodeById[$id]['y']], $p['nodes']);
        Http::ok(['ok' => true, 'cost' => round($dist[$to], 2), 'path' => $path, 'nodes' => $p['nodes'], 'types' => $p['types'], 'transitions' => $trans, 'accessible' => $acc]);
    }
}
