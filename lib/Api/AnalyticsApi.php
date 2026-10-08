<?php
declare(strict_types=1);

/** Analitik (§2.16), audit log, backup. */
final class AnalyticsApi
{
    public static function register(Router $r): void
    {
        $a = ['admin' => true, 'perm' => 'analytics.view'];
        foreach (['summary', 'searches', 'tenants', 'routes', 'qr', 'promos', 'uptime'] as $rep) $r->get('/admin/analytics/' . $rep, fn() => self::respond($rep), $a);
        $r->get('/admin/analytics/export.csv', [self::class, 'exportCsv'], $a);
        $r->get('/admin/audit', [self::class, 'audit'], ['admin' => true, 'perm' => 'audit.view']);
        $r->post('/admin/backup/run', [self::class, 'backup'], ['admin' => true, 'perm' => 'backup.run']);
        $r->get('/admin/dashboard', [self::class, 'dashboard'], ['admin' => true]);
    }

    private static function range(): array
    {
        $to = Http::q('to') ?: date('Y-m-d');
        $from = Http::q('from') ?: date('Y-m-d', strtotime($to . ' -6 days'));
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) throw ApiError::validation(['from' => 'YYYY-MM-DD']);
        if ($to >= date('Y-m-d')) Rollup::day(date('Y-m-d'));   // hari ini selalu segar
        $k = Http::q('kiosk');
        $w = 'day BETWEEN ? AND ?'; $p = [$from, $to];
        if ($k) { $w .= ' AND kiosk_id=?'; $p[] = $k; }
        return [$from, $to, $w, $p, $k];
    }

    private static function sum(string $w, array $p, string $metric): int
    {
        return (int)Db::val("SELECT COALESCE(SUM(value),0) FROM stats_daily WHERE $w AND metric=?", array_merge($p, [$metric]));
    }
    private static function top(string $w, array $p, string $metric, int $limit = 20): array
    {
        return array_map(fn($r) => ['key' => $r['dim'], 'count' => (int)$r['v']],
            Db::all("SELECT dim, SUM(value) v FROM stats_daily WHERE $w AND metric=? AND dim<>'' GROUP BY dim ORDER BY v DESC, dim LIMIT " . (int)$limit, array_merge($p, [$metric])));
    }

    public static function report(string $rep): array
    {
        [$from, $to, $w, $p, $k] = self::range();
        $limit = min(200, max(1, (int)(Http::q('limit') ?? 20)));
        $names = [];
        foreach (Db::all('SELECT t.id, COALESCE(t.name_override,b.name) n FROM tenants t JOIN brands b ON b.id=t.brand_id') as $r) $names[$r['id']] = $r['n'];
        $base = ['from' => $from, 'to' => $to, 'kiosk' => $k];
        switch ($rep) {
            case 'summary':
                $m = [];
                foreach (['session', 'search', 'search_zero', 'tenant_view', 'route', 'route_acc', 'route_fail', 'qr_shown', 'qr_scan', 'nav_start', 'nav_arrived', 'promo_imp', 'promo_tap'] as $x) $m[$x] = self::sum($w, $p, $x);
                $daily = Db::all("SELECT day, metric, SUM(value) v FROM stats_daily WHERE $w AND metric IN ('session','search','route','qr_scan') GROUP BY day, metric ORDER BY day", $p);
                $series = [];
                foreach ($daily as $d) $series[$d['day']][$d['metric']] = (int)$d['v'];
                return $base + ['totals' => $m, 'accessiblePct' => $m['route'] ? round(100 * $m['route_acc'] / $m['route'], 1) : 0,
                    'qrConversionPct' => $m['qr_shown'] ? round(100 * $m['qr_scan'] / $m['qr_shown'], 1) : 0,
                    'daily' => array_map(fn($d, $v) => ['day' => $d] + $v, array_keys($series), $series)];
            case 'searches':
                $zero = Util::bool(Http::q('zero', '0'));
                return $base + ['zero' => $zero, 'items' => self::top($w, $p, $zero ? 'search_zero' : 'search', $limit)];
            case 'tenants':
                $v = self::top($w, $p, 'tenant_view', $limit);
                foreach ($v as &$x) { $x['name'] = $names[$x['key']] ?? $x['key']; $x['routes'] = (int)Db::val("SELECT COALESCE(SUM(value),0) FROM stats_daily WHERE $w AND metric='route' AND dim=?", array_merge($p, [$x['key']])); }
                return $base + ['items' => $v];
            case 'routes':
                $byT = self::top($w, $p, 'route', $limit);
                foreach ($byT as &$x) $x['name'] = $names[$x['key']] ?? $x['key'];
                $byK = array_map(fn($r) => ['kiosk' => $r['kiosk_id'], 'routes' => (int)$r['r'], 'accessible' => (int)$r['a'], 'fail' => (int)$r['f']],
                    Db::all("SELECT kiosk_id, SUM(IF(metric='route',value,0)) r, SUM(IF(metric='route_acc',value,0)) a, SUM(IF(metric='route_fail',value,0)) f FROM stats_daily WHERE $w AND metric IN ('route','route_acc','route_fail') GROUP BY kiosk_id ORDER BY r DESC", $p));
                $tot = self::sum($w, $p, 'route');
                return $base + ['total' => $tot, 'accessiblePct' => $tot ? round(100 * self::sum($w, $p, 'route_acc') / $tot, 1) : 0, 'byTenant' => $byT, 'byKiosk' => $byK];
            case 'qr':
                $rows = Db::all("SELECT kiosk_id, SUM(IF(metric='route',value,0)) route, SUM(IF(metric='qr_shown',value,0)) shown, SUM(IF(metric='qr_scan',value,0)) scan,
                    SUM(IF(metric='nav_start',value,0)) nav, SUM(IF(metric='nav_arrived',value,0)) arrived FROM stats_daily WHERE $w GROUP BY kiosk_id ORDER BY kiosk_id", $p);
                $f = fn($r) => ['route' => (int)$r['route'], 'qrShown' => (int)$r['shown'], 'qrScan' => (int)$r['scan'], 'navStart' => (int)$r['nav'], 'arrived' => (int)$r['arrived']];
                $tot = ['route' => 0, 'qrShown' => 0, 'qrScan' => 0, 'navStart' => 0, 'arrived' => 0];
                $byK = [];
                foreach ($rows as $r) { $x = $f($r); foreach ($x as $kk => $vv) $tot[$kk] += $vv; $byK[] = ['kiosk' => $r['kiosk_id']] + $x; }
                return $base + ['funnel' => $tot, 'byKiosk' => $byK];
            case 'promos':
                $rows = Db::all("SELECT dim, SUM(IF(metric='promo_imp',value,0)) imp, SUM(IF(metric='promo_tap',value,0)) tap FROM stats_daily WHERE $w AND metric IN ('promo_imp','promo_tap') AND dim<>'' GROUP BY dim ORDER BY imp DESC", $p);
                $titles = [];
                foreach (Db::all('SELECT id, title_id, advertiser_name, advertiser_tenant_id FROM promos') as $x) $titles[(string)$x['id']] = $x;
                return $base + ['items' => array_map(fn($r) => ['promoId' => $r['dim'], 'title' => $titles[$r['dim']]['title_id'] ?? null,
                    'advertiser' => ($titles[$r['dim']]['advertiser_name'] ?? null) ?: ($titles[$r['dim']]['advertiser_tenant_id'] ?? null),
                    'impressions' => (int)$r['imp'], 'taps' => (int)$r['tap'], 'ctrPct' => (int)$r['imp'] ? round(100 * (int)$r['tap'] / (int)$r['imp'], 2) : 0], $rows)];
            case 'uptime':
                $open = KiosksApi::openMinutesPerDay();
                $rows = Db::all("SELECT day, kiosk_id, value FROM stats_daily WHERE $w AND metric='uptime_min' ORDER BY kiosk_id, day", $p);
                $o = [];
                foreach ($rows as $r) $o[$r['kiosk_id']][] = ['day' => $r['day'], 'minutes' => (int)$r['value'], 'pct' => round(min(100, 100 * (int)$r['value'] / max(1, $open[(int)date('N', strtotime($r['day']))])), 1)];
                return $base + ['kiosks' => array_map(fn($kid, $days) => ['kiosk' => $kid, 'days' => $days], array_keys($o), $o)];
        }
        throw ApiError::notFound('Laporan');
    }

    /** Bentuk respons sesuai yang dirender WP-B (CMS_DEVIATIONS WP-B #10); bentuk mentah tetap di "meta". */
    public static function respond(string $rep): void
    {
        $d = self::report($rep);
        $kn = array_column(Db::all('SELECT id, name FROM kiosks'), 'name', 'id');
        $meta = ['from' => $d['from'], 'to' => $d['to'], 'kiosk' => $d['kiosk']];
        switch ($rep) {
            case 'summary':
                $t = $d['totals'];
                Http::json(['data' => $d + ['sessions' => $t['session'], 'searches' => $t['search'], 'searchZero' => $t['search_zero'], 'tenantViews' => $t['tenant_view'],
                    'routes' => $t['route'], 'routesAccessiblePct' => $d['accessiblePct'], 'qrShown' => $t['qr_shown'], 'qrScans' => $t['qr_scan'], 'arrived' => $t['nav_arrived'],
                    'promoImpressions' => $t['promo_imp'], 'promoTaps' => $t['promo_tap'],
                    'series' => array_map(fn($x) => ['day' => $x['day'], 'sessions' => $x['session'] ?? 0, 'routes' => $x['route'] ?? 0, 'searches' => $x['search'] ?? 0], $d['daily'])]]);
                return;
            case 'searches':
                $avg = [];
                if (!$d['zero'] && $d['items']) {
                    $p = [$d['from'] . ' 00:00:00', $d['to'] . ' 23:59:59'];
                    $kw = $d['kiosk'] ? ' AND kiosk_id=?' : ''; if ($d['kiosk']) $p[] = $d['kiosk'];
                    foreach (Db::all("SELECT LEFT(LOWER(TRIM(query)),100) q, AVG(value) a FROM telemetry_events WHERE type='search' AND ts BETWEEN ? AND ?$kw GROUP BY q", $p) as $r) $avg[$r['q']] = round((float)$r['a'], 1);
                }
                $rows = array_map(fn($x) => ['query' => $x['key'], 'count' => $x['count']] + ($d['zero'] ? [] : ['avgResults' => $avg[$x['key']] ?? null]), $d['items']);
                break;
            case 'tenants': $rows = array_map(fn($x) => ['tenantId' => $x['key'], 'name' => $x['name'], 'views' => $x['count'], 'routes' => $x['routes']], $d['items']); break;
            case 'routes':
                $rows = array_map(fn($x) => ['kioskId' => $x['kiosk'], 'name' => $kn[$x['kiosk']] ?? $x['kiosk'], 'routes' => $x['routes'],
                    'accessiblePct' => $x['routes'] ? round(100 * $x['accessible'] / $x['routes'], 1) : 0, 'fail' => $x['fail']], $d['byKiosk']);
                $meta += ['total' => $d['total'], 'accessiblePct' => $d['accessiblePct'], 'byTenant' => $d['byTenant']];
                break;
            case 'qr':
                $p = [$d['from'] . ' 00:00:00', $d['to'] . ' 23:59:59']; $kw = $d['kiosk'] ? ' AND kiosk_id=?' : ''; if ($d['kiosk']) $p[] = $d['kiosk'];
                $f = $d['funnel'];
                Http::json(['data' => ['shown' => $f['qrShown'], 'scanned' => $f['qrScan'], 'navStart' => $f['navStart'], 'arrived' => $f['arrived'],
                    'compassDenied' => (int)Db::val("SELECT COUNT(*) FROM telemetry_events WHERE type='compass_denied' AND ts BETWEEN ? AND ?$kw", $p),
                    'routes' => $f['route'], 'byKiosk' => $d['byKiosk']], 'meta' => $meta]);
                return;
            case 'promos': $rows = array_map(fn($x) => ['promoId' => $x['promoId'], 'title' => $x['title'], 'advertiser' => $x['advertiser'], 'impressions' => $x['impressions'], 'taps' => $x['taps'], 'ctr' => $x['ctrPct']], $d['items']); break;
            case 'uptime': $rows = array_map(fn($k) => ['kioskId' => $k['kiosk'], 'name' => $kn[$k['kiosk']] ?? $k['kiosk'], 'days' => $k['days']], $d['kiosks']); break;
            default: $rows = [];
        }
        Http::json(['data' => $rows, 'total' => count($rows), 'meta' => $meta]);
    }

    public static function exportCsv(): void
    {
        $rep = (string)Http::q('report', 'summary');
        if (!in_array($rep, ['searches', 'tenants', 'routes', 'qr', 'promos', 'uptime', 'summary'], true)) throw ApiError::validation(['report' => 'unknown']);
        $d = self::report($rep);
        $rows = $d['items'] ?? $d['byKiosk'] ?? $d['daily'] ?? [];
        if ($rep === 'uptime') { $rows = []; foreach ($d['kiosks'] as $k) foreach ($k['days'] as $x) $rows[] = ['kiosk' => $k['kiosk']] + $x; }
        if ($rep === 'routes') $rows = $d['byTenant'];
        $fh = fopen('php://temp', 'w+');
        fwrite($fh, "\xEF\xBB\xBF");
        if ($rows) { fputcsv($fh, array_keys($rows[0])); foreach ($rows as $r) fputcsv($fh, array_map(fn($v) => is_array($v) ? json_encode($v) : $v, array_values($r))); }
        rewind($fh);
        $csv = (string)stream_get_contents($fh);
        if (Http::$captured !== null) { Http::$captured = ['status' => 200, 'body' => $csv]; return; }
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="analytics-' . $rep . '-' . $d['from'] . '_' . $d['to'] . '.csv"');
        header('Cache-Control: no-store');
        Http::securityHeaders();
        echo $csv;
    }

    public static function audit(): void
    {
        $w = []; $p = [];
        foreach (['entity' => 'a.entity_type', 'id' => 'a.entity_id', 'user' => 'a.user_id', 'action' => 'a.action'] as $k => $c) if (($v = Http::q($k)) !== null && $v !== '') { $w[] = "$c=?"; $p[] = $v; }
        if ($v = Http::q('from')) { $w[] = 'a.ts >= ?'; $p[] = $v . (strlen($v) === 10 ? ' 00:00:00' : ''); }
        if ($v = Http::q('to')) { $w[] = 'a.ts <= ?'; $p[] = $v . (strlen($v) === 10 ? ' 23:59:59' : ''); }
        if (($q = Http::q('q')) !== null && $q !== '') { $w[] = 'a.summary LIKE ?'; $p[] = "%$q%"; }
        $where = $w ? ' WHERE ' . implode(' AND ', $w) : '';
        [$page, $per, $lim] = Crud::page();
        $total = (int)Db::val('SELECT COUNT(*) FROM audit_log a' . $where, $p);
        $rows = Db::all('SELECT a.*, u.name user_name, u.email user_email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id' . $where . ' ORDER BY a.id DESC' . $lim, $p);
        Http::json(['data' => array_map(fn($r) => ['id' => (int)$r['id'], 'ts' => Util::iso($r['ts']), 'userId' => $r['user_id'] === null ? null : (int)$r['user_id'],
            'user' => $r['user_name'], 'userName' => $r['user_name'], 'userEmail' => $r['user_email'], 'ip' => $r['ip'], 'action' => $r['action'], 'entityType' => $r['entity_type'],
            'entityId' => $r['entity_id'], 'summary' => $r['summary'], 'before' => Util::jsonDecode($r['before_json']), 'after' => Util::jsonDecode($r['after_json'])], $rows),
            'total' => $total, 'page' => $page, 'per' => $per]);
    }

    public static function backup(): void
    {
        $win = DIRECTORY_SEPARATOR === '\\';
        $script = APP_ROOT . '/tools/' . ($win ? 'backup.ps1' : 'backup.sh');
        if (!is_file($script)) throw new ApiError('server', 'Skrip backup tidak ditemukan');
        $cmd = $win ? 'powershell -NoProfile -ExecutionPolicy Bypass -File ' . escapeshellarg($script) : 'sh ' . escapeshellarg($script);
        $t0 = microtime(true);
        exec($cmd . ' 2>&1', $out, $rc);
        Audit::log('backup', 'system', null, 'backup manual rc=' . $rc);
        Http::ok(['ok' => $rc === 0, 'exitCode' => $rc, 'output' => array_slice($out, -40), 'ms' => (int)round((microtime(true) - $t0) * 1000)]);
    }

    /** Ringkasan dashboard (§7.2 layar 2). */
    public static function dashboard(): void
    {
        $kiosks = Db::all('SELECT * FROM kiosks ORDER BY id');
        $k = array_map(fn($r) => ['id' => $r['id'], 'name' => $r['name'], 'clientType' => $r['client_type'], 'perfMode' => $r['perf_mode']] + ['runtime' => KiosksApi::runtime($r)], $kiosks);
        $last = Db::one('SELECT id, ok, errors, warnings, created_at FROM validation_runs ORDER BY id DESC LIMIT 1');
        $live = [];
        foreach (array_keys(Publisher::CHANNELS) as $ch) { $l = Publisher::live($ch); $live[$ch] = $l ? ['version' => $l['version'], 'publishedAt' => Util::iso($l['created_at']), 'rolledBackFrom' => $l['rolled_back_from'] === null ? null : (int)$l['rolled_back_from']] : null; }
        $from = date('Y-m-d', strtotime('-6 days')); $to = date('Y-m-d');
        Rollup::day($to);
        $top = fn($m) => array_map(fn($r) => ['key' => $r['dim'], 'count' => (int)$r['v']], Db::all("SELECT dim, SUM(value) v FROM stats_daily WHERE day BETWEEN ? AND ? AND metric=? AND dim<>'' GROUP BY dim ORDER BY v DESC LIMIT 5", [$from, $to, $m]));
        Http::ok([
            'kiosks' => $k,
            'activeClosures' => (int)Db::val('SELECT COUNT(*) FROM closures WHERE starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())'),
            'lastValidation' => $last ? ['id' => (int)$last['id'], 'ok' => (bool)$last['ok'], 'errors' => (int)$last['errors'], 'warnings' => (int)$last['warnings'], 'at' => Util::iso($last['created_at'])] : null,
            'live' => $live, 'revisions' => Revisions::all(),
            'topSearches' => $top('search'), 'zeroSearches' => $top('search_zero'),
            'completeness' => [
                'tenantsNoLogo' => (int)Db::val('SELECT COUNT(*) FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE t.logo_override_media_id IS NULL AND b.logo_media_id IS NULL'),
                'tenantsNoHours' => (int)Db::val("SELECT COUNT(*) FROM tenants WHERE hours_mode='unknown'"),
                'tenantsNotPlaced' => (int)Db::val('SELECT COUNT(*) FROM tenants WHERE node_id IS NULL'),
                'kiosksNoFacing' => (int)Db::val('SELECT COUNT(*) FROM kiosks WHERE facing_deg IS NULL'),
                'floorsNoNorth' => Settings::get('map.northDeg') === null ? (int)Db::val('SELECT COUNT(*) FROM floors WHERE north_deg IS NULL') : 0,
            ],
        ]);
    }
}
