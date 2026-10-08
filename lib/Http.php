<?php
declare(strict_types=1);

/** Respons JSON, pembacaan input, header keamanan. */
final class Http
{
    private static ?array $body = null;
    public static bool $isAdmin = false;
    /** Untuk uji in-process (smoke test) — bila diset, respons tidak di-echo. */
    public static ?array $captured = null;

    public static function method(): string { return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'); }

    public static function header(string $name): ?string
    {
        $k = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $v = $_SERVER[$k] ?? null;
        if ($v === null && strcasecmp($name, 'Content-Type') === 0) $v = $_SERVER['CONTENT_TYPE'] ?? null;
        if ($v === null && strcasecmp($name, 'Content-Length') === 0) $v = $_SERVER['CONTENT_LENGTH'] ?? null;
        return $v === null ? null : (string)$v;
    }

    public static function clientIp(): string
    {
        if (Config::get('trustProxy')) {
            $cf = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? null;
            if ($cf && filter_var($cf, FILTER_VALIDATE_IP)) return $cf;
            $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null;
            if ($xff) { $ip = trim(explode(',', $xff)[0]); if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip; }
        }
        return (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public static function rawBody(int $maxBytes = 2_000_000): string
    {
        $len = (int)(self::header('Content-Length') ?? 0);
        if ($len > $maxBytes) throw new ApiError('too_large', 'Body terlalu besar');
        $raw = $GLOBALS['__BSB_TEST_BODY'] ?? file_get_contents('php://input', false, null, 0, $maxBytes + 1);
        if (strlen((string)$raw) > $maxBytes) throw new ApiError('too_large', 'Body terlalu besar');
        return (string)$raw;
    }

    /** Body JSON (objek). Form POST juga diterima sebagai fallback. */
    public static function body(int $maxBytes = 2_000_000): array
    {
        if (self::$body !== null) return self::$body;
        $ct = strtolower(self::header('Content-Type') ?? '');
        if (str_contains($ct, 'multipart/form-data') || str_contains($ct, 'application/x-www-form-urlencoded')) {
            return self::$body = $_POST;
        }
        $raw = self::rawBody($maxBytes);
        if (trim($raw) === '') return self::$body = [];
        $d = json_decode($raw, true);
        if (!is_array($d)) throw new ApiError('bad_request', 'Body harus JSON objek');
        return self::$body = $d;
    }
    public static function resetBody(): void { self::$body = null; }

    public static function q(string $k, $default = null)
    {
        $v = $_GET[$k] ?? $default;
        return is_string($v) ? trim($v) : $v;
    }

    public static function securityHeaders(): void
    {
        if (headers_sent()) return;
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        if (self::$isAdmin) {
            header('X-Frame-Options: DENY');
            header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
        }
    }

    public static function json($payload, int $status = 200, array $headers = []): void
    {
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE);
        if (self::$captured !== null) { self::$captured = ['status' => $status, 'body' => $payload, 'headers' => $headers]; return; }
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            if (!isset($headers['Cache-Control'])) header('Cache-Control: no-store');
            foreach ($headers as $k => $v) header($k . ': ' . $v);
            self::securityHeaders();
        }
        echo $body;
    }

    public static function ok($data, int $status = 200, array $extra = []): void
    {
        self::json(array_merge(['data' => $data], $extra), $status);
    }

    public static function noContent(): void
    {
        if (self::$captured !== null) { self::$captured = ['status' => 204, 'body' => null, 'headers' => []]; return; }
        http_response_code(204);
        header('Cache-Control: no-store');
        self::securityHeaders();
    }

    public static function error(ApiError $e): void
    {
        $err = ['code' => $e->errCode, 'message' => $e->getMessage()];
        if ($e->fields) $err['fields'] = $e->fields;
        if ($e->details) $err['details'] = $e->details;
        self::json(['error' => $err], $e->status);
    }

    /** Kirim file statis (passthrough) dengan ETag & 304. */
    public static function file(string $path, string $mime, ?string $etag, string $cacheControl): void
    {
        if (!is_file($path)) throw ApiError::notFound('File');
        $etag = $etag ?? hash_file('sha256', $path);
        $inm = self::header('If-None-Match');
        if (self::$captured !== null) {
            self::$captured = ['status' => ($inm && trim($inm, '"W/ ') === $etag) ? 304 : 200, 'body' => null, 'headers' => ['ETag' => '"' . $etag . '"'], 'file' => $path];
            return;
        }
        header('ETag: "' . $etag . '"');
        header('Cache-Control: ' . $cacheControl);
        header('X-Content-Type-Options: nosniff');
        if ($inm !== null && trim(str_replace('W/', '', $inm), '" ') === $etag) { http_response_code(304); return; }
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($path));
        readfile($path);
    }
}
