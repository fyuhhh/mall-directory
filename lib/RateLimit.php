<?php
declare(strict_types=1);

/** Fixed-window rate limit di tabel rate_limits (§4.3). */
final class RateLimit
{
    public static bool $disabled = false;

    /** @return bool true bila masih di bawah batas */
    public static function hit(string $bucket, int $limit, int $windowSec): bool
    {
        if (self::$disabled) return true;
        $ws = intdiv(time(), $windowSec) * $windowSec;
        $bucket = substr($bucket, 0, 120);
        Db::exec('INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?,?,1) ON DUPLICATE KEY UPDATE hits = hits + 1', [$bucket, $ws]);
        $hits = (int)Db::val('SELECT hits FROM rate_limits WHERE bucket=? AND window_start=?', [$bucket, $ws]);
        return $hits <= $limit;
    }

    public static function enforce(string $bucket, int $limit, int $windowSec): void
    {
        if (!self::hit($bucket, $limit, $windowSec)) {
            if (!headers_sent() && Http::$captured === null) header('Retry-After: ' . $windowSec);
            throw new ApiError('rate_limited', 'Terlalu banyak permintaan, coba lagi nanti', [], ['bucket' => explode(':', $bucket)[0], 'limit' => $limit, 'windowSec' => $windowSec]);
        }
    }

    public static function cleanup(): int
    {
        return Db::exec('DELETE FROM rate_limits WHERE window_start < ?', [time() - 86400]);
    }
}
