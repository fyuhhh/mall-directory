<?php
declare(strict_types=1);

/** Jadwal (jam operasi) → format snapshot {"1":[["10:00","22:00"]], …, "7":[]} (1=Senin, ISO). */
final class Schedule
{
    private static array $cache = [];
    public const DOW_ID = [1 => 'Sen', 2 => 'Sel', 3 => 'Rab', 4 => 'Kam', 5 => 'Jum', 6 => 'Sab', 7 => 'Min'];

    public static function flush(): void { self::$cache = []; }

    public static function t(string $time): string
    {
        $t = substr($time, 0, 5);
        return ($time >= '23:59:00') ? '24:00' : $t;
    }

    /** baris (dow, open_time, close_time) → hours map lengkap 7 hari */
    public static function fromRules(array $rows): array
    {
        $h = [];
        for ($d = 1; $d <= 7; $d++) $h[(string)$d] = [];
        foreach ($rows as $r) $h[(string)(int)$r['dow']][] = [self::t((string)$r['open_time']), self::t((string)$r['close_time'])];
        foreach ($h as &$iv) usort($iv, fn($a, $b) => strcmp($a[0], $b[0]));
        return $h;
    }

    public static function hours(?int $scheduleId): ?array
    {
        if (!$scheduleId) return null;
        if (!array_key_exists($scheduleId, self::$cache)) {
            $rows = Db::all('SELECT dow, open_time, close_time FROM schedule_rules WHERE schedule_id=? ORDER BY dow, open_time', [$scheduleId]);
            self::$cache[$scheduleId] = Db::val('SELECT id FROM schedules WHERE id=?', [$scheduleId]) ? self::fromRules($rows) : null;
        }
        return self::$cache[$scheduleId];
    }

    public static function mallHours(): array
    {
        $h = Settings::get('mall.hours');
        $out = [];
        for ($d = 1; $d <= 7; $d++) $out[(string)$d] = is_array($h) && isset($h[(string)$d]) ? array_values($h[(string)$d]) : [];
        return $out;
    }

    public static function toMin(string $s): int { $p = explode(':', $s); return (int)$p[0] * 60 + (int)($p[1] ?? 0); }

    /** Sama dengan inHours() di js/route.js (§5.7). $ts = unix time (zona server = WITA). */
    public static function isOpen(array $hours, int $ts): bool
    {
        $dow = (int)date('N', $ts);
        $m = (int)date('G', $ts) * 60 + (int)date('i', $ts);
        foreach ($hours[(string)$dow] ?? [] as $iv) {
            $a = self::toMin($iv[0]); $b = self::toMin($iv[1]);
            if ($b > $a ? ($m >= $a && $m < $b) : ($m >= $a || $m < $b)) return true;
        }
        return false;
    }

    /** true bila $inner menutup (tidak buka) di suatu menit saat $outer buka (sampling 15 menit). */
    public static function hasGap(array $inner, array $outer): bool
    {
        $base = strtotime('monday this week 00:00');
        for ($d = 0; $d < 7; $d++) {
            for ($m = 0; $m < 1440; $m += 15) {
                $ts = $base + $d * 86400 + $m * 60;
                if (self::isOpen($outer, $ts) && !self::isOpen($inner, $ts)) return true;
            }
        }
        return false;
    }

    /** Teks tampilan tenant: "10:00–22:00" atau "Sen–Jum 10:00–22:00 · Sab–Min 10:00–23:00". */
    public static function display(?array $week): ?string
    {
        if (!$week) return null;
        $fmt = function (array $iv): string {
            if (!$iv) return 'Tutup';
            return implode(', ', array_map(fn($x) => $x[0] . '–' . $x[1], $iv));
        };
        $groups = [];
        for ($d = 1; $d <= 7; $d++) {
            $s = $fmt($week[(string)$d] ?? []);
            $last = count($groups) - 1;
            if ($last >= 0 && $groups[$last]['s'] === $s) $groups[$last]['to'] = $d;
            else $groups[] = ['from' => $d, 'to' => $d, 's' => $s];
        }
        if (count($groups) === 1) return $groups[0]['s'] === 'Tutup' ? null : $groups[0]['s'];
        return implode(' · ', array_map(function ($g) {
            $lbl = self::DOW_ID[$g['from']] . ($g['to'] !== $g['from'] ? '–' . self::DOW_ID[$g['to']] : '');
            return $lbl . ' ' . $g['s'];
        }, $groups));
    }
}
