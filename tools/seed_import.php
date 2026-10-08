<?php
/**
 * seed_import.php — isi DB bsb_directory dari data hasil importer Mapplic (§10.5 WP-A langkah 3).
 *
 * Sumber: data/releases/legacy-directory.json (cadangan data/directory.json lama; dibuat otomatis bila belum ada),
 *         data/build_log.json, data/overrides/connectors.json, assets/logos/*.webp, data/floors/*.svg, config.js (featured).
 *
 * Pakai:  php tools/seed_import.php --reset      (DROP + CREATE DATABASE bsb_directory, lalu seed)
 *         php tools/seed_import.php              (hanya seed; DB harus kosong)
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$argvs = $argv ?? [];
$reset = in_array('--reset', $argvs, true);
$root = APP_ROOT;
$say = function (string $s) { fwrite(STDOUT, $s . "\n"); };

// ---------------------------------------------------------------- 0. cadangan legacy
$legacy = $root . '/data/releases/legacy-directory.json';
if (!is_file($legacy)) {
    Util::ensureDir(dirname($legacy));
    $cur = json_decode((string)file_get_contents($root . '/data/directory.json'), true);
    if (($cur['meta']['source'] ?? '') === 'cms') { fwrite(STDERR, "data/directory.json sudah hasil CMS dan legacy-directory.json tidak ada — batal.\n"); exit(1); }
    copy($root . '/data/directory.json', $legacy);
    $say('backup: data/directory.json → data/releases/legacy-directory.json');
}
$D = json_decode((string)file_get_contents($legacy), true);
$BL = json_decode((string)file_get_contents($root . '/data/build_log.json'), true);
$OV = json_decode((string)file_get_contents($root . '/data/overrides/connectors.json'), true);

// ---------------------------------------------------------------- 1. schema
if ($reset) {
    $c = Config::get('db');
    $dsn = 'mysql:' . (!empty($c['socket']) ? 'unix_socket=' . $c['socket'] : 'host=' . $c['host'] . ';port=' . (int)$c['port']) . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $c['user'], $c['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('DROP DATABASE IF EXISTS `' . $c['name'] . '`');
    foreach (['schema.sql', 'seed_reference.sql'] as $f) {
        foreach (splitSql((string)file_get_contents($root . '/db/' . $f)) as $stmt) $pdo->exec($stmt);
    }
    $say('schema: database ' . $c['name'] . ' dibuat ulang');
    Db::reset();
}
if ((int)Db::val('SELECT COUNT(*) FROM floors') > 0) { fwrite(STDERR, "DB sudah berisi data — pakai --reset\n"); exit(1); }

function splitSql(string $sql): array
{
    $out = []; $buf = '';
    foreach (preg_split('/\R/', $sql) as $line) {
        $t = ltrim($line);
        if ($t === '' || str_starts_with($t, '--')) continue;
        $buf .= $line . "\n";
        if (preg_match('/;\s*(--.*)?$/', rtrim($line))) { $out[] = trim(preg_replace('/;\s*(--.*)?$/', '', trim($buf))); $buf = ''; }
    }
    if (trim($buf) !== '') $out[] = trim($buf);
    return array_values(array_filter($out));
}

$stats = [];
Db::tx(function () use ($D, $BL, $OV, $root, $say, &$stats) {
    // ------------------------------------------------------------ media helper
    $mediaId = function (string $path, string $kind) use ($root): int {
        $abs = $root . '/' . $path;
        if (!is_file($abs)) throw new RuntimeException("media hilang: $path");
        $sha = hash_file('sha256', $abs);
        $id = Db::val('SELECT id FROM media WHERE sha256=? AND kind=?', [$sha, $kind]);
        if ($id) return (int)$id;
        $w = $h = null; $mime = 'application/octet-stream';
        if ($kind === 'svg') { $mime = 'image/svg+xml'; }
        else { $gi = @getimagesize($abs); if ($gi) { $w = $gi[0]; $h = $gi[1]; $mime = $gi['mime']; } }
        return Db::insert('media', ['kind' => $kind, 'path' => $path, 'mime' => $mime, 'bytes' => filesize($abs), 'width' => $w, 'height' => $h,
            'sha256' => $sha, 'original_name' => basename($path), 'meta' => Util::jsonEncode(['seed' => true, 'encoder' => 'importer'])]);
    };

    // ------------------------------------------------------------ 2. floors
    $nameId = ['Lower Ground' => 'Lower Ground', 'Ground Floor' => 'Lantai Dasar (GF)', 'Upper Ground' => 'Upper Ground',
        'First Floor' => 'Lantai 1', 'Second Floor' => 'Lantai 2'];
    $floorById = [];
    foreach ($D['floors'] as $i => $f) {
        $parts = explode(' · ', $f['name'], 2);
        $nid = ($nameId[$parts[0]] ?? $parts[0]) . (isset($parts[1]) ? ' · ' . $parts[1] : '');
        $mid = $mediaId($f['svg'], 'svg');
        Db::insert('floors', ['id' => $f['id'], 'level' => $f['level'], 'short' => $f['short'], 'name_en' => $f['name'], 'name_id' => $nid,
            'building' => $f['building'], 'svg_media_id' => $mid, 'vb_x' => $f['viewBox'][0], 'vb_y' => $f['viewBox'][1],
            'vb_w' => $f['viewBox'][2], 'vb_h' => $f['viewBox'][3], 'unit_scale' => $f['unitScale'], 'north_deg' => null, 'sort_order' => $i + 1]);
        foreach ($f['focus'] as $b => $r) Db::insert('floor_focus', ['floor_id' => $f['id'], 'building' => $b, 'x' => $r[0], 'y' => $r[1], 'w' => $r[2], 'h' => $r[3]]);
        $floorById[$f['id']] = $f;
    }
    $stats['floors'] = count($D['floors']);

    // ------------------------------------------------------------ 3. categories (+ warna dari B.CAT_COLORS js/map.js)
    $catColor = ['food-beverage' => '#D9822B', 'fashion' => '#3B5BDB', 'beauty-health' => '#C2417A', 'electronics' => '#0B8A8A',
        'kids-family' => '#E0A800', 'entertainment' => '#7B4FD6', 'department-store' => '#2F9E44', 'services' => '#6B7280'];
    $catId = ['food-beverage' => 'Makanan & Minuman', 'fashion' => 'Fashion & Gaya Hidup', 'beauty-health' => 'Kecantikan & Kesehatan',
        'electronics' => 'Gadget & Elektronik', 'kids-family' => 'Anak & Keluarga', 'entertainment' => 'Hiburan',
        'department-store' => 'Department Store & Supermarket', 'services' => 'Hotel, Travel & Layanan'];
    foreach ($D['categories'] as $i => $c) {
        Db::insert('categories', ['id' => $c['id'], 'name_en' => $c['name'], 'name_id' => $catId[$c['id']] ?? $c['name'], 'icon' => $c['icon'],
            'color' => $catColor[$c['id']] ?? '#857B70', 'sort_order' => $i + 1, 'is_active' => 1]);
    }
    $stats['categories'] = count($D['categories']);

    // ------------------------------------------------------------ 4. nodes (id n<k> → k)
    $nodeById = [];
    foreach ($D['graph']['nodes'] as $n) {
        $k = (int)substr($n['id'], 1);
        Db::insert('graph_nodes', ['id' => $k, 'floor_id' => $n['floor'], 'x' => $n['x'], 'y' => $n['y']]);
        $nodeById[$n['id']] = $n;
    }
    $stats['nodes'] = count($D['graph']['nodes']);

    // ------------------------------------------------------------ 5. walk edges (dedupe; cost_override null bila identik)
    $seen = []; $ov = 0; $dup = 0;
    foreach ($D['graph']['edges'] as $e) {
        if ($e[3] !== 'walk') continue;
        $a = (int)substr($e[0], 1); $b = (int)substr($e[1], 1);
        if ($a === $b) continue;
        [$a, $b] = $a < $b ? [$a, $b] : [$b, $a];
        $key = "$a-$b";
        $na = $nodeById['n' . $a]; $nb = $nodeById['n' . $b];
        $auto = round(hypot($na['x'] - $nb['x'], $na['y'] - $nb['y']) * $floorById[$na['floor']]['unitScale'], 2);
        $override = (abs($auto - (float)$e[2]) < 0.000001) ? null : (float)$e[2];
        if (isset($seen[$key])) {
            $dup++;
            if ((float)$e[2] < $seen[$key]) Db::exec('UPDATE graph_edges SET cost_override=? WHERE node_a=? AND node_b=?', [$override, $a, $b]);
            continue;
        }
        $seen[$key] = (float)$e[2];
        if ($override !== null) $ov++;
        Db::insert('graph_edges', ['node_a' => $a, 'node_b' => $b, 'type' => 'walk', 'is_enabled' => 1, 'cost_override' => $override]);
    }
    $stats['walkEdges'] = count($seen); $stats['walkCostOverrides'] = $ov; $stats['walkDuplicates'] = $dup;

    // ------------------------------------------------------------ 6. banks + stops
    $bankOf = function (string $endpoint): string {
        if (preg_match('/^(esc-[abc]-(penta|ewalk))-\d+$/', $endpoint, $m)) return $m[1];
        return $endpoint;
    };
    $banks = []; $stopByNode = []; $stopConn = [];
    $sort = 0;
    foreach ($D['amenities'] as $a) {
        $bank = $bankOf($a['connectors'][0]);
        if (!isset($banks[$bank])) {
            $type = ['escalator' => 'escalator', 'lift' => 'lift', 'crossing' => 'bridge', 'stairs' => 'stairs'][$a['type']];
            $bld = $type === 'bridge' ? 'both' : (str_contains($a['name'], 'E-Walk') ? 'ewalk' : 'pentacity');
            $code = preg_match('/^esc-([abc])-/', $bank, $m) ? strtoupper($m[1]) : null;
            $nameId = str_replace(['Escalator', 'Bridge'], ['Eskalator', 'Jembatan'], $a['name']);
            $row = ['id' => $bank, 'type' => $type, 'building' => $bld, 'code' => $code, 'name_en' => $a['name'], 'name_id' => $nameId,
                'is_enabled' => 1, 'sort_order' => ++$sort];
            if ($bank === 'esc-a-penta') { $row['landmark_en'] = 'in front of Sociolla'; $row['landmark_id'] = 'depan Sociolla'; }
            $notes = [];
            foreach (($OV['disable'] ?? []) as $ep => $why) if ($bankOf($ep) === $bank) $notes[] = "Leg $ep TIDAK diimpor (nonaktif): $why. Stop LG tidak ada di data Mapplic — tambahkan stop + leg nonaktif bila perlu dicatat di peta.";
            foreach (($OV['oneway'] ?? []) as $ep => $dir) if ($bankOf($ep) === $bank) $notes[] = "Leg $ep satu arah: $dir (override lapangan)";
            foreach (($BL['danglingConnectors'] ?? []) as $dc) if ($bankOf($dc['endpoint']) === $bank) $notes[] = "Endpoint {$dc['endpoint']} buntu di data Mapplic (hanya ada di " . implode(',', $dc['floors']) . ') — cek lapangan';
            if ($notes) $row['notes'] = implode("\n", $notes);
            Db::insert('connector_banks', $row);
            $banks[$bank] = $row;
        }
        $sid = Db::insert('connector_stops', ['bank_id' => $bank, 'floor_id' => $a['floor'], 'node_id' => (int)substr($a['node'], 1),
            'public_id' => $a['id'], 'is_served' => 1]);
        if (isset($stopByNode[$a['node']])) throw new RuntimeException('node dipakai 2 stop: ' . $a['node']);
        $stopByNode[$a['node']] = ['id' => $sid, 'bank' => $bank, 'floor' => $a['floor']];
        $stopConn[$sid] = $a['connectors'];
    }
    $stats['banks'] = count($banks); $stats['stops'] = count($stopByNode);

    // ------------------------------------------------------------ 7. legs
    $cost = Snapshot::costSettings();
    $pairs = [];
    foreach ($D['graph']['edges'] as $e) {
        if ($e[3] === 'walk') continue;
        $sa = $stopByNode[$e[0]] ?? null; $sb = $stopByNode[$e[1]] ?? null;
        if (!$sa || !$sb) throw new RuntimeException('edge konektor tanpa stop: ' . json_encode($e));
        if ($sa['bank'] !== $sb['bank']) throw new RuntimeException('edge lintas bank: ' . json_encode($e));
        $la = $floorById[$sa['floor']]['level']; $lb = $floorById[$sb['floor']]['level'];
        // arah = arah tempuh nyata edge berarah (e[0] → e[1]); lift/crossing = both
        if ($e[3] === 'crossing' || $la === $lb) { $lower = $sa; $upper = $sb; }
        elseif ($la < $lb) { $lower = $sa; $upper = $sb; }
        else { $lower = $sb; $upper = $sa; }
        $dir = str_starts_with($e[3], 'escalator') ? ($la < $lb ? 'up' : 'down') : 'both';
        $k = $lower['id'] . '-' . $upper['id'];
        if (!isset($pairs[$k])) $pairs[$k] = ['lower' => $lower, 'upper' => $upper, 'dirs' => [], 'cost' => (float)$e[2], 'type' => $e[3]];
        $pairs[$k]['dirs'][$dir] = true;
        if ((float)$e[2] !== $pairs[$k]['cost']) throw new RuntimeException("biaya naik/turun beda untuk leg $k");
    }
    $legCount = 0;
    foreach ($pairs as $p) {
        $dirs = $p['dirs'];
        $direction = isset($dirs['both']) || (isset($dirs['up']) && isset($dirs['down'])) ? 'both' : (isset($dirs['up']) ? 'up' : 'down');
        $bank = $banks[$p['lower']['bank']];
        $ll = $floorById[$p['lower']['floor']]['level']; $ul = $floorById[$p['upper']['floor']]['level'];
        $auto = Snapshot::legCost($bank['type'], null, $ll, $ul);
        $src = array_values(array_intersect($stopConn[$p['lower']['id']], $stopConn[$p['upper']['id']]));
        Db::insert('connector_legs', ['bank_id' => $bank['id'], 'lower_stop_id' => $p['lower']['id'], 'upper_stop_id' => $p['upper']['id'],
            'direction' => $direction, 'is_enabled' => 1, 'cost_override' => abs($auto - $p['cost']) < 0.000001 ? null : $p['cost'],
            'src_key' => $src[0] ?? null, 'field_note' => null]);
        $legCount++;
    }
    $stats['legs'] = $legCount;

    // ------------------------------------------------------------ 8. brands + tenants
    $svgIds = [];
    foreach ($D['floors'] as $f) {
        preg_match_all('/\sid="(unit-[^"]+)"/', (string)file_get_contents($root . '/' . $f['svg']), $m);
        $svgIds[$f['id']] = array_flip($m[1]);
    }
    $groups = [];
    foreach ($D['tenants'] as $t) $groups[$t['brand']][] = $t;
    $slugs = [];
    $brandIds = [];
    $warnings = [];
    foreach ($groups as $bname => $ts) {
        $first = $ts[0];
        $strip = array_merge(Keywords::CAT_KW[$first['category']] ?? [], [strtolower($floorById[$first['floor']]['short']), strtolower(Keywords::BUILDING_LABEL[$first['building']])]);
        $kw = array_values(array_filter($first['keywords'], fn($k) => !in_array($k, $strip, true)));
        $slug = Util::slug($bname); $s = $slug; $i = 2;
        while (isset($slugs[$s])) $s = $slug . '-' . $i++;
        $slugs[$s] = true;
        // url brand hanya bila semua outlet sama; selain itu per outlet lewat url_override (fidelitas data lama)
        $urls = array_unique(array_map(fn($t) => (string)$t['url'], $ts));
        $url = count($urls) === 1 ? $first['url'] : null;
        foreach ($ts as $t) if ($t['category'] !== $first['category']) $warnings[] = "brand $bname: kategori outlet berbeda ({$t['id']})";
        $logoId = null;
        foreach ($ts as $t) if ($t['logo']) { $logoId = $mediaId($t['logo'], 'logo'); break; }
        $bid = Db::insert('brands', ['slug' => $s, 'name' => $bname, 'category_id' => $first['category'], 'logo_media_id' => $logoId,
            'desc_en' => $first['desc'], 'keywords_id' => $kw ? implode(', ', $kw) : null, 'url' => $url]);
        $brandIds[$bname] = ['id' => $bid, 'url' => $url, 'logo' => $logoId];
    }
    $stats['brands'] = count($groups);
    // display name otomatis (sama dengan Snapshot::displayName) → name_override hanya bila berbeda
    $overrides = 0; $units = 0; $logoOv = 0; $urlOv = 0;
    foreach ($D['tenants'] as $t) {
        $b = $brandIds[$t['brand']];
        $outs = $groups[$t['brand']];
        if (count($outs) < 2) $auto = $t['brand'];
        else {
            $same = count(array_filter($outs, fn($o) => $o['building'] === $t['building']));
            $auto = $t['brand'] . ' · ' . Keywords::BUILDING_LABEL[$t['building']] . ($same > 1 ? ' ' . $floorById[$t['floor']]['short'] : '');
        }
        $nameOv = $auto === $t['name'] ? null : $t['name'];
        if ($nameOv !== null) $overrides++;
        $logoOverride = null;
        if ($t['logo']) { $lid = $mediaId($t['logo'], 'logo'); if ($lid !== $b['logo']) { $logoOverride = $lid; $logoOv++; } }
        $urlOverride = null;
        if ($t['url'] !== $b['url']) {
            if ($t['url'] === null) $warnings[] = "tenant {$t['id']}: url kosong tetapi brand punya url → mewarisi url brand";
            else { $urlOverride = $t['url']; $urlOv++; }
        }
        $unit = isset($svgIds[$t['floor']]['unit-' . $t['id']]) ? 'unit-' . $t['id'] : null;
        if ($unit) $units++;
        Db::insert('tenants', ['id' => $t['id'], 'brand_id' => $b['id'], 'name_override' => $nameOv, 'floor_id' => $t['floor'], 'building' => $t['building'],
            'x' => $t['x'], 'y' => $t['y'], 'node_id' => (int)substr($t['node'], 1), 'unit_shape_id' => $unit, 'phone' => $t['phone'],
            'url_override' => $urlOverride, 'logo_override_media_id' => $logoOverride, 'status' => 'open', 'hours_mode' => 'unknown',
            'is_published' => 1, 'src_id' => $t['srcId']]);
    }
    $stats += ['tenants' => count($D['tenants']), 'nameOverrides' => $overrides, 'unitShapes' => $units, 'logoOverrides' => $logoOv, 'urlOverrides' => $urlOv];

    // ------------------------------------------------------------ 9. kiosks
    foreach ($D['kiosks'] as $k) {
        Db::insert('kiosks', ['id' => $k['id'], 'name' => $k['name'], 'floor_id' => $k['floor'], 'building' => $k['building'], 'x' => $k['x'], 'y' => $k['y'],
            'node_id' => (int)substr($k['node'], 1), 'facing_deg' => $k['facingDeg'], 'default_lang' => 'en', 'attract_lang' => 'en',
            'client_type' => 'windows_pc', 'perf_mode' => 'auto', 'is_active' => 1, 'src_id' => $k['srcId']]);
    }
    $stats['kiosks'] = count($D['kiosks']);

    // ------------------------------------------------------------ 10. featured (dari config.js)
    $cfgJs = (string)@file_get_contents($root . '/config.js');
    $feat = 0;
    if (preg_match('/featured:\s*\[([^\]]*)\]/s', $cfgJs, $m)) {
        preg_match_all("/'([^']+)'/", $m[1], $ids);
        foreach ($ids[1] as $i => $tid) {
            if (Db::val('SELECT id FROM tenants WHERE id=?', [$tid])) { Db::insert('featured_tenants', ['tenant_id' => $tid, 'sort_order' => $i + 1]); $feat++; }
        }
    }
    $stats['featured'] = $feat;

    Audit::log('seed', 'system', null, 'seed_import dari data Mapplic', null, $stats, null);
    $stats['warnings'] = $warnings;
});

$max = (int)Db::val('SELECT MAX(id) FROM graph_nodes');
Db::pdo()->exec('ALTER TABLE graph_nodes AUTO_INCREMENT = ' . ($max + 1));   // DDL: di luar transaksi (implicit commit)
foreach ($stats as $k => $v) $say(sprintf('  %-18s %s', $k, is_array($v) ? (count($v) ? "\n    - " . implode("\n    - ", $v) : '0') : $v));
$say('seed selesai. Lanjut: php tools/validate.php && php tools/create_admin.php …');
