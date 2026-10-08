<?php
declare(strict_types=1);

final class Settings
{
    private static ?array $cache = null;

    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Db::all('SELECT `key`, value FROM settings') as $r) self::$cache[$r['key']] = json_decode((string)$r['value'], true);
        }
        return self::$cache;
    }
    public static function get(string $key, $default = null)
    {
        $a = self::all();
        return array_key_exists($key, $a) && $a[$key] !== null ? $a[$key] : $default;
    }
    public static function set(string $key, $value, ?int $userId = null): void
    {
        Db::exec('INSERT INTO settings (`key`, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=VALUES(value), updated_by=VALUES(updated_by)',
            [$key, Util::jsonEncode($value), $userId]);
        self::$cache = null;
    }
    public static function flush(): void { self::$cache = null; }

    /** Seksi revisi yang terpengaruh perubahan setting. */
    public static function scopeOf(string $key): ?string
    {
        if (preg_match('/^(cost\.|map\.)/', $key)) return 'map';
        if (preg_match('/^(mall\.|kiosk\.|public\.)/', $key)) return 'content';
        return null;
    }
}
