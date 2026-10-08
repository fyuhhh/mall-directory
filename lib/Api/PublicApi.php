<?php
declare(strict_types=1);

/** Endpoint publik & kiosk (§4.4): version, snapshot passthrough, health, ping/ack, telemetri. */
final class PublicApi
{
    public const KIOSK_EVENTS = ['session_start', 'session_end', 'search', 'category_open', 'az_open', 'tenant_view', 'route', 'route_fail',
        'amenity_route', 'qr_shown', 'promo_imp', 'promo_tap', 'lang_switch', 'floor_switch', 'error', 'perf_switch'];
    public const PHONE_EVENTS = ['qr_scan', 'nav_start', 'compass_on', 'compass_denied', 'arrived', 'abandon'];

    public static function register(Router $r): void
    {
        $r->get('/version', [self::class, 'version']);
        $r->get('/directory.json', fn() => self::snapshot('directory'));
        $r->get('/promos.json', fn() => self::snapshot('promos'));
        $r->get('/status.json', fn() => self::snapshot('status'));
        $r->get('/health', [self::class, 'health']);
        $r->post('/kiosk/ping', [self::class, 'ping']);
        $r->post('/kiosk/ack', [self::class, 'ack']);
        $r->post('/telemetry', [self::class, 'telemetry']);
        $r->post('/telemetry/phone', [self::class, 'phone']);
    }

    public static function version(): void
    {
        RateLimit::enforce('version:ip:' . Http::clientIp(), 120, 60);
        $f = APP_ROOT . '/data/version.json';
        $v = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : Publisher::versionInfo();
        $v['serverTime'] = Util::nowIso();
        Http::json($v);
    }

    public static function snapshot(string $channel): void
    {
        $file = Publisher::CHANNELS[$channel][1];
        $v = Http::q('v');
        if ($v !== null && $v !== '') {
            if (!preg_match('/^[DPS]\d{4,}-\d{12}$/', $v)) throw ApiError::validation(['v' => 'format']);
            $path = APP_ROOT . '/data/releases/' . $v . '/' . $file;
            Http::file($path, 'application/json; charset=utf-8', null, 'public, max-age=31536000, immutable');
            return;
        }
        $live = Publisher::live($channel);
        Http::file(APP_ROOT . '/data/' . $file, 'application/json; charset=utf-8', $live['sha256'] ?? null, 'no-cache');
    }

    public static function health(): void
    {
        $ip = Http::clientIp();
        $allow = Settings::get('health.allowCidr', ['127.0.0.0/8', '::1/128']);
        $ok = false;
        foreach ((array)$allow as $c) if (Util::ipInCidr($ip, (string)$c)) { $ok = true; break; }
        if (!$ok) throw ApiError::forbidden('Health hanya untuk LAN');
        $db = true;
        try { Db::val('SELECT 1'); } catch (Throwable $e) { $db = false; }
        $live = [];
        if ($db) foreach (array_keys(Publisher::CHANNELS) as $ch) { $l = Publisher::live($ch); $live[$ch] = $l['version'] ?? null; }
        Http::json(['ok' => $db, 'db' => $db, 'disk_free_mb' => (int)(@disk_free_space(APP_ROOT) / 1048576), 'live' => $live, 'serverTime' => Util::nowIso()]);
    }

    // ---------------------------------------------------------------- kiosk auth
    public static function kioskAuth(): array
    {
        $id = Http::header('X-Kiosk-Id') ?? '';
        $key = Http::header('X-Kiosk-Key') ?? '';
        if ($id === '' || $key === '') throw new ApiError('unauthenticated', 'Kiosk belum diprovisioning (X-Kiosk-Id/X-Kiosk-Key)');
        $k = Db::one('SELECT * FROM kiosks WHERE id=?', [$id]);
        if (!$k || !$k['token_hash'] || !(int)$k['is_active'] || !hash_equals((string)$k['token_hash'], hash('sha256', $key)))
            throw new ApiError('unauthenticated', 'Token kiosk tidak valid');
        return $k;
    }

    public static function ping(): void
    {
        $k = self::kioskAuth();
        RateLimit::enforce('ping:kiosk:' . $k['id'], 6, 60);
        $b = Http::body(16384);
        $ver = is_array($b['versions'] ?? null) ? $b['versions'] : [];
        $s = fn($v, int $n) => ($v === null || $v === '') ? null : mb_substr((string)$v, 0, $n);
        $perf = in_array($b['perfActive'] ?? null, ['full', 'lite'], true) ? $b['perfActive'] : null;
        $now = Util::now();
        Db::update('kiosks', [
            'last_seen_at' => $now, 'ip_last' => Http::clientIp(), 'app_build' => $s($b['appBuild'] ?? null, 32),
            'data_version' => $s($ver['directory'] ?? null, 32), 'promos_version' => $s($ver['promos'] ?? null, 32), 'status_version' => $s($ver['status'] ?? null, 32),
            'user_agent' => $s($b['ua'] ?? Http::header('User-Agent'), 400), 'perf_active' => $perf, 'perf_reason' => $s($b['perfReason'] ?? null, 120),
            'sw_active' => isset($b['swActive']) ? (Util::bool($b['swActive']) ? 1 : 0) : null, 'screen' => $s($b['screen'] ?? null, 40),
            'uptime_sec' => isset($b['uptimeSec']) && is_numeric($b['uptimeSec']) ? max(0, min(4294967295, (int)$b['uptimeSec'])) : null,
            'last_error' => $s($b['lastError'] ?? null, 500),
        ], ['id' => $k['id']]);
        Db::exec('INSERT INTO kiosk_heartbeats (kiosk_id, minute, perf_active) VALUES (?,?,?) ON DUPLICATE KEY UPDATE perf_active=VALUES(perf_active)',
            [$k['id'], date('Y-m-d H:i:00'), $perf]);
        $cmds = Db::all('SELECT id, command, payload FROM kiosk_commands WHERE kiosk_id=? AND acked_at IS NULL AND (delivered_at IS NULL OR delivered_at < ?) ORDER BY id LIMIT 10',
            [$k['id'], date('Y-m-d H:i:s', time() - 300)]);
        if ($cmds) Db::exec('UPDATE kiosk_commands SET delivered_at=? WHERE id IN (' . implode(',', array_map(fn($c) => (int)$c['id'], $cmds)) . ')', [$now]);
        $vi = Publisher::versionInfo();
        Http::ok([
            'versions' => ['directory' => $vi['directory'], 'promos' => $vi['promos'], 'status' => $vi['status'], 'minAppBuild' => $vi['minAppBuild']],
            'commands' => array_map(fn($c) => ['id' => (int)$c['id'], 'cmd' => $c['command'], 'payload' => Util::jsonDecode($c['payload'])], $cmds),
            'kiosk' => ['perfMode' => $k['perf_mode'], 'clientType' => $k['client_type'], 'defaultLang' => $k['default_lang'], 'attractLang' => $k['attract_lang']],
            'serverTime' => Util::nowIso(),
        ]);
    }

    public static function ack(): void
    {
        $k = self::kioskAuth();
        $b = Http::body(4096);
        $id = (int)($b['commandId'] ?? 0);
        $n = Db::exec('UPDATE kiosk_commands SET acked_at=?, result=? WHERE id=? AND kiosk_id=?',
            [Util::now(), mb_substr((string)($b['result'] ?? 'ok'), 0, 255), $id, $k['id']]);
        if (!$n) throw ApiError::notFound('Command');
        Http::ok(['commandId' => $id, 'acked' => true]);
    }

    /** ts klien (epoch ms atau ISO) → DATETIME(3) WITA */
    private static function ts($v): string
    {
        if (is_numeric($v)) {
            $ms = (int)$v; $sec = intdiv($ms, 1000);
            if ($sec < time() - 90 * 86400 || $sec > time() + 86400) $sec = time();
            return date('Y-m-d H:i:s', $sec) . '.' . str_pad((string)($ms % 1000), 3, '0', STR_PAD_LEFT);
        }
        $t = is_string($v) ? strtotime($v) : false;
        return date('Y-m-d H:i:s', ($t === false || $t > time() + 86400) ? time() : $t) . '.000';
    }

    private static function eventRow(array $e, string $source, ?string $kioskId, ?string $ipHash): array
    {
        $known = ['ts', 'type', 'sid', 't', 'p', 'q', 'n', 'lang', 'a', 'k'];
        $payload = array_diff_key($e, array_flip($known));
        $val = null;
        foreach (['n', 'ms', 'cost', 'value'] as $vk) if (isset($e[$vk]) && is_numeric($e[$vk])) { $val = (int)max(-2147483648, min(2147483647, (int)$e[$vk])); break; }
        if (($e['type'] ?? '') === 'session_end' && isset($e['ms'])) $val = (int)$e['ms'];
        $s = fn($v, int $n) => ($v === null || $v === '' || !is_scalar($v)) ? null : mb_substr((string)$v, 0, $n);
        $pid = $e['p'] ?? null;
        return [
            $source, $kioskId, $s($e['sid'] ?? null, 12), self::ts($e['ts'] ?? null), (string)$e['type'], $s($e['t'] ?? null, 64),
            is_numeric($pid) ? (int)$pid : null, $s($e['q'] ?? null, 100), $val,
            in_array($e['lang'] ?? null, ['en', 'id'], true) ? $e['lang'] : null,
            isset($e['a']) ? (Util::bool($e['a']) ? 1 : 0) : null, $ipHash,
            $payload ? Util::jsonEncode($payload) : null,
        ];
    }

    private static function insertEvents(array $rows): void
    {
        if (!$rows) return;
        foreach (array_chunk($rows, 200) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '(?,?,?,?,?,?,?,?,?,?,?,?,?)'));
            Db::q('INSERT INTO telemetry_events (source,kiosk_id,session_id,ts,type,tenant_id,promo_id,query,value,lang,`accessible`,ip_hash,payload) VALUES ' . $ph,
                array_merge(...$chunk));
        }
    }

    public static function telemetry(): void
    {
        $k = self::kioskAuth();
        RateLimit::enforce('tele:kiosk:' . $k['id'], 30, 60);
        $b = Http::body(131072);
        $evs = $b['events'] ?? null;
        if (!is_array($evs)) throw ApiError::validation(['events' => 'array']);
        if (count($evs) > 500) throw ApiError::validation(['events' => 'max_500']);
        $rows = []; $rej = 0;
        foreach ($evs as $e) {
            if (!is_array($e) || !in_array($e['type'] ?? null, self::KIOSK_EVENTS, true)) { $rej++; continue; }
            $rows[] = self::eventRow($e, 'kiosk', $k['id'], null);
        }
        self::insertEvents($rows);
        Http::ok(['accepted' => count($rows), 'rejected' => $rej]);
    }

    public static function ipHash(string $ip): string
    {
        $salt = hash('sha256', Config::get('secret') . '|' . date('Y-m-d'));   // salt harian (UU PDP 27/2022)
        return substr(hash('sha256', $salt . $ip), 0, 16);
    }

    public static function phone(): void
    {
        $h = self::ipHash(Http::clientIp());
        RateLimit::enforce('phone:ip:' . $h, 30, 60);
        $raw = Http::rawBody(4096);
        $e = json_decode($raw, true);
        if (!is_array($e) || !in_array($e['type'] ?? null, self::PHONE_EVENTS, true)) throw ApiError::validation(['type' => 'one_of:' . implode('|', self::PHONE_EVENTS)]);
        $kid = isset($e['k']) && is_string($e['k']) && preg_match('/^[a-z0-9-]{1,48}$/', $e['k']) ? $e['k'] : null;
        // session_id = sesi HP (psid); sid kiosk (konversi kiosk→HP) disimpan di payload.ksid
        $psid = isset($e['psid']) && is_string($e['psid']) ? mb_substr($e['psid'], 0, 12) : null;
        if (isset($e['sid']) && is_string($e['sid'])) $e['ksid'] = mb_substr($e['sid'], 0, 12);
        unset($e['psid']);
        $row = self::eventRow($e, 'phone', $kid, $h);
        $row[2] = $psid;
        self::insertEvents([$row]);
        Http::noContent();
    }
}
