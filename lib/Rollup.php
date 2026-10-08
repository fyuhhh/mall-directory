<?php
declare(strict_types=1);

/** Rollup harian telemetry_events + kiosk_heartbeats → stats_daily (§2.16). */
final class Rollup
{
    private const EVENT_METRICS = [
        // metric => [source type, kondisi tambahan, ekspresi dim]
        'session' => ['session_start', '', "''"],
        'search' => ['search', '', 'LEFT(LOWER(TRIM(query)),100)'],
        'search_zero' => ['search', 'AND value = 0', 'LEFT(LOWER(TRIM(query)),100)'],
        'tenant_view' => ['tenant_view', '', "COALESCE(tenant_id,'')"],
        'route' => ['route', '', "COALESCE(tenant_id,'')"],
        'route_acc' => ['route', 'AND `accessible` = 1', "COALESCE(tenant_id,'')"],
        'route_fail' => ['route_fail', '', "COALESCE(tenant_id,'')"],
        'amenity_route' => ['amenity_route', '', "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.type')),'')"],
        'qr_shown' => ['qr_shown', '', "COALESCE(tenant_id,'')"],
        'qr_scan' => ['qr_scan', '', "COALESCE(tenant_id,'')"],
        'nav_start' => ['nav_start', '', "COALESCE(tenant_id,'')"],
        'nav_arrived' => ['arrived', '', "COALESCE(tenant_id,'')"],
        'compass_on' => ['compass_on', '', "''"],
        'promo_imp' => ['promo_imp', '', "COALESCE(CAST(promo_id AS CHAR),'')"],
        'promo_tap' => ['promo_tap', '', "COALESCE(CAST(promo_id AS CHAR),'')"],
        'error' => ['error', '', "''"],
    ];

    public static function day(string $day): int
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) throw new InvalidArgumentException('day');
        $from = $day . ' 00:00:00';
        $to = date('Y-m-d 00:00:00', strtotime($day . ' +1 day'));
        return Db::tx(function () use ($day, $from, $to) {
            Db::exec('DELETE FROM stats_daily WHERE day=?', [$day]);
            $n = 0;
            foreach (self::EVENT_METRICS as $metric => [$type, $cond, $dim]) {
                $n += Db::exec("INSERT INTO stats_daily (day, kiosk_id, metric, dim, value)
                    SELECT ?, COALESCE(kiosk_id,'-'), ?, $dim d, COUNT(*) FROM telemetry_events
                    WHERE type=? AND ts >= ? AND ts < ? $cond GROUP BY COALESCE(kiosk_id,'-'), d", [$day, $metric, $type, $from, $to]);
            }
            $n += Db::exec("INSERT INTO stats_daily (day, kiosk_id, metric, dim, value)
                SELECT ?, kiosk_id, 'uptime_min', '', COUNT(*) FROM kiosk_heartbeats WHERE minute >= ? AND minute < ? GROUP BY kiosk_id", [$day, $from, $to]);
            return $n;
        });
    }

    /** Hapus data mentah lama (retensi). */
    public static function retention(): array
    {
        $raw = (int)Settings::get('retention.rawDays', 180);
        $hb = (int)Settings::get('retention.heartbeatDays', 30);
        $aud = (int)Settings::get('retention.auditDays', 730);
        return [
            'telemetry' => Db::exec('DELETE FROM telemetry_events WHERE ts < ?', [date('Y-m-d', strtotime("-$raw days"))]),
            'heartbeats' => Db::exec('DELETE FROM kiosk_heartbeats WHERE minute < ?', [date('Y-m-d', strtotime("-$hb days"))]),
            'audit' => Db::exec('DELETE FROM audit_log WHERE ts < ?', [date('Y-m-d', strtotime("-$aud days"))]),
            'loginAttempts' => Db::exec('DELETE FROM login_attempts WHERE created_at < ?', [date('Y-m-d', strtotime('-90 days'))]),
            'rateLimits' => RateLimit::cleanup(),
            'commands' => Db::exec('DELETE FROM kiosk_commands WHERE created_at < ?', [date('Y-m-d', strtotime('-90 days'))]),
            'tmpUploads' => self::cleanTmp(),
        ];
    }

    private static function cleanTmp(): int
    {
        $n = 0;
        foreach (glob(APP_ROOT . '/media/tmp/*') ?: [] as $f) if (is_file($f) && filemtime($f) < time() - 86400) { @unlink($f); $n++; }
        return $n;
    }
}
