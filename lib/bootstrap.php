<?php
/* Bootstrap bersama untuk API & tools CLI. */
declare(strict_types=1);

if (!defined('APP_ROOT')) define('APP_ROOT', dirname(__DIR__));
date_default_timezone_set('Asia/Makassar');   // D10: WITA, UTC+8
mb_internal_encoding('UTF-8');

spl_autoload_register(function (string $cls): void {
    $cls = str_replace('\\', '/', $cls);
    foreach ([__DIR__ . '/' . $cls . '.php', __DIR__ . '/Api/' . $cls . '.php'] as $f) {
        if (is_file($f)) { require $f; return; }
    }
});

final class Config
{
    private static ?array $c = null;
    public static function all(): array
    {
        if (self::$c === null) self::$c = require APP_ROOT . '/config.php';
        return self::$c;
    }
    public static function get(string $key, $default = null)
    {
        $cur = self::all();
        foreach (explode('.', $key) as $p) {
            if (!is_array($cur) || !array_key_exists($p, $cur)) return $default;
            $cur = $cur[$p];
        }
        return $cur;
    }
}
