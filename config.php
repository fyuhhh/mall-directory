<?php
/*
 * BSB Directory CMS — konfigurasi server (WP-A).
 * File ini TIDAK boleh diakses dari web (lihat .htaccess root: <Files config.php> deny).
 * Produksi: salin ke config.local.php (juga di-deny) dan ubah kredensial; config.local.php menang bila ada.
 */
if (!defined('BSB_CONFIG_LOADED')) define('BSB_CONFIG_LOADED', 1);

$cfg = [
    'db' => [
        'host'   => 'localhost',
        'port'   => 3306,
        'socket' => null,              // null = default php.ini (XAMPP mac: /Applications/XAMPP/xamppfiles/var/mysql/mysql.sock)
        'name'   => 'bsb_directory',
        'user'   => 'root',
        'pass'   => '',
    ],
    // binari eksternal (fallback bila settings.media.cwebpPath kosong)
    'cwebp'     => '/opt/homebrew/bin/cwebp',
    'mysqldump' => '/Applications/XAMPP/xamppfiles/bin/mysqldump',
    // rahasia untuk salt hash IP HP (UU PDP): ganti di produksi
    'secret'    => 'dev-only-change-me-7f3c9a1e',
    // null = otomatis (Secure bila HTTPS). Set true di belakang Cloudflare Tunnel bila perlu.
    'cookieSecure' => null,
    // percayai X-Forwarded-For / CF-Connecting-IP hanya bila server di belakang proxy tepercaya
    'trustProxy' => false,
    // izin file baru yang ditulis publisher (dev mac: Apache=daemon, CLI=user → 0666/0777)
    'fileMode' => 0666,
    'dirMode'  => 0777,
];

$local = __DIR__ . '/config.local.php';
if (is_file($local)) {
    $over = require $local;
    if (is_array($over)) $cfg = array_replace_recursive($cfg, $over);
}
return $cfg;
