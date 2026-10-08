<?php
/**
 * validate.php — validasi snapshot kandidat dari DB (port tools/verify_routes.py, §2.15).
 *
 *   php tools/validate.php [--accessible] [--json out.json] [--file path/to/directory.json] [--warnings]
 *   php tools/validate.php --file data/directory.json --compare data/releases/legacy-directory.json [--out report.txt]
 *        (bandingkan biaya rute semua pasangan kiosk→tenant, mode default & aksesibel)
 *   php tools/validate.php --publish "catatan"   (CLI: validasi lalu publish directory; juga promos/status pertama bila belum ada)
 *
 * Tanpa --file: snapshot dibangun dari DB (yang akan dipublish). Exit code 1 bila ada error.
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$args = $argv ?? [];
$opt = function (string $k) use ($args) { $i = array_search($k, $args, true); return $i === false ? null : ($args[$i + 1] ?? null); };
$acc = in_array('--accessible', $args, true);
$file = $opt('--file');

$t0 = microtime(true);
if ($file) { $D = json_decode((string)file_get_contents($file), true); $aux = []; $src = $file; }
else { [$D, $aux] = Snapshot::directory(); $src = 'DB (kandidat)'; }
$status = is_file(APP_ROOT . '/data/status.json') ? json_decode((string)file_get_contents(APP_ROOT . '/data/status.json'), true) : null;
$R = Validator::run($D, $aux, ['status' => $status, 'checkMedia' => true]);
$S = $R['stats'];

$mode = $acc ? 'ACCESSIBLE (lift / crossing only)' : 'DEFAULT';
echo "== validate.php  mode=$mode  sumber=$src\n";
printf("   floors=%d tenants=%d kiosks=%d nodes=%d edges=%d\n", count($D['floors']), $S['tenants'], $S['kiosks'], $S['nodes'], $S['edges']);
echo $R['errors'] ? "!! errors:\n" : "   contract checks OK (E_REF, E_BOUNDS, E_NODE_FLOOR, E_EDGE_FLOOR, E_LEG_LEVEL, E_URL, E_REACH)\n";
foreach ($R['errors'] as $e) echo "    {$e['code']}  {$e['msg']}\n";
$reach = $acc ? $S['accessibleReachable'] : $S['reachable'];
$un = (array)($acc ? $R['unreachableAccessible'] : $R['unreachable']);
printf("\n   reachable kiosk->tenant pairs: %d/%d = %.1f%%\n", $reach, $S['pairs'], $S['pairs'] ? 100 * $reach / $S['pairs'] : 0);
printf("   tenants reachable from ALL kiosks: %d/%d\n", $S['tenants'] - count($un), $S['tenants']);
if ($un) {
    echo "\n   UNREACHABLE (tenant <- kiosks that cannot reach it):\n";
    ksort($un);
    foreach ($un as $tid => $ks) printf("    - %-38s from %d/%d: %s\n", $tid, count($ks), $S['kiosks'], implode(', ', $ks));
}
printf("\n   tenant->kiosk unreachable pairs (return trip): %d\n", $S['returnFail']);
echo "   warnings: " . json_encode($S['warningCounts']) . "\n";
if (in_array('--warnings', $args, true)) foreach ($R['warnings'] as $w) if (!in_array($w['code'], ['W_NO_HOURS'], true)) echo "    {$w['code']}  {$w['msg']}\n";
printf("   validator %d ms (total %d ms)\n", $R['ms'], (int)round((microtime(true) - $t0) * 1000));
if ($o = $opt('--json')) file_put_contents($o, Util::jsonEncode($R, true));
if ($cmp = $opt('--compare')) {
    $OLD = json_decode((string)file_get_contents($cmp), true);
    $lines = ["== Perbandingan biaya rute kiosk→tenant", "   lama: $cmp (" . ($OLD['meta']['source'] ?? '?') . ")", "   baru: $src (" . ($D['meta']['version'] ?? 'kandidat') . ")"];
    $allSame = true;
    foreach ([false, true] as $accMode) {
        $a = RouteCheck::costMatrix($OLD, $accMode); $b = RouteCheck::costMatrix($D, $accMode);
        $n = 0; $same = 0; $diff = []; $maxd = 0.0;
        foreach ($a as $k => $row) foreach ($row as $t => $c) {
            $n++; $c2 = (isset($b[$k]) && array_key_exists($t, $b[$k])) ? $b[$k][$t] : 'MISSING';
            if ($c === $c2 || (is_float($c) && is_float($c2) && abs($c - $c2) < 0.005)) $same++;
            else { $diff[] = "$k → $t: " . json_encode($c) . ' vs ' . json_encode($c2); if (is_float($c) && is_float($c2)) $maxd = max($maxd, abs($c - $c2)); }
        }
        $extra = 0; foreach ($b as $k => $row) foreach ($row as $t => $c) if (!isset($a[$k]) || !array_key_exists($t, $a[$k])) $extra++;
        $lines[] = sprintf('   mode %-10s pasangan=%d identik=%d beda=%d (maks selisih %.2f) pasangan-baru-tanpa-lawan=%d', $accMode ? 'aksesibel' : 'default', $n, $same, count($diff), $maxd, $extra);
        foreach (array_slice($diff, 0, 30) as $d) $lines[] = '     ! ' . $d;
        if ($diff || $extra) $allSame = false;
    }
    // edge set (tanpa elemen ke-5)
    $es = fn($G) => array_map(function ($e) {   // edge tak berarah dinormalisasi (urutan node tidak bermakna)
        $p = [$e[0], $e[1]]; if (strncmp($e[3], 'escalator', 9) !== 0) sort($p);
        return implode('|', [$p[0], $p[1], number_format((float)$e[2], 2, '.', ''), $e[3]]);
    }, $G['graph']['edges']);
    $eo = $es($OLD); $en = $es($D);
    $lines[] = sprintf('   edge [from,to,cost,type]: lama=%d baru=%d  hanya-lama=%d hanya-baru=%d', count($eo), count($en), count(array_diff($eo, $en)), count(array_diff($en, $eo)));
    foreach (array_slice(array_values(array_diff($eo, $en)), 0, 10) as $x) $lines[] = '     - ' . $x;
    foreach (array_slice(array_values(array_diff($en, $eo)), 0, 10) as $x) $lines[] = '     + ' . $x;
    // field legacy
    $chk = ['tenants' => ['id', 'name', 'brand', 'category', 'floor', 'building', 'x', 'y', 'node', 'phone', 'url', 'desc', 'hours', 'srcId', 'logo'],
        'kiosks' => ['id', 'name', 'floor', 'building', 'x', 'y', 'node', 'facingDeg', 'srcId'],
        'amenities' => ['id', 'type', 'name', 'floor', 'building', 'x', 'y', 'node', 'toFloors', 'connectors'],
        'floors' => ['id', 'name', 'short', 'level', 'building', 'viewBox', 'unitScale', 'focus'], 'categories' => ['id', 'name', 'icon']];
    foreach ($chk as $coll => $fields) {
        $A = []; foreach ($OLD[$coll] as $x) $A[$x['id']] = $x;
        $B = []; foreach ($D[$coll] as $x) $B[$x['id']] = $x;
        $fd = [];
        foreach ($A as $id => $x) {
            if (!isset($B[$id])) { $fd['(hilang)'][] = $id; continue; }
            foreach ($fields as $f) if (json_encode($x[$f] ?? null) !== json_encode($B[$id][$f] ?? null)) $fd[$f][] = $id;
        }
        $kwSame = 0;
        if ($coll === 'tenants') foreach ($A as $id => $x) if (isset($B[$id])) { $p = $x['keywords']; $q = $B[$id]['keywords']; sort($p); sort($q); if ($p === $q) $kwSame++; }
        $lines[] = sprintf('   %-10s lama=%d baru=%d  field berbeda: %s%s', $coll, count($A), count($B),
            $fd ? implode('; ', array_map(fn($f, $ids) => $f . '×' . count($ids) . ' [' . implode(',', array_slice($ids, 0, 6)) . (count($ids) > 6 ? ',…' : '') . ']', array_keys($fd), $fd)) : 'tidak ada',
            $coll === 'tenants' ? "  keywords(set) identik=$kwSame/" . count($A) : '');
        $extraIds = array_diff(array_keys($B), array_keys($A));
        if ($extraIds) $lines[] = '     + baru: ' . implode(',', $extraIds);
    }
    $lines[] = $allSame ? '   HASIL: biaya rute IDENTIK untuk semua pasangan (default & aksesibel)' : '   HASIL: ADA PERBEDAAN biaya rute';
    $txt = implode("\n", $lines) . "\n";
    echo "\n" . $txt;
    if ($o = $opt('--out')) file_put_contents($o, $txt);
}
if (in_array('--publish', $args, true) && !$file) {
    if (!$R['ok']) { echo "!! tidak dipublish: ada error\n"; exit(1); }
    $notes = (string)($opt('--publish') ?? 'publish CLI');
    if (str_starts_with($notes, '--')) $notes = 'publish CLI';
    $rel = Publisher::publishDirectory($notes, null, true);
    echo "   PUBLISHED directory {$rel['version']} sha256={$rel['sha256']} bytes={$rel['bytes']}\n";
    if (!Publisher::live('promos')) { $p = Publisher::publishPromos('publish awal'); echo "   PUBLISHED promos {$p['version']}\n"; }
    if (!Publisher::live('status')) { $s = Publisher::publishStatus('publish awal'); echo "   PUBLISHED status {$s['version']}\n"; }
}
exit($R['ok'] ? 0 : 1);
