<?php
declare(strict_types=1);

/** Audit log (§2.17): before/after hanya field yang berubah. */
final class Audit
{
    public static function log(string $action, string $entityType, ?string $entityId, ?string $summary, $before = null, $after = null, ?int $userId = -1): void
    {
        if ($userId === -1) $userId = Auth::id();
        [$b, $a] = self::changed($before, $after);
        Db::insert('audit_log', [
            'user_id' => $userId,
            'ip' => PHP_SAPI === 'cli' && empty($_SERVER['REMOTE_ADDR']) ? 'cli' : Http::clientIp(),
            'action' => substr($action, 0, 40),
            'entity_type' => substr($entityType, 0, 40),
            'entity_id' => $entityId === null ? null : substr($entityId, 0, 64),
            'summary' => $summary === null ? null : mb_substr($summary, 0, 255),
            'before_json' => $b === null ? null : Util::jsonEncode($b),
            'after_json' => $a === null ? null : Util::jsonEncode($a),
        ]);
    }

    /** Kembalikan [before, after] berisi hanya key yang berbeda (untuk array asosiatif). */
    public static function changed($before, $after): array
    {
        if (!is_array($before) || !is_array($after)) return [$before, $after];
        $b = []; $a = [];
        foreach (array_unique(array_merge(array_keys($before), array_keys($after))) as $k) {
            if (in_array($k, ['updated_at', 'etag', 'password_hash'], true)) continue;
            $bv = $before[$k] ?? null; $av = $after[$k] ?? null;
            if (self::norm($bv) !== self::norm($av)) { $b[$k] = $bv; $a[$k] = $av; }
        }
        return [$b ?: null, $a ?: null];
    }
    private static function norm($v): string { return is_array($v) ? json_encode($v) : (is_float($v) || is_int($v) ? (string)(0 + $v) : (string)$v); }
}
