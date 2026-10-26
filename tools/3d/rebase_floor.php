<?php
/*
 * Pindahkan data CMS satu lantai ke koordinat gambar Illustrator-nya (docs/3D.md, "frame": "plan").
 *
 *   php tools/3d/rebase_floor.php --floor lg-ewalk                    uji coba: laporan + --check gambar periksa
 *   php tools/3d/rebase_floor.php --floor lg-ewalk --apply            terapkan
 *   php tools/3d/rebase_floor.php --floor lg-ewalk --plan-only --apply   lantai yang sudah "plan": perbarui denah saja
 *   php tools/3d/rebase_floor.php --floor lg-ewalk --focus --apply        lantai "plan": hitung ulang kotak fokus kamera
 *   php tools/3d/rebase_floor.php --floor lg-ewalk --tidy [--apply]       lantai "plan": rapikan jalur terhadap gambar —
 *        node ujung (pintu) yang ada di dalam bangunan toko pindah ke dinding depannya (+0,3 m), node koridor yang masuk /
 *        terlalu dekat (< 1,2 m) ke bangunan digeser ke koridor. Node "spur:" buatan CMS sudah di pintu, tidak diubah.
 *   --check /path/periksa.svg   denah + jalur/pin yang sudah dipindah, untuk dicek mata sebelum --apply
 *
 * Yang dipindah (titik lama → meter lewat "toMetres" registry dari register_floor.py → satuan artboard; lantai gabungan
 * dari merge_floor.py: lewat "toMetres" gedungnya masing-masing ("parts"), dicampur halus di antara kedua gedung):
 * node graph, pin tenant, fasilitas, kiosk (+ arah hadap), event, kotak fokus. Lantai mendapat denah tampak atas dari
 * model 3D sebagai SVG, viewBox = artboard, dan unit_scale baru yang menjaga total biaya jalan kaki lantai itu
 * (rute antar-lantai tetap seimbang). Tautan unit→tenant di registry menjadi unit_shape_id tenant CMS.
 * Semua perubahan DB dalam satu transaksi; registry ditulis sesudahnya.
 */
declare(strict_types=1);
require __DIR__ . '/../../lib/bootstrap.php';

$o = getopt('', ['floor:', 'apply', 'plan-only', 'focus', 'tidy', 'check:']);
$fid = (string)($o['floor'] ?? '');
$apply = isset($o['apply']);
if ($fid === '') { fwrite(STDERR, "usage: php tools/3d/rebase_floor.php --floor <id> [--apply] [--plan-only] [--check out.svg]\n"); exit(2); }
$reg = Map3d::registry();
$e = $reg['floors'][$fid] ?? null;
if (!$e) { fwrite(STDERR, "Lantai $fid tidak ada di " . Map3d::REGISTRY . "\n"); exit(1); }
$m = Map3d::model($e);
if (!$m) { fwrite(STDERR, "Model {$e['model']} tidak bisa dibaca\n"); exit(1); }
if (empty($m['artboard'])) { fwrite(STDERR, "Model tanpa \"artboard\": konversi ulang lantainya dengan konverter terbaru\n"); exit(1); }
$floor = Db::one('SELECT * FROM floors WHERE id=?', [$fid]);
if (!$floor) { fwrite(STDERR, "Lantai $fid tidak ada di DB\n"); exit(1); }

// camera focus of a one-building floor: where the corridors, shops and facilities are (+12 %), not the whole outline;
// a floor with few of those (one big anchor, a handful of nodes) is framed by its named shops' walls too
$contentBox = function (array $pts, array $vb): array {
    $xs = array_column($pts, 0); $ys = array_column($pts, 1);
    $pad = max(max($xs) - min($xs), max($ys) - min($ys)) * 0.12;
    $x0 = max($vb[0], min($xs) - $pad); $y0 = max($vb[1], min($ys) - $pad);
    $x1 = min($vb[0] + $vb[2], max($xs) + $pad); $y1 = min($vb[1] + $vb[3], max($ys) + $pad);
    return [round($x0, 2), round($y0, 2), round($x1 - $x0, 2), round($y1 - $y0, 2)];
};
$facPts = fn() => array_map(fn($f) => Map3d::planPoint($m, (float)$f['x'], (float)$f['y']), $m['facilities'] ?? []);
$wallPts = fn(?string $building = null) => array_merge([], ...array_map(fn($u) => array_map(fn($q) => Map3d::planPoint($m, (float)$q[0], (float)$q[1]), $u['poly']),
    array_values(array_filter($m['units'], fn($u) => !empty($u['name']) && !empty($u['poly']) && ($building === null || ($u['building'] ?? null) === $building)))));
const FEW_POINTS = 20;

if (isset($o['tidy'])) {
    if (!Map3d::isPlan($e)) { fwrite(STDERR, "$fid belum \"plan\"\n"); exit(1); }
    $mpu = (float)$m['m_per_unit']; $clear = 1.2 / $mpu; $door = 0.3 / $mpu; // plan units
    $deg = [];
    foreach (Db::all('SELECT e.node_a, e.node_b FROM graph_edges e JOIN graph_nodes a ON a.id=e.node_a WHERE a.floor_id=?', [$fid]) as $ed) {
        $deg[(int)$ed['node_a']] = ($deg[(int)$ed['node_a']] ?? 0) + 1; $deg[(int)$ed['node_b']] = ($deg[(int)$ed['node_b']] ?? 0) + 1; }
    $polys = [];
    foreach ($m['units'] as $u) if (!empty($u['poly']) && count($u['poly']) >= 3) $polys[] = array_map(fn($q) => Map3d::planPoint($m, (float)$q[0], (float)$q[1]), $u['poly']);
    $inside = function (array $p, array $poly): bool {
        $in = false; $n = count($poly);
        for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) { [$xi, $yi] = $poly[$i]; [$xj, $yj] = $poly[$j];
            if ((($yi > $p[1]) !== ($yj > $p[1])) && ($p[0] < ($xj - $xi) * ($p[1] - $yi) / (($yj - $yi) ?: 1e-9) + $xi)) $in = !$in; }
        return $in;
    };
    $nearest = function (array $p) use ($polys, $inside): array { // [distance to the closest wall, closest point, inside some unit]
        $best = [INF, null, false];
        foreach ($polys as $poly) {
            $n = count($poly);
            for ($i = 0; $i < $n; $i++) { [$ax, $ay] = $poly[$i]; [$bx, $by] = $poly[($i + 1) % $n];
                $dx = $bx - $ax; $dy = $by - $ay; $L = $dx * $dx + $dy * $dy ?: 1e-9;
                $t = max(0.0, min(1.0, (($p[0] - $ax) * $dx + ($p[1] - $ay) * $dy) / $L));
                $q = [$ax + $t * $dx, $ay + $t * $dy]; $d = hypot($p[0] - $q[0], $p[1] - $q[1]);
                if ($d < $best[0]) $best = [$d, $q, false]; }
        }
        foreach ($polys as $poly) if ($inside($p, $poly)) { $best[2] = true; break; }
        return $best;
    };
    $moves = [];
    foreach (Db::all('SELECT id, x, y, label FROM graph_nodes WHERE floor_id=?', [$fid]) as $n) {
        if (str_starts_with((string)$n['label'], 'spur:')) continue;
        $p = [(float)$n['x'], (float)$n['y']];
        $leaf = ($deg[(int)$n['id']] ?? 0) <= 1; // a door at the end of a spur
        [$d, $q, $in] = $nearest($p);
        $want = $leaf ? $door : $clear;
        if ($q === null || ($leaf && !$in) || (!$in && $d >= $want)) continue;
        $vx = $p[0] - $q[0]; $vy = $p[1] - $q[1]; $l = hypot($vx, $vy);
        if ($l < 1e-6) continue;
        if ($in) { $vx = -$vx; $vy = -$vy; }
        $np = [$q[0] + $vx / $l * $want, $q[1] + $vy / $l * $want];
        [$d2, , $in2] = $nearest($np);
        if ($in2 || $d2 < $want * 0.75) continue; // no room there (narrow passage): leave it
        $moves[(int)$n['id']] = [$p, $np, round(hypot($np[0] - $p[0], $np[1] - $p[1]) * $mpu, 2), $leaf ? 'pintu' : 'koridor'];
    }
    foreach ($moves as $id => [$a, $b, $mtr, $kind]) printf("  n%-5d %-8s (%7.1f,%6.1f) → (%7.1f,%6.1f)  %.2f m\n", $id, $kind, $a[0], $a[1], $b[0], $b[1], $mtr);
    echo count($moves) . " node dirapikan terhadap bangunan toko.\n";
    if (!$apply || !$moves) { if ($moves) echo "Tambah --apply untuk menyimpan.\n"; exit(0); }
    Db::tx(function () use ($moves, $fid) {
        foreach ($moves as $id => [, $b]) Db::update('graph_nodes', ['x' => round($b[0], 2), 'y' => round($b[1], 2)], ['id' => $id]);
        Revisions::bump('map');
        Audit::log('update', 'graph', $fid, count($moves) . ' node dirapikan terhadap bangunan toko (pintu di dinding, koridor ≥ 1,2 m)', null, ['nodes' => array_map(fn($v) => 'n' . $v, array_keys($moves))]);
    });
    echo "Disimpan. Publish dari CMS supaya kiosk memakainya.\n";
    exit(0);
}

if (isset($o['focus'])) {
    if (!Map3d::isPlan($e)) { fwrite(STDERR, "$fid belum \"plan\"\n"); exit(1); }
    $pts = array_merge(array_map(fn($r) => [(float)$r['x'], (float)$r['y']], Db::all('SELECT x, y FROM graph_nodes WHERE floor_id=?', [$fid])),
        array_map(fn($r) => [(float)$r['x'], (float)$r['y']], Db::all('SELECT x, y FROM tenants WHERE floor_id=? AND x IS NOT NULL UNION ALL SELECT x, y FROM amenities WHERE floor_id=? UNION ALL SELECT x, y FROM kiosks WHERE floor_id=?', [$fid, $fid, $fid])), $facPts());
    if (count($pts) < FEW_POINTS) $pts = array_merge($pts, $wallPts());
    if (!$pts) { fwrite(STDERR, "Belum ada jalur/tenant di $fid\n"); exit(1); }
    $box = $contentBox($pts, array_map('floatval', $m['artboard']));
    if ($floor['building'] === 'both') {
        // a joined floor (merge_floor.py): each building framed by its own shops, facilities and pins
        $boxes = [];
        foreach (['pentacity', 'ewalk'] as $b) {
            $bp = [];
            foreach ($m['facilities'] ?? [] as $f) if (($f['building'] ?? null) === $b) $bp[] = Map3d::planPoint($m, (float)$f['x'], (float)$f['y']);
            foreach (Db::all('SELECT x, y FROM tenants WHERE floor_id=? AND building=? AND x IS NOT NULL UNION ALL SELECT x, y FROM amenities WHERE floor_id=? AND building=? UNION ALL SELECT x, y FROM kiosks WHERE floor_id=? AND building=?', [$fid, $b, $fid, $b, $fid, $b]) as $r) $bp[] = [(float)$r['x'], (float)$r['y']];
            if (count($bp) < FEW_POINTS) $bp = array_merge($bp, $wallPts($b));
            if ($bp) $boxes[$b] = $contentBox($bp, array_map('floatval', $m['artboard']));
        }
        if (!$boxes) { echo "Lantai gabungan tanpa gedung di model: atur fokus per gedung di CMS (Lantai → Focus).\n"; exit(0); }
        foreach ($boxes as $b => $bx) echo "Kotak fokus $fid / $b: " . implode(', ', $bx) . "\n";
        if (!$apply) { echo "Tambah --apply untuk menyimpan.\n"; exit(0); }
        Db::tx(function () use ($fid, $boxes) {
            foreach ($boxes as $b => $bx) {
                Db::exec('DELETE FROM floor_focus WHERE floor_id=? AND building=?', [$fid, $b]);
                Db::insert('floor_focus', ['floor_id' => $fid, 'building' => $b, 'x' => $bx[0], 'y' => $bx[1], 'w' => $bx[2], 'h' => $bx[3]]);
            }
            Revisions::bump('map');
            Audit::log('update', 'floor', $fid, 'Kotak fokus kamera per gedung dihitung dari toko/fasilitas/pin', null, ['focus' => $boxes]);
        });
        echo "Disimpan. Publish dari CMS supaya kiosk memakainya.\n";
        exit(0);
    }
    echo "Kotak fokus $fid: " . implode(', ', $box) . "\n";
    if (!$apply) { echo "Tambah --apply untuk menyimpan.\n"; exit(0); }
    Db::tx(function () use ($fid, $floor, $box) {
        Db::exec('DELETE FROM floor_focus WHERE floor_id=?', [$fid]);
        Db::insert('floor_focus', ['floor_id' => $fid, 'building' => $floor['building'], 'x' => $box[0], 'y' => $box[1], 'w' => $box[2], 'h' => $box[3]]);
        Revisions::bump('map');
        Audit::log('update', 'floor', $fid, 'Kotak fokus kamera dihitung dari jalur/tenant/fasilitas', null, ['focus' => $box]);
    });
    echo "Disimpan. Publish dari CMS supaya kiosk memakainya.\n";
    exit(0);
}

if (isset($o['plan-only'])) {
    if (!Map3d::isPlan($e)) { fwrite(STDERR, "$fid belum \"plan\": jalankan tanpa --plan-only\n"); exit(1); }
    if (!$apply) { echo "Denah " . (Map3d::planIsCurrent($fid, $e) ? 'sudah' : 'BELUM') . " dari model terbaru. Tambah --apply untuk membuat ulang.\n"; exit(0); }
    $r = Db::tx(fn() => Map3d::installPlan($fid, $e, $m));
    echo ($r['changed'] ? 'Denah diperbarui → ' : 'Denah sudah sama → ') . $r['path'] . "\n";
    foreach ((array)$r['remap'] as $o => $n) echo "  unit $o → $n (tautan tenant & edit atap ikut pindah)\n";
    exit(0);
}
if (Map3d::isPlan($e)) { fwrite(STDERR, "$fid sudah memakai koordinat gambar (frame plan). Untuk denah saja: --plan-only\n"); exit(1); }
$A = $e['toMetres'] ?? null;
if (!is_array($A)) { fwrite(STDERR, "Registry $fid tanpa toMetres: jalankan register_floor.py dulu\n"); exit(1); }

$aff = fn(array $M, float $x, float $y): array => [$M[0][0] * $x + $M[0][1] * $y + $M[0][2], $M[1][0] * $x + $M[1][1] * $y + $M[1][2]];
// a floor both buildings share: each building has its own fit (the old drawing isn't one scale); a point takes its
// building's, and a point in between (outdoor paths) a blend weighted by how far it is from each building
$parts = [];
foreach ($e['parts'] ?? [] as $b => $p) if (!empty($p['toMetres']))
    $parts[$b] = ['A' => $p['toMetres'], 'polys' => array_map(fn($sp) => $sp['outer'], array_values(array_filter($m['slab'], fn($sp) => ($sp['building'] ?? null) === $b)))];
$distPoly = function (array $p, array $poly): float { // metres from a point to a polygon, 0 inside
    $in = false; $best = INF; $n = count($poly);
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        [$xi, $yi] = $poly[$i]; [$xj, $yj] = $poly[$j];
        if ((($yi > $p[1]) !== ($yj > $p[1])) && ($p[0] < ($xj - $xi) * ($p[1] - $yi) / (($yj - $yi) ?: 1e-9) + $xi)) $in = !$in;
        $dx = $xj - $xi; $dy = $yj - $yi; $t = max(0.0, min(1.0, (($p[0] - $xi) * $dx + ($p[1] - $yi) * $dy) / (($dx * $dx + $dy * $dy) ?: 1e-9)));
        $best = min($best, hypot($p[0] - $xi - $t * $dx, $p[1] - $yi - $t * $dy));
    }
    return $in ? 0.0 : $best;
};
$T = function ($x, $y, ?string $building = null) use ($A, $m, $parts, $aff, $distPoly): array {
    $x = (float)$x; $y = (float)$y;
    if (!$parts) [$mx, $my] = $aff($A, $x, $y);
    elseif ($building !== null && isset($parts[$building])) [$mx, $my] = $aff($parts[$building]['A'], $x, $y);
    else {
        $sw = $mx = $my = 0.0;
        foreach ($parts as $pt) {
            $q = $aff($pt['A'], $x, $y); $d = INF;
            foreach ($pt['polys'] as $poly) $d = min($d, $distPoly($q, $poly));
            $w = 1 / (($d + 1) ** 3); $sw += $w; $mx += $w * $q[0]; $my += $w * $q[1];
        }
        $mx /= $sw; $my /= $sw;
    }
    return Map3d::planPoint($m, $mx, $my);
};
$s = (float)$m['m_per_unit'];
$vb = array_map('floatval', $m['artboard']);
$inVb = fn($p) => $p[0] >= $vb[0] && $p[1] >= $vb[1] && $p[0] <= $vb[0] + $vb[2] && $p[1] <= $vb[1] + $vb[3];

// ---------- data on this floor
$nodes = Db::all('SELECT id, x, y FROM graph_nodes WHERE floor_id=?', [$fid]);
$edges = Db::all('SELECT e.id, e.node_a, e.node_b, e.is_enabled, e.cost_override FROM graph_edges e JOIN graph_nodes a ON a.id=e.node_a WHERE a.floor_id=?', [$fid]);
$tenants = Db::all('SELECT id, x, y, node_id, unit_shape_id FROM tenants WHERE floor_id=?', [$fid]);
$amen = Db::all('SELECT id, x, y FROM amenities WHERE floor_id=?', [$fid]);
$kiosks = Db::all('SELECT id, x, y, facing_deg FROM kiosks WHERE floor_id=?', [$fid]);
$events = Db::all('SELECT id, x, y FROM events WHERE floor_id=? AND x IS NOT NULL AND y IS NOT NULL', [$fid]);
$focus = Db::all('SELECT * FROM floor_focus WHERE floor_id=?', [$fid]);

$old = []; $new = [];
foreach ($nodes as $n) { $old[(int)$n['id']] = [(float)$n['x'], (float)$n['y']]; $new[(int)$n['id']] = $T((float)$n['x'], (float)$n['y']); }
$out = array_keys(array_filter($new, fn($p) => !$inVb($p)));
// keep each floor's walking cost: new unit_scale = Σ old cost / Σ new length (edges without an override)
$c0 = 0.0; $l1 = 0.0;
foreach ($edges as $ed) {
    if ($ed['cost_override'] !== null) continue;
    $a = (int)$ed['node_a']; $b = (int)$ed['node_b'];
    $c0 += hypot($old[$a][0] - $old[$b][0], $old[$a][1] - $old[$b][1]) * (float)$floor['unit_scale'];
    $l1 += hypot($new[$a][0] - $new[$b][0], $new[$a][1] - $new[$b][1]);
}
$scale = $l1 > 0 ? round($c0 / $l1, 4) : round($s / 0.7, 4);

// unit under each moved tenant pin (metres), for the report
$pip = function (array $pt, array $poly): bool {
    $in = false; $n = count($poly);
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        [$xi, $yi] = $poly[$i]; [$xj, $yj] = $poly[$j];
        if ((($yi > $pt[1]) !== ($yj > $pt[1])) && ($pt[0] < ($xj - $xi) * ($pt[1] - $yi) / (($yj - $yi) ?: 1e-9) + $xi)) $in = !$in;
    }
    return $in;
};
$unitAt = function (array $p) use ($m, $s, $pip): ?string {
    $mp = [($p[0] - (float)$m['origin'][0]) * $s, ($p[1] - (float)$m['origin'][1]) * $s];
    foreach ($m['units'] as $u) if (!empty($u['poly']) && $pip($mp, $u['poly'])) return $u['id'];
    return null;
};
$links = [];
$units = []; foreach ($m['units'] as $u) $units[$u['id']] = $u;
foreach (($e['tenants'] ?? []) as $uid => $tid) if (isset($units[$uid]) && strpos((string)$tid, '3d:') !== 0) $links[(string)$tid] = (string)$uid;

echo "Lantai $fid: " . count($nodes) . ' node, ' . count($edges) . ' edge, ' . count($tenants) . ' tenant, ' . count($amen) . ' fasilitas, ' . count($kiosks) . ' kiosk, ' . count($events) . " event\n";
echo 'viewBox ' . implode(' ', [$floor['vb_x'], $floor['vb_y'], $floor['vb_w'], $floor['vb_h']]) . ' → ' . implode(' ', $vb) . "\n";
echo "unit_scale {$floor['unit_scale']} → $scale (meter asli model: " . round($s / 0.7, 4) . ", 0.7 = BSB_CONFIG.metersPerUnit)\n";
if ($out) echo 'PERINGATAN: ' . count($out) . ' node di luar artboard: n' . implode(', n', array_slice($out, 0, 10)) . "\n";
foreach ($tenants as $t) {
    if ($t['x'] === null) { echo sprintf("  %-34s belum ditempatkan\n", $t['id']); continue; }
    $p = $T((float)$t['x'], (float)$t['y']);
    $link = $links[$t['id']] ?? null;
    $keep = $t['unit_shape_id'] && isset($units[$t['unit_shape_id']]); // an id from the old 2D drawing is replaced
    echo sprintf("  %-34s → (%7.1f, %6.1f) di unit %-22s %s\n", $t['id'], $p[0], $p[1], $unitAt($p) ?? '-',
        $keep ? "unit_shape_id tetap {$t['unit_shape_id']}" : ($link ? "→ tautkan $link" . ($t['unit_shape_id'] ? " (ganti {$t['unit_shape_id']})" : '') : ($t['unit_shape_id'] ? "tanpa unit (lepas {$t['unit_shape_id']})" : 'tanpa unit')));
}

// ---------- check image: the plan with the moved graph and pins
if (!empty($o['check'])) {
    $svg = Map3d::planSvg($m);
    $ov = ['<g id="check" fill="none">'];
    foreach ($edges as $ed) { $a = $new[(int)$ed['node_a']]; $b = $new[(int)$ed['node_b']];
        $ov[] = sprintf('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" stroke-width="2.2" stroke-linecap="round"/>', $a[0], $a[1], $b[0], $b[1], $ed['is_enabled'] ? '#e0452b' : '#999'); }
    foreach ($new as $id => $p) $ov[] = sprintf('<circle cx="%.2f" cy="%.2f" r="2.6" fill="#e0452b"/>', $p[0], $p[1]);
    foreach ($tenants as $t) if ($t['x'] !== null) { $p = $T((float)$t['x'], (float)$t['y']);
        $ov[] = sprintf('<circle cx="%.2f" cy="%.2f" r="4" fill="#2f5bea" stroke="#fff" stroke-width="1"/><text x="%.2f" y="%.2f" font-size="8" fill="#2f5bea" font-family="system-ui">%s</text>', $p[0], $p[1], $p[0] + 5, $p[1] - 4, htmlspecialchars($t['id'])); }
    foreach ($amen as $a) { $p = $T((float)$a['x'], (float)$a['y']); $ov[] = sprintf('<rect x="%.2f" y="%.2f" width="7" height="7" fill="#0b8a8a"/>', $p[0] - 3.5, $p[1] - 3.5); }
    $ov[] = '</g>';
    file_put_contents($o['check'], str_replace('</svg>', implode("\n", $ov) . "\n</svg>", $svg));
    echo "Gambar periksa: {$o['check']}\n";
}
if (!$apply) { echo "Uji coba saja. Tambah --apply untuk menerapkan.\n"; exit(0); }
if ($out) { fwrite(STDERR, "Dibatalkan: ada node di luar artboard.\n"); exit(1); }

// ---------- apply
$res = Db::tx(function () use ($fid, $floor, $e, $m, $T, $vb, $s, $scale, $nodes, $tenants, $amen, $kiosks, $events, $focus, $links, $units, $new, $contentBox, $facPts) {
    foreach ($nodes as $n) { $p = $new[(int)$n['id']]; Db::update('graph_nodes', ['x' => round($p[0], 2), 'y' => round($p[1], 2)], ['id' => (int)$n['id']]); }
    $linked = [];
    foreach ($tenants as $t) {
        $row = [];
        if ($t['x'] !== null) { $p = $T((float)$t['x'], (float)$t['y']); $row = ['x' => round($p[0], 2), 'y' => round($p[1], 2)]; }
        if (isset($links[$t['id']]) && !($t['unit_shape_id'] && isset($units[$t['unit_shape_id']]))) { $row['unit_shape_id'] = $links[$t['id']]; $linked[] = $t['id']; }
        elseif ($t['unit_shape_id'] && !isset($units[$t['unit_shape_id']])) $row['unit_shape_id'] = null; // a shape of the old 2D drawing: gone from the plan
        if ($row) Db::update('tenants', $row, ['id' => $t['id']]);
    }
    foreach ($amen as $a) { $p = $T((float)$a['x'], (float)$a['y']); Db::update('amenities', ['x' => round($p[0], 2), 'y' => round($p[1], 2)], ['id' => $a['id']]); }
    foreach ($events as $ev) { $p = $T((float)$ev['x'], (float)$ev['y']); Db::update('events', ['x' => round($p[0], 2), 'y' => round($p[1], 2)], ['id' => (int)$ev['id']]); }
    foreach ($kiosks as $k) {
        $p = $T((float)$k['x'], (float)$k['y']); $row = ['x' => round($p[0], 2), 'y' => round($p[1], 2)];
        if ($k['facing_deg'] !== null) {
            $f = (float)$k['facing_deg'] * M_PI / 180; $vx = sin($f); $vy = -cos($f);
            $q = $T((float)$k['x'] + 4 * $vx, (float)$k['y'] + 4 * $vy); $wx = $q[0] - $p[0]; $wy = $q[1] - $p[1]; // the facing, moved like the floor there
            $row['facing_deg'] = ((int)round(atan2($wx, -$wy) * 180 / M_PI) + 360) % 360;
        }
        Db::update('kiosks', $row, ['id' => $k['id']]);
    }
    // focus box: corridors + pins + facilities for a one-building floor, else the moved boxes
    $clamp = function (array $b) use ($vb): array {
        $x0 = max($vb[0], $b[0]); $y0 = max($vb[1], $b[1]); $x1 = min($vb[0] + $vb[2], $b[2]); $y1 = min($vb[1] + $vb[3], $b[3]);
        return [round($x0, 2), round($y0, 2), round($x1 - $x0, 2), round($y1 - $y0, 2)];
    };
    $pts = array_merge(array_values($new), $facPts());
    foreach (array_merge($tenants, $amen, $kiosks) as $r) if ($r['x'] !== null) $pts[] = $T((float)$r['x'], (float)$r['y']);
    foreach ($focus as $fb) {
        if ($floor['building'] !== 'both' && $pts) {
            $box = $contentBox($pts, $vb);
        } else {
            $b = $fb['building'];
            $c = [$T($fb['x'], $fb['y'], $b), $T($fb['x'] + $fb['w'], $fb['y'], $b), $T($fb['x'], $fb['y'] + $fb['h'], $b), $T($fb['x'] + $fb['w'], $fb['y'] + $fb['h'], $b)];
            $box = $clamp([min(array_column($c, 0)), min(array_column($c, 1)), max(array_column($c, 0)), max(array_column($c, 1))]);
        }
        Db::update('floor_focus', ['x' => $box[0], 'y' => $box[1], 'w' => $box[2], 'h' => $box[3]], ['floor_id' => $fid, 'building' => $fb['building']]);
    }
    $plan = Map3d::installPlan($fid, $e, $m, $scale, true);
    if ($linked) Revisions::bump('content');
    Revisions::bump('map');
    Audit::log('rebase', 'floor', $fid, 'Koordinat CMS dipindah ke gambar 3D (' . count($nodes) . ' node, ' . count($tenants) . ' tenant); unit ditautkan: ' . count($linked),
        ['viewBox' => [$floor['vb_x'], $floor['vb_y'], $floor['vb_w'], $floor['vb_h']], 'unit_scale' => $floor['unit_scale'], 'toMetres' => $e['toMetres']],
        ['viewBox' => $vb, 'unit_scale' => $scale, 'frame' => 'plan', 'linked' => $linked]);
    return ['plan' => $plan, 'linked' => $linked];
});
$entry = ['model' => $e['model'], 'edits' => $e['edits'] ?? null, 'frame' => 'plan', 'view' => $e['view'] ?? null, 'parts' => $e['parts'] ?? null,
    'legacy' => ['toMetres' => $e['toMetres'], 'unitScale' => (float)$floor['unit_scale'], 'viewBox' => [(float)$floor['vb_x'], (float)$floor['vb_y'], (float)$floor['vb_w'], (float)$floor['vb_h']],
        'rebased' => date('Y-m-d H:i'), 'ecc' => $e['ecc'] ?? null]];
$reg['floors'][$fid] = array_filter($entry, fn($v) => $v !== null);
Map3d::saveRegistry($reg);
echo "Selesai. Denah: {$res['plan']['path']}; tenant ditautkan: " . (implode(', ', $res['linked']) ?: '-') . "\n";
echo "Registry $fid → frame \"plan\". Publish dari CMS (Publish → Direktori) supaya kiosk memakai data baru.\n";
