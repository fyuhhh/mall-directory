<?php
declare(strict_types=1);

/** Validasi snapshot kandidat (§2.15) — port tools/verify_routes.py + aturan CMS. */
final class Validator
{
    /**
     * @param array $D   snapshot directory (kandidat)
     * @param array $aux info sampingan dari Snapshot::directory() (legs, danglingStops, unitMissing, tenantStatus)
     * @param array $opts status (status.json array|null), now (unix), checkMedia (bool)
     */
    public static function run(array $D, array $aux = [], array $opts = []): array
    {
        $t0 = microtime(true);
        $errors = []; $warn = [];
        $E = function (string $code, string $msg, $ref = null) use (&$errors) { $errors[] = ['code' => $code, 'msg' => $msg, 'ref' => $ref]; };
        $W = function (string $code, string $msg, $ref = null) use (&$warn) { $warn[] = ['code' => $code, 'msg' => $msg, 'ref' => $ref]; };
        $now = $opts['now'] ?? time();
        $status = $opts['status'] ?? null;

        // ---------- E_REF (id unik & referensi)
        $floors = [];
        foreach ($D['floors'] as $f) { if (isset($floors[$f['id']])) $E('E_REF', 'Lantai duplikat ' . $f['id'], ['floor' => $f['id']]); $floors[$f['id']] = $f; }
        $cats = [];
        foreach ($D['categories'] as $c) { if (isset($cats[$c['id']])) $E('E_REF', 'Kategori duplikat ' . $c['id'], ['category' => $c['id']]); $cats[$c['id']] = $c; }
        $nodes = [];
        foreach ($D['graph']['nodes'] as $n) {
            if (isset($nodes[$n['id']])) $E('E_REF', 'Node duplikat ' . $n['id'], ['node' => $n['id']]);
            $nodes[$n['id']] = $n;
            if (!isset($floors[$n['floor']])) $E('E_REF', "Node {$n['id']}: lantai {$n['floor']} tidak ada", ['node' => $n['id']]);
        }
        foreach (['tenants' => 'tenant', 'kiosks' => 'kiosk', 'amenities' => 'amenity'] as $coll => $ent) {
            $seen = [];
            foreach ($D[$coll] as $x) {
                $ref = [$ent => $x['id']];
                if (isset($seen[$x['id']])) $E('E_REF', "$ent {$x['id']} duplikat", $ref);
                $seen[$x['id']] = true;
                if (!isset($floors[$x['floor']])) { $E('E_REF', "$ent {$x['id']}: lantai {$x['floor']} tidak ada", $ref); continue; }
                if ($x['node'] === null || !isset($nodes[$x['node']])) { $E('E_REF', "$ent {$x['id']}: node " . ($x['node'] ?? 'kosong (belum ditempatkan)') . ' tidak ada', $ref); }
                elseif ($nodes[$x['node']]['floor'] !== $x['floor']) $E('E_NODE_FLOOR', "$ent {$x['id']}: node {$x['node']} ada di lantai {$nodes[$x['node']]['floor']}, bukan {$x['floor']}", $ref);
                $vb = $floors[$x['floor']]['viewBox'];
                if ($x['x'] === null || $x['y'] === null || !($vb[0] <= $x['x'] && $x['x'] <= $vb[0] + $vb[2] && $vb[1] <= $x['y'] && $x['y'] <= $vb[1] + $vb[3]))
                    $E('E_BOUNDS', "$ent {$x['id']}: titik di luar viewBox lantai {$x['floor']}", $ref);
            }
        }
        foreach ($D['tenants'] as $t) {
            $ref = ['tenant' => $t['id']];
            if (!isset($cats[$t['category']])) $E('E_REF', "tenant {$t['id']}: kategori {$t['category']} tidak ada/nonaktif", $ref);
            if ($t['url'] !== null && !str_starts_with($t['url'], 'https://')) $E('E_URL', "tenant {$t['id']}: url harus https://", $ref);
            if (!empty($opts['checkMedia'])) {
                foreach (['logo', 'logo2x'] as $lk) if (!empty($t[$lk]) && !is_file(APP_ROOT . '/' . $t[$lk])) $E('E_REF', "tenant {$t['id']}: file $lk hilang ({$t[$lk]})", $ref);
            }
            if (empty($t['logo'])) $W('W_NO_LOGO', "{$t['name']}: belum ada logo", $ref);
            if ($t['hours'] === null) $W('W_NO_HOURS', "{$t['name']}: jam buka belum diisi", $ref);
        }
        foreach ($D['floors'] as $f) {
            if (!empty($opts['checkMedia']) && !is_file(APP_ROOT . '/' . $f['svg'])) $E('E_REF', "lantai {$f['id']}: SVG hilang", ['floor' => $f['id']]);
            if (($f['northDeg'] ?? null) === null && ($D['meta']['mapNorthDeg'] ?? null) === null) $W('W_NO_NORTH', "Lantai {$f['id']}: arah utara belum diisi", ['floor' => $f['id']]);
        }
        foreach ($D['kiosks'] as $k) if ($k['facingDeg'] === null) $W('W_NO_FACING', "Kiosk {$k['id']}: arah hadap layar belum diisi", ['kiosk' => $k['id']]);

        // ---------- edges
        foreach ($D['graph']['edges'] as $e) {
            if (!isset($nodes[$e[0]]) || !isset($nodes[$e[1]])) { $E('E_REF', "edge {$e[0]}–{$e[1]}: node tidak ada", ['edge' => [$e[0], $e[1]]]); continue; }
            $fa = $nodes[$e[0]]['floor']; $fb = $nodes[$e[1]]['floor'];
            if ($e[3] === 'walk' && $fa !== $fb) $E('E_EDGE_FLOOR', "edge walk {$e[0]}–{$e[1]} lintas lantai ($fa→$fb)", ['edge' => [$e[0], $e[1]]]);
        }
        // ---------- legs (dari aux DB)
        foreach ($aux['legs'] ?? [] as $l) {
            $ref = ['leg' => $l['id'], 'bank' => $l['bank']];
            if ($l['lowerBank'] !== $l['bank'] || $l['upperBank'] !== $l['bank']) $E('E_LEG_LEVEL', "Leg L{$l['id']}: stop bukan milik bank {$l['bank']}", $ref);
            if ($l['type'] === 'bridge') {
                if ($l['lowerLevel'] !== $l['upperLevel'] || $l['lowerFloor'] === $l['upperFloor']) $E('E_LEG_LEVEL', "Leg L{$l['id']} (jembatan): harus level sama & sheet berbeda", $ref);
                if ($l['direction'] !== 'both') $E('E_LEG_LEVEL', "Leg L{$l['id']} (jembatan): arah wajib both", $ref);
            } elseif ($l['lowerLevel'] >= $l['upperLevel']) {
                $E('E_LEG_LEVEL', "Leg L{$l['id']} ({$l['label']}): level bawah harus < level atas", $ref);
            }
            if ($l['exported'] && in_array($l['type'], ['escalator', 'travelator'], true) && $l['upperLevel'] - $l['lowerLevel'] > 1)
                $W('W_ESC_SPAN', "Leg L{$l['id']} ({$l['label']}) melompati " . ($l['upperLevel'] - $l['lowerLevel']) . ' level', $ref);
            if ($l['exported'] && $l['scheduleId']) {
                $h = Schedule::hours((int)$l['scheduleId']);
                if ($h && Schedule::hasGap($h, $D['meta']['mallHours'] ?? Schedule::mallHours()))
                    $W('W_SCHEDULE_GAP', "Leg L{$l['id']} ({$l['label']}) tutup di sebagian jam buka mall", $ref);
            }
        }
        foreach ($aux['danglingStops'] ?? [] as $s) $W('W_STOP_DANGLING', "Stop $s tidak punya leg aktif (tidak diekspor)", ['stop' => $s]);
        foreach ($aux['unitMissing'] ?? [] as $u) $W('W_UNIT_MISSING', "Unit {$u['shape']} (tenant {$u['tenant']}) tidak ditemukan di SVG {$u['floor']}", ['tenant' => $u['tenant']]);
        $stopNodes = [];
        foreach ($D['amenities'] as $a) if (($a['kind'] ?? 'connector') !== 'poi') $stopNodes[$a['node']] = $a['id'];
        foreach ($D['amenities'] as $a) if (($a['kind'] ?? '') === 'poi' && isset($stopNodes[$a['node']]))
            $W('W_POI_NODE', "POI {$a['id']} memakai node konektor {$a['node']} ({$stopNodes[$a['node']]})", ['amenity' => $a['id']]);

        // ---------- keterjangkauan
        $hasErrRef = (bool)array_filter($errors, fn($e) => $e['code'] === 'E_REF');
        $def = RouteCheck::reachability($D, false);
        $acc = RouteCheck::reachability($D, true);
        $tStatus = $aux['tenantStatus'] ?? [];
        $tById = [];
        foreach ($D['tenants'] as $t) $tById[$t['id']] = $t;
        $nK = count(array_filter($D['kiosks'], fn($k) => $k['node'] !== null));
        foreach ($def['unreach'] as $tid => $ks) {
            if (count($ks) >= $nK && $nK > 0 && (($tStatus[$tid] ?? $tById[$tid]['status'] ?? 'open') === 'open'))
                $E('E_REACH', "{$tById[$tid]['name']}: tidak terjangkau dari kiosk mana pun", ['tenant' => $tid, 'kiosks' => $ks]);
        }
        foreach ($acc['unreach'] as $tid => $ks)
            $W('W_REACH_ACC', "{$tById[$tid]['name']}: tidak terjangkau mode aksesibel dari " . count($ks) . ' kiosk', ['tenant' => $tid, 'kiosks' => $ks]);

        // return trip (tenant → kiosk)
        $adj = RouteCheck::adjacency($D, false);
        $returnFail = 0;
        foreach ($D['tenants'] as $t) {
            if ($t['node'] === null) continue;
            [$dist] = RouteCheck::dijkstra($adj, $t['node']);
            $miss = [];
            foreach ($D['kiosks'] as $k) if ($k['node'] !== null && !isset($dist[$k['node']])) $miss[] = $k['id'];
            if ($miss) {
                $returnFail += count($miss);
                $W('W_REACH_RETURN', "{$t['name']} → kiosk tidak terjangkau (jalan pulang): " . implode(', ', $miss), ['tenant' => $t['id'], 'kiosks' => $miss]);
            }
        }
        // saat ini (closure aktif / di luar jam operasi)
        $nowR = RouteCheck::reachability($D, false, RouteCheck::openFilter($D, $status, $now));
        foreach ($nowR['unreach'] as $tid => $ks) {
            $before = $def['unreach'][$tid] ?? [];
            $extra = array_values(array_diff($ks, $before));
            if ($extra) $W('W_REACH_NOW', "{$tById[$tid]['name']}: saat ini tidak terjangkau dari " . count($extra) . ' kiosk (closure/jam operasi)', ['tenant' => $tid, 'kiosks' => $extra]);
        }
        // komponen terisolasi (node tanpa jalur dari kiosk mana pun)
        $seen = [];
        foreach ($D['kiosks'] as $k) {
            if ($k['node'] === null) continue;
            [$dist] = RouteCheck::dijkstra($adj, $k['node']);
            foreach ($dist as $n => $_) $seen[$n] = true;
        }
        $iso = array_values(array_filter(array_keys($nodes), fn($n) => !isset($seen[$n])));
        if ($iso) $W('W_COMPONENT', count($iso) . ' node tidak terhubung ke kiosk mana pun', ['nodes' => array_slice($iso, 0, 200), 'count' => count($iso)]);

        $pairs = max(1, $def['pairs']);
        $perKiosk = [];
        foreach ($D['kiosks'] as $k) $perKiosk[$k['id']] = ['total' => count($D['tenants']), 'default' => count($D['tenants']), 'accessible' => count($D['tenants']), 'returnFail' => 0];
        foreach ($def['unreach'] as $ks) foreach ($ks as $kid) if (isset($perKiosk[$kid])) $perKiosk[$kid]['default']--;
        foreach ($acc['unreach'] as $ks) foreach ($ks as $kid) if (isset($perKiosk[$kid])) $perKiosk[$kid]['accessible']--;
        foreach ($warn as $w) if ($w['code'] === 'W_REACH_RETURN') foreach ($w['ref']['kiosks'] as $kid) if (isset($perKiosk[$kid])) $perKiosk[$kid]['returnFail']++;
        $report = [
            'ok' => count($errors) === 0,
            'errors' => $errors,
            'warnings' => $warn,
            'stats' => [
                'pairs' => $def['pairs'], 'reachable' => $def['reach'], 'reachablePct' => round(100 * $def['reach'] / $pairs, 2),
                'accessibleReachable' => $acc['reach'], 'accessiblePct' => round(100 * $acc['reach'] / $pairs, 2),
                'returnFail' => $returnFail, 'nowReachable' => $nowR['reach'],
                'tenants' => count($D['tenants']), 'kiosks' => count($D['kiosks']), 'nodes' => count($D['graph']['nodes']), 'edges' => count($D['graph']['edges']),
                'errorCounts' => self::countBy($errors), 'warningCounts' => self::countBy($warn), 'perKiosk' => $perKiosk,
            ],
            'unreachable' => (object)$def['unreach'],
            'unreachableAccessible' => (object)$acc['unreach'],
            'ms' => (int)round((microtime(true) - $t0) * 1000),
        ];
        if ($hasErrRef) $report['note'] = 'Ada E_REF — hasil keterjangkauan mungkin tidak lengkap';
        return $report;
    }

    private static function countBy(array $items): array
    {
        $o = [];
        foreach ($items as $i) $o[$i['code']] = ($o[$i['code']] ?? 0) + 1;
        ksort($o);
        return $o;
    }

    /** Simpan ke validation_runs; kembalikan id. */
    public static function store(array $report, ?int $userId): int
    {
        return Db::insert('validation_runs', ['ok' => $report['ok'] ? 1 : 0, 'errors' => count($report['errors']), 'warnings' => count($report['warnings']),
            'report' => Util::jsonEncode($report), 'revs' => Util::jsonEncode(Revisions::all()), 'ms' => $report['ms'], 'created_by' => $userId]);
    }
}
