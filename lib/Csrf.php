<?php
declare(strict_types=1);

/** Synchronizer token + cek Origin/Referer (§4.2). */
final class Csrf
{
    public static function token(): string
    {
        Auth::startSession();
        if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = Util::b64url(random_bytes(32));
        return (string)$_SESSION['csrf'];
    }

    public static function checkOrigin(): void
    {
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        foreach (['Origin', 'Referer'] as $h) {
            $v = Http::header($h);
            if ($v === null || $v === '' || $v === 'null') continue;
            $vh = strtolower((string)parse_url($v, PHP_URL_HOST));
            $vp = parse_url($v, PHP_URL_PORT);
            if ($vp) $vh .= ':' . $vp;
            if ($host === '' || $vh !== $host) throw ApiError::forbidden('Origin tidak diizinkan');
            return; // Origin sudah diperiksa; Referer tidak perlu
        }
    }

    public static function check(): void
    {
        self::checkOrigin();
        $sent = Http::header('X-CSRF-Token') ?? '';
        $tok = $_SESSION['csrf'] ?? '';
        if ($tok === '' || $sent === '' || !hash_equals((string)$tok, $sent)) {
            throw ApiError::forbidden('Token CSRF tidak valid — muat ulang halaman');
        }
    }
}
