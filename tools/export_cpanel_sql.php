<?php
/**
 * export_cpanel_sql.php
 * Generates a complete, ready-to-import SQL file for cPanel/phpMyAdmin.
 * Includes schema, reference seeds, full mall entities, and default superadmin account.
 */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

$root = APP_ROOT;
$outPath = $root . '/bsb_directory_cpanel.sql';

$sqlBuffer = [];
$sqlBuffer[] = "-- =================================================================";
$sqlBuffer[] = "-- BSB Directory (e-Walk & Pentacity) Database Dump for cPanel";
$sqlBuffer[] = "-- Generated on: " . date('Y-m-d H:i:s');
$sqlBuffer[] = "-- Instructions: Import this file directly into your cPanel database via phpMyAdmin";
$sqlBuffer[] = "-- =================================================================";
$sqlBuffer[] = "";
$sqlBuffer[] = "SET NAMES utf8mb4;";
$sqlBuffer[] = "SET FOREIGN_KEY_CHECKS = 0;";
$sqlBuffer[] = "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';";
$sqlBuffer[] = "";

// 1. Process schema.sql (remove CREATE DATABASE and USE)
$schemaLines = file($root . '/db/schema.sql', FILE_IGNORE_NEW_LINES);
$filteredSchema = [];
foreach ($schemaLines as $line) {
    if (preg_match('/^\s*(CREATE DATABASE|USE\s+)/i', $line)) {
        continue;
    }
    $filteredSchema[] = $line;
}
$sqlBuffer[] = implode("\n", $filteredSchema);
$sqlBuffer[] = "";

// 2. Process seed_reference.sql (remove USE)
$refLines = file($root . '/db/seed_reference.sql', FILE_IGNORE_NEW_LINES);
$filteredRef = [];
foreach ($refLines as $line) {
    if (preg_match('/^\s*(USE\s+|SET NAMES)/i', $line)) {
        continue;
    }
    $filteredRef[] = $line;
}
$sqlBuffer[] = implode("\n", $filteredRef);
$sqlBuffer[] = "";

// Helper for SQL escaping
function escVal($val): string {
    if ($val === null) return 'NULL';
    if (is_bool($val)) return $val ? '1' : '0';
    if (is_int($val)) return (string)$val;
    if (is_float($val)) return (string)$val;
    return "'" . addcslashes((string)$val, "\x00\n\r\\'\x1a") . "'";
}

function buildInsert(string $table, array $row): string {
    $cols = array_keys($row);
    $vals = array_map('escVal', array_values($row));
    return "INSERT INTO `{$table}` (`" . implode('`, `', $cols) . "`) VALUES (" . implode(', ', $vals) . ");";
}

// 3. Process data sources
$dirJson = json_decode((string)file_get_contents($root . '/data/directory.json'), true);
$BL = json_decode((string)file_get_contents($root . '/data/build_log.json'), true);
$OV = json_decode((string)file_get_contents($root . '/data/overrides/connectors.json'), true);

$sqlBuffer[] = "-- =================================================================";
$sqlBuffer[] = "-- SEED DATA: MEDIA, FLOORS, CATEGORIES, NODES, CONNECTORS & TENANTS";
$sqlBuffer[] = "-- =================================================================";
$sqlBuffer[] = "";

// Media helper tracking
$mediaMap = [];
$nextMediaId = 1;
$getOrAddMedia = function (string $path, string $kind) use ($root, &$mediaMap, &$nextMediaId, &$sqlBuffer): int {
    $abs = $root . '/' . $path;
    if (!is_file($abs)) {
        return 0;
    }
    $sha = hash_file('sha256', $abs);
    if (isset($mediaMap[$sha])) {
        return $mediaMap[$sha];
    }
    $id = $nextMediaId++;
    $mediaMap[$sha] = $id;
    $w = null; $h = null; $mime = 'application/octet-stream';
    if ($kind === 'svg') {
        $mime = 'image/svg+xml';
    } else {
        $gi = @getimagesize($abs);
        if ($gi) { $w = $gi[0]; $h = $gi[1]; $mime = $gi['mime']; }
    }
    $row = [
        'id' => $id,
        'kind' => $kind,
        'path' => $path,
        'mime' => $mime,
        'bytes' => filesize($abs),
        'width' => $w,
        'height' => $h,
        'sha256' => $sha,
        'original_name' => basename($path),
        'meta' => json_encode(['seed' => true, 'encoder' => 'importer'])
    ];
    $sqlBuffer[] = buildInsert('media', $row);
    return $id;
};

// Floors
$nameId = [
    'Lower Ground' => 'Lower Ground',
    'Ground Floor' => 'Lantai Dasar (GF)',
    'Upper Ground' => 'Upper Ground',
    'First Floor' => 'Lantai 1',
    'Second Floor' => 'Lantai 2'
];
$floorById = [];
foreach ($dirJson['floors'] as $i => $f) {
    $parts = explode(' · ', $f['name'], 2);
    $nid = ($nameId[$parts[0]] ?? $parts[0]) . (isset($parts[1]) ? ' · ' . $parts[1] : '');
    $mid = $getOrAddMedia($f['svg'], 'svg');
    $row = [
        'id' => $f['id'],
        'level' => $f['level'],
        'short' => $f['short'],
        'name_en' => $f['name'],
        'name_id' => $nid,
        'building' => $f['building'],
        'svg_media_id' => $mid,
        'vb_x' => $f['viewBox'][0],
        'vb_y' => $f['viewBox'][1],
        'vb_w' => $f['viewBox'][2],
        'vb_h' => $f['viewBox'][3],
        'unit_scale' => $f['unitScale'],
        'north_deg' => null,
        'sort_order' => $i + 1
    ];
    $sqlBuffer[] = buildInsert('floors', $row);
    foreach ($f['focus'] as $bld => $r) {
        $sqlBuffer[] = buildInsert('floor_focus', [
            'floor_id' => $f['id'],
            'building' => $bld,
            'x' => $r[0],
            'y' => $r[1],
            'w' => $r[2],
            'h' => $r[3]
        ]);
    }
    $floorById[$f['id']] = $f;
}

// Categories
$catColor = [
    'food-beverage' => '#D9822B', 'fashion' => '#3B5BDB', 'beauty-health' => '#C2417A',
    'electronics' => '#0B8A8A', 'kids-family' => '#E0A800', 'entertainment' => '#7B4FD6',
    'department-store' => '#2F9E44', 'services' => '#6B7280'
];
$catId = [
    'food-beverage' => 'Makanan & Minuman', 'fashion' => 'Fashion & Gaya Hidup',
    'beauty-health' => 'Kecantikan & Kesehatan', 'electronics' => 'Gadget & Elektronik',
    'kids-family' => 'Anak & Keluarga', 'entertainment' => 'Hiburan',
    'department-store' => 'Department Store & Supermarket', 'services' => 'Hotel, Travel & Layanan'
];
foreach ($dirJson['categories'] as $i => $c) {
    $row = [
        'id' => $c['id'],
        'name_en' => $c['name'],
        'name_id' => $catId[$c['id']] ?? $c['name'],
        'icon' => $c['icon'],
        'color' => $catColor[$c['id']] ?? '#857B70',
        'sort_order' => $i + 1,
        'is_active' => 1
    ];
    $sqlBuffer[] = buildInsert('categories', $row);
}

// Graph Nodes
$nodeById = [];
foreach ($dirJson['graph']['nodes'] as $n) {
    $k = (int)substr($n['id'], 1);
    $row = [
        'id' => $k,
        'floor_id' => $n['floor'],
        'x' => $n['x'],
        'y' => $n['y']
    ];
    $sqlBuffer[] = buildInsert('graph_nodes', $row);
    $nodeById[$n['id']] = $n;
}

// Walk Edges
$seenWalk = [];
foreach ($dirJson['graph']['edges'] as $e) {
    if ($e[3] !== 'walk') continue;
    $a = (int)substr($e[0], 1);
    $b = (int)substr($e[1], 1);
    if ($a === $b) continue;
    [$a, $b] = $a < $b ? [$a, $b] : [$b, $a];
    $k = "$a-$b";
    $na = $nodeById['n' . $a];
    $nb = $nodeById['n' . $b];
    $auto = round(hypot($na['x'] - $nb['x'], $na['y'] - $nb['y']) * $floorById[$na['floor']]['unitScale'], 2);
    $override = (abs($auto - (float)$e[2]) < 0.000001) ? null : (float)$e[2];
    if (isset($seenWalk[$k])) continue;
    $seenWalk[$k] = true;
    $row = [
        'node_a' => $a,
        'node_b' => $b,
        'type' => 'walk',
        'is_enabled' => 1,
        'cost_override' => $override
    ];
    $sqlBuffer[] = buildInsert('graph_edges', $row);
}

// Connector Banks & Stops
$bankOf = function (string $endpoint): string {
    if (preg_match('/^(esc-[abc]-(penta|ewalk))-\d+$/', $endpoint, $m)) return $m[1];
    return $endpoint;
};
$banks = [];
$stopByNode = [];
$stopConn = [];
$sortBank = 0;
$nextStopId = 1;

foreach ($dirJson['amenities'] as $a) {
    $bank = $bankOf($a['connectors'][0]);
    if (!isset($banks[$bank])) {
        $type = ['escalator' => 'escalator', 'lift' => 'lift', 'crossing' => 'bridge', 'stairs' => 'stairs'][$a['type']];
        $bld = $type === 'bridge' ? 'both' : (str_contains($a['name'], 'E-Walk') ? 'ewalk' : 'pentacity');
        $code = preg_match('/^esc-([abc])-/', $bank, $m) ? strtoupper($m[1]) : null;
        $nameIdStr = str_replace(['Escalator', 'Bridge'], ['Eskalator', 'Jembatan'], $a['name']);
        $bRow = [
            'id' => $bank,
            'type' => $type,
            'building' => $bld,
            'code' => $code,
            'name_en' => $a['name'],
            'name_id' => $nameIdStr,
            'is_enabled' => 1,
            'sort_order' => ++$sortBank
        ];
        if ($bank === 'esc-a-penta') {
            $bRow['landmark_en'] = 'in front of Sociolla';
            $bRow['landmark_id'] = 'depan Sociolla';
        }
        $notes = [];
        foreach (($OV['disable'] ?? []) as $ep => $why) {
            if ($bankOf($ep) === $bank) $notes[] = "Leg $ep nonaktif: $why.";
        }
        if ($notes) $bRow['notes'] = implode("\n", $notes);
        $sqlBuffer[] = buildInsert('connector_banks', $bRow);
        $banks[$bank] = $bRow;
    }
    $sid = $nextStopId++;
    $sRow = [
        'id' => $sid,
        'bank_id' => $bank,
        'floor_id' => $a['floor'],
        'node_id' => (int)substr($a['node'], 1),
        'public_id' => $a['id'],
        'is_served' => 1
    ];
    $sqlBuffer[] = buildInsert('connector_stops', $sRow);
    $stopByNode[$a['node']] = ['id' => $sid, 'bank' => $bank, 'floor' => $a['floor']];
    $stopConn[$sid] = $a['connectors'];
}

// Connector Legs
$costSettings = [
    'escalator' => 19.2, 'lift' => 38.4, 'stairs' => 28.8,
    'travelator' => 9.6, 'bridge' => 0
];
$pairs = [];
foreach ($dirJson['graph']['edges'] as $e) {
    if ($e[3] === 'walk') continue;
    $sa = $stopByNode[$e[0]] ?? null;
    $sb = $stopByNode[$e[1]] ?? null;
    if (!$sa || !$sb || $sa['bank'] !== $sb['bank']) continue;
    $la = $floorById[$sa['floor']]['level'];
    $lb = $floorById[$sb['floor']]['level'];
    if ($e[3] === 'crossing' || $la === $lb) { $lower = $sa; $upper = $sb; }
    elseif ($la < $lb) { $lower = $sa; $upper = $sb; }
    else { $lower = $sb; $upper = $sa; }
    $dir = str_starts_with($e[3], 'escalator') ? ($la < $lb ? 'up' : 'down') : 'both';
    $pk = $lower['id'] . '-' . $upper['id'];
    if (!isset($pairs[$pk])) $pairs[$pk] = ['lower' => $lower, 'upper' => $upper, 'dirs' => [], 'cost' => (float)$e[2]];
    $pairs[$pk]['dirs'][$dir] = true;
}

$nextLegId = 1;
foreach ($pairs as $p) {
    $dirs = $p['dirs'];
    $direction = isset($dirs['both']) || (isset($dirs['up']) && isset($dirs['down'])) ? 'both' : (isset($dirs['up']) ? 'up' : 'down');
    $bank = $banks[$p['lower']['bank']];
    $ll = $floorById[$p['lower']['floor']]['level'];
    $ul = $floorById[$p['upper']['floor']]['level'];
    $levels = max(1, abs($ul - $ll));
    $auto = $bank['type'] === 'bridge' ? 0.0 : round(($costSettings[$bank['type']] ?? 19.2) * $levels, 2);
    $src = array_values(array_intersect($stopConn[$p['lower']['id']], $stopConn[$p['upper']['id']]));
    $lRow = [
        'id' => $nextLegId++,
        'bank_id' => $bank['id'],
        'lower_stop_id' => $p['lower']['id'],
        'upper_stop_id' => $p['upper']['id'],
        'direction' => $direction,
        'is_enabled' => 1,
        'cost_override' => abs($auto - $p['cost']) < 0.000001 ? null : $p['cost'],
        'src_key' => $src[0] ?? null
    ];
    $sqlBuffer[] = buildInsert('connector_legs', $lRow);
}

// Brands and Tenants
$svgIds = [];
foreach ($dirJson['floors'] as $f) {
    preg_match_all('/\sid="(unit-[^"]+)"/', (string)file_get_contents($root . '/' . $f['svg']), $m);
    $svgIds[$f['id']] = array_flip($m[1]);
}
$brandGroups = [];
foreach ($dirJson['tenants'] as $t) {
    $brandGroups[$t['brand']][] = $t;
}

$nextBrandId = 1;
$brandIds = [];
$slugs = [];

foreach ($brandGroups as $bname => $ts) {
    $first = $ts[0];
    $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower(trim($bname)));
    $s = $slug; $si = 2;
    while (isset($slugs[$s])) $s = $slug . '-' . $si++;
    $slugs[$s] = true;
    $urls = array_unique(array_map(fn($t) => (string)$t['url'], $ts));
    $url = count($urls) === 1 ? $first['url'] : null;
    $logoId = null;
    foreach ($ts as $t) {
        if ($t['logo']) { $logoId = $getOrAddMedia($t['logo'], 'logo'); break; }
    }
    $bid = $nextBrandId++;
    $bRow = [
        'id' => $bid,
        'slug' => $s,
        'name' => $bname,
        'category_id' => $first['category'],
        'logo_media_id' => $logoId,
        'desc_en' => $first['desc'],
        'keywords_id' => $first['keywords'] ? implode(', ', $first['keywords']) : null,
        'url' => $url
    ];
    $sqlBuffer[] = buildInsert('brands', $bRow);
    $brandIds[$bname] = ['id' => $bid, 'url' => $url, 'logo' => $logoId];
}

foreach ($dirJson['tenants'] as $t) {
    $b = $brandIds[$t['brand']];
    $outs = $brandGroups[$t['brand']];
    $bldLabel = $t['building'] === 'pentacity' ? 'Pentacity' : 'E-Walk';
    $autoName = count($outs) < 2 ? $t['brand'] : $t['brand'] . ' · ' . $bldLabel . (count($outs) > 2 ? ' ' . $floorById[$t['floor']]['short'] : '');
    $nameOv = ($autoName === $t['name']) ? null : $t['name'];
    $logoOv = null;
    if ($t['logo']) {
        $lid = $getOrAddMedia($t['logo'], 'logo');
        if ($lid !== $b['logo']) $logoOv = $lid;
    }
    $urlOv = ($t['url'] !== $b['url']) ? $t['url'] : null;
    $unit = isset($svgIds[$t['floor']]['unit-' . $t['id']]) ? 'unit-' . $t['id'] : null;
    $tRow = [
        'id' => $t['id'],
        'brand_id' => $b['id'],
        'name_override' => $nameOv,
        'floor_id' => $t['floor'],
        'building' => $t['building'],
        'x' => $t['x'],
        'y' => $t['y'],
        'node_id' => (int)substr($t['node'], 1),
        'unit_shape_id' => $unit,
        'phone' => $t['phone'],
        'url_override' => $urlOv,
        'logo_override_media_id' => $logoOv,
        'status' => 'open',
        'hours_mode' => 'unknown',
        'is_published' => 1,
        'src_id' => $t['srcId']
    ];
    $sqlBuffer[] = buildInsert('tenants', $tRow);
}

// Kiosks
foreach ($dirJson['kiosks'] as $k) {
    $kRow = [
        'id' => $k['id'],
        'name' => $k['name'],
        'floor_id' => $k['floor'],
        'building' => $k['building'],
        'x' => $k['x'],
        'y' => $k['y'],
        'node_id' => (int)substr($k['node'], 1),
        'facing_deg' => $k['facingDeg'],
        'default_lang' => 'en',
        'attract_lang' => 'en',
        'client_type' => 'windows_pc',
        'perf_mode' => 'auto',
        'is_active' => 1,
        'src_id' => $k['srcId']
    ];
    $sqlBuffer[] = buildInsert('kiosks', $kRow);
}

// Featured Tenants
$cfgJs = (string)@file_get_contents($root . '/config.js');
if (preg_match('/featured:\s*\[([^\]]*)\]/s', $cfgJs, $m)) {
    preg_match_all("/'([^']+)'/", $m[1], $fids);
    foreach ($fids[1] as $fi => $tid) {
        $sqlBuffer[] = buildInsert('featured_tenants', [
            'tenant_id' => $tid,
            'sort_order' => $fi + 1
        ]);
    }
}

// 4. Create default superadmin
$sqlBuffer[] = "";
$sqlBuffer[] = "-- =================================================================";
$sqlBuffer[] = "-- DEFAULT SUPERADMIN USER";
$sqlBuffer[] = "-- Login: admin@bsb.id / AdminBSB2026!";
$sqlBuffer[] = "-- =================================================================";
$hash = password_hash('AdminBSB2026!', PASSWORD_DEFAULT);
$adminRow = [
    'id' => 1,
    'email' => 'admin@bsb.id',
    'name' => 'Superadmin BSB',
    'role' => 'superadmin',
    'password_hash' => $hash,
    'is_active' => 1,
    'must_change_password' => 0,
    'failed_count' => 0
];
$sqlBuffer[] = rtrim(buildInsert('users', $adminRow), ';') . " ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash);";
$sqlBuffer[] = "";
$sqlBuffer[] = "SET FOREIGN_KEY_CHECKS = 1;";

file_put_contents($outPath, implode("\n", $sqlBuffer));
echo "SUCCESS: Created $outPath (" . number_format(filesize($outPath)) . " bytes)\n";
