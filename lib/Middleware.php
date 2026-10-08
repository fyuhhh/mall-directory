<?php
declare(strict_types=1);

final class Middleware
{
    /** Session + CSRF + izin + rate limit untuk /api/admin/* */
    public static function admin(string $method, array $opts): void
    {
        Http::$isAdmin = true;
        Auth::startSession();
        $write = !in_array($method, ['GET', 'HEAD', 'OPTIONS'], true);
        if (($opts['auth'] ?? true) === false) {
            if ($write) Csrf::checkOrigin();
            return;
        }
        $u = Auth::require();
        if ($write && empty($opts['noCsrf'])) Csrf::check();
        RateLimit::enforce('admin:user:' . $u['id'], 600, 60);
        if (!empty($opts['perm'])) Auth::requirePerm($opts['perm']);
    }
}
