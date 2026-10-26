<?php
/*
 * setup.php — siapkan dan periksa instalasi setelah git clone / git pull (XAMPP Windows, macOS, Linux). Lihat CARA_MENJALANKAN.md.
 *
 *   php tools/setup.php check                periksa PHP, ekstensi, config, koneksi & isi database, folder tulis, alamat
 *   php tools/setup.php import [--force]     isi database dari _handoff/db/bsb_directory.sql (data CMS + peta 3D + akun CMS).
 *                                            Database yang sudah berisi dicadangkan dulu ke <nama>_backup_<waktu> (butuh --force).
 *   php tools/setup.php dump [--cpanel] [--out file]
 *        dump database saat ini. Tanpa --out: ke _handoff/db/bsb_directory.sql (dibawa lewat git, untuk import di komputer lain).
 *        --cpanel: tanpa CREATE DATABASE / USE, untuk diimpor lewat phpMyAdmin ke database cPanel yang sudah dibuat.
 *
 * Nama database, user dan password diambil dari config.php / config.local.php, sama seperti aplikasinya. Hanya PHP + pdo_mysql;
 * tidak butuh mysql/mysqldump di PATH. Dump ditulis agar bisa diimpor MariaDB 10.4 (XAMPP) sampai versi terbaru.
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

const DUMP_FILE = '_handoff/db/bsb_directory.sql';
const NO_DATA = ['login_attempts', 'rate_limits']; // isi tidak dibawa: IP & percobaan login perangkat ini
const BATCH = 200000;                                 // panjang maksimum satu INSERT (aman untuk max_allowed_packet 1 MB XAMPP)

$args = array_slice($argv, 1);
$cmd = $args[0] ?? 'help';
$has = fn(string $f): bool => in_array($f, $args, true);
$opt = function (string $k) use ($args): ?string { $i = array_search($k, $args, true); return $i === false ? null : ($args[$i + 1] ?? null); };
$ok = fn(string $m) => print("  ✔ $m\n");
$warn = fn(string $m) => print("  ! $m\n");
$bad = fn(string $m) => print("  ✘ $m\n");

function server(): PDO
{
    $c = Config::get('db');
    $dsn = 'mysql:' . (!empty($c['socket']) ? 'unix_socket=' . $c['socket'] : 'host=' . $c['host'] . ';port=' . (int)$c['port']) . ';charset=utf8mb4';
    $pdo = new PDO($dsn, (string)$c['user'], (string)$c['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec("SET time_zone = '+00:00'"); // TIMESTAMP keluar/masuk apa adanya (UTC), seperti mysqldump
    return $pdo;
}
function q(string $id): string { return '`' . str_replace('`', '``', $id) . '`'; }
function dbExists(PDO $pdo, string $db): bool { return (bool)$pdo->query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=' . $pdo->quote($db))->fetchColumn(); }
function tables(PDO $pdo, string $db): array
{
    return $pdo->query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE=\'BASE TABLE\' AND TABLE_SCHEMA=' . $pdo->quote($db) . ' ORDER BY TABLE_NAME')->fetchAll(PDO::FETCH_COLUMN);
}
function count_rows(PDO $pdo, string $db, string $t): int { return (int)$pdo->query('SELECT COUNT(*) FROM ' . q($db) . '.' . q($t))->fetchColumn(); }
/** [alamat aplikasi, catatan]: di htdocs XAMPP lewat Apache, selain itu server bawaan PHP. */
function web_url(): array
{
    $root = str_replace('\\', '/', APP_ROOT);
    if (preg_match('#/htdocs/(.+)$#i', $root, $m)) return ['http://localhost/' . trim($m[1], '/') . '/', 'XAMPP: Apache dan MySQL menyala di XAMPP Control Panel'];
    return ['http://localhost:8000/', 'jalankan dulu: php -S 127.0.0.1:8000 tools/dev_router.php'];
}

$db = (string)Config::get('db.name');

switch ($cmd) {
// ------------------------------------------------------------------ check
case 'check':
    echo "== PHP\n";
    version_compare(PHP_VERSION, '8.0.0', '>=') ? $ok('PHP ' . PHP_VERSION) : $bad('PHP ' . PHP_VERSION . ' — butuh PHP 8.0 atau lebih baru');
    foreach (['pdo_mysql' => true, 'mbstring' => true, 'json' => true, 'fileinfo' => true, 'gd' => false, 'curl' => false] as $ext => $need) {
        if (extension_loaded($ext)) $ok("ekstensi $ext");
        elseif ($need) $bad("ekstensi $ext belum aktif (php.ini: extension=$ext)");
        else $warn("ekstensi $ext belum aktif (" . ($ext === 'gd' ? 'upload logo ke WebP' : 'smoke_test.php') . ')');
    }
    if (extension_loaded('gd') && empty(gd_info()['WebP Support'])) $warn('GD tanpa WebP: logo diunggah tetap PNG/JPG, atau pasang cwebp');

    echo "== Konfigurasi\n";
    is_file(APP_ROOT . '/config.local.php') ? $ok('config.local.php dipakai (tidak ikut git)') : $ok('config.php bawaan (XAMPP: root tanpa password)');
    $c = Config::get('db');
    $ok('database ' . $db . ' di ' . (!empty($c['socket']) ? $c['socket'] : $c['host'] . ':' . $c['port']) . ', user ' . $c['user']);

    echo "== Database\n";
    try { $pdo = server(); } catch (Throwable $e) { $bad('tidak bisa terhubung: ' . $e->getMessage() . ' — nyalakan MySQL/MariaDB (XAMPP Control Panel) dan cek config'); exit(1); }
    $ok('server ' . $pdo->query('SELECT VERSION()')->fetchColumn());
    if (!dbExists($pdo, $db) || !tables($pdo, $db)) { $bad("database $db belum ada / kosong — jalankan: php tools/setup.php import"); exit(1); }
    $n = []; foreach (['tenants', 'floors', 'graph_nodes', 'amenities', 'kiosks', 'users'] as $t) $n[$t] = count_rows($pdo, $db, $t);
    $ok("isi: {$n['tenants']} tenant, {$n['floors']} lantai, {$n['graph_nodes']} node jalur, {$n['amenities']} fasilitas, {$n['kiosks']} kiosk");
    $users = $pdo->query('SELECT email FROM ' . q($db) . '.users WHERE is_active=1 ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
    $users ? $ok('akun CMS: ' . implode(', ', $users)) : $bad('belum ada akun CMS aktif — jalankan import, atau php tools/create_admin.php');
    // the 3D floors keep CMS coordinates in the drawing's units: the database must be the one made with them
    $reg = Map3d::registry()['floors'] ?? [];
    $miss = [];
    foreach ($reg as $fid => $e) {
        if (($e['frame'] ?? '') !== 'plan' || !($m = Map3d::model($e))) continue;
        $f = $pdo->query('SELECT vb_w, vb_h FROM ' . q($db) . '.floors WHERE id=' . $pdo->quote($fid))->fetch();
        if (!$f || abs((float)$f['vb_w'] - (float)$m['artboard'][2]) > 0.5 || abs((float)$f['vb_h'] - (float)$m['artboard'][3]) > 0.5) $miss[] = $fid;
    }
    $miss ? $bad('lantai 3D belum cocok dengan database (' . implode(', ', $miss) . ') — database masih versi lama: php tools/setup.php import --force')
          : $ok(count($reg) . ' lantai 3D cocok dengan database');

    echo "== Folder yang ditulis aplikasi\n";
    foreach (['data', 'data/releases', 'data/3d/edits', 'media', 'media/floors', 'media/pub/floors', 'media/3d', 'media/logos', 'media/promos'] as $d) {
        $p = APP_ROOT . '/' . $d;
        if (!is_dir($p)) @mkdir($p, 0775, true);
        is_dir($p) && is_writable($p) ? $ok($d) : $bad("$d tidak bisa ditulis oleh PHP");
    }
    is_file(APP_ROOT . '/data/directory.json') ? $ok('data/directory.json ada (snapshot terakhir yang dipublish)') : $warn('data/directory.json belum ada — Publish dari CMS');

    echo "== Alamat\n";
    [$u, $note] = web_url();
    echo "  Kiosk : {$u}?attract=0&kiosk=gf-ewalk-left\n  HP    : {$u}m/?k=gf-ewalk-left&t=sushi-tei-ff-penta&a=0\n  CMS   : {$u}cms/\n  ($note)\n";
    break;

// ------------------------------------------------------------------ import
case 'import':
    $file = APP_ROOT . '/' . ($opt('--file') ?? DUMP_FILE);
    if (!is_file($file)) { fwrite(STDERR, "File dump tidak ada: $file\n"); exit(1); }
    $pdo = server();
    if (dbExists($pdo, $db) && ($ts = tables($pdo, $db))) {
        $rows = in_array('tenants', $ts, true) ? count_rows($pdo, $db, 'tenants') : 0;
        if (!$has('--force')) {
            echo "Database $db sudah berisi " . count($ts) . " tabel ($rows tenant).\n";
            echo "Jalankan lagi dengan --force: isinya dicadangkan dulu ke {$db}_backup_<waktu>, lalu diganti isi dump.\n";
            exit(1);
        }
        $bak = $db . '_backup_' . date('Ymd_His');
        echo "Cadangan: $db → $bak ...\n";
        $pdo->exec('CREATE DATABASE ' . q($bak) . ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach ($ts as $t) {
            $pdo->exec('CREATE TABLE ' . q($bak) . '.' . q($t) . ' LIKE ' . q($db) . '.' . q($t));
            $pdo->exec('INSERT INTO ' . q($bak) . '.' . q($t) . ' SELECT * FROM ' . q($db) . '.' . q($t));
        }
        echo "  " . count($ts) . " tabel dicadangkan (hapus database cadangan itu bila sudah tidak perlu).\n";
    }
    $pdo->exec('CREATE DATABASE IF NOT EXISTS ' . q($db) . ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    $pdo->exec('USE ' . q($db));
    echo "Import " . basename($file) . " → $db ...\n";
    $fh = fopen($file, 'rb'); $buf = ''; $n = 0;
    while (($line = fgets($fh)) !== false) {
        $t = rtrim($line, "\r\n");
        if ($buf === '') {
            if ($t === '' || str_starts_with($t, '--')) continue;
            if (str_starts_with($t, '/*M!999999')) continue;                                   // MariaDB 11+ "sandbox mode": tidak dikenal MariaDB 10.4
            if (preg_match('/^(CREATE DATABASE\b|USE\s+`)/i', $t)) continue;                    // database = config, bukan nama di dump
        }
        $buf .= $line;
        if (str_ends_with(rtrim($t), ';')) {
            $sql = trim($buf); $buf = '';
            $sql = str_replace('utf8mb4_uca1400_ai_ci', 'utf8mb4_unicode_ci', $sql);
            $pdo->exec($sql); $n++;
        }
    }
    fclose($fh);
    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
    echo "  $n perintah SQL dijalankan.\n";
    foreach (['tenants', 'floors', 'graph_nodes', 'graph_edges', 'amenities', 'kiosks', 'users'] as $t) echo "  $t: " . count_rows($pdo, $db, $t) . "\n";
    $users = $pdo->query('SELECT email FROM users WHERE is_active=1 ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
    echo "Selesai. Login CMS: " . implode(', ', $users) . " (password sama dengan komputer asal dump).\n";
    echo "Cek: php tools/setup.php check\n";
    break;

// ------------------------------------------------------------------ dump
case 'dump':
    $cpanel = $has('--cpanel');
    $out = $opt('--out') ?? ($cpanel ? 'bsb_directory_cpanel.sql' : DUMP_FILE);
    $path = preg_match('#^([A-Za-z]:)?[\\\\/]#', $out) ? $out : APP_ROOT . '/' . $out;
    $pdo = server();
    if (!dbExists($pdo, $db)) { fwrite(STDERR, "Database $db tidak ada\n"); exit(1); }
    $pdo->exec('USE ' . q($db));
    if (!is_dir(dirname($path)) && !@mkdir(dirname($path), 0775, true)) { fwrite(STDERR, 'Folder tidak bisa dibuat: ' . dirname($path) . "\n"); exit(1); }
    $tmp = $path . '.tmp';
    $fh = @fopen($tmp, 'wb');
    if (!$fh) { fwrite(STDERR, "Tidak bisa menulis $tmp\n"); exit(1); }
    $w = function (string $s) use ($fh) { fwrite($fh, $s . "\n"); };
    $w('-- BSB Directory — dump database ' . $db . ' (tools/setup.php dump' . ($cpanel ? ' --cpanel' : '') . ')');
    $w('-- Dibuat: ' . date('Y-m-d H:i:s') . ' · server ' . $pdo->query('SELECT VERSION()')->fetchColumn());
    $w($cpanel ? '-- Impor lewat phpMyAdmin ke database yang sudah dibuat di cPanel (pilih databasenya dulu, lalu Import).'
               : '-- Impor: php tools/setup.php import  (atau: mysql -uroot < ' . DUMP_FILE . ')');
    $w('-- Berisi hash password akun CMS (bukan password-nya). Tabel ' . implode(', ', NO_DATA) . ' tanpa isi.');
    $w('');
    $w('/*!40101 SET NAMES utf8mb4 */;');
    $w("/*!40103 SET TIME_ZONE='+00:00' */;");
    $w('/*!40014 SET UNIQUE_CHECKS=0 */;');
    $w('/*!40014 SET FOREIGN_KEY_CHECKS=0 */;');
    $w("/*!40101 SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;");
    $w('');
    if (!$cpanel) {
        $w('CREATE DATABASE /*!32312 IF NOT EXISTS*/ ' . q($db) . ' /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;');
        $w('');
        $w('USE ' . q($db) . ';');
        $w('');
    }
    $totalRows = 0; $ts = tables($pdo, $db);
    foreach ($ts as $t) {
        $create = $pdo->query('SHOW CREATE TABLE ' . q($t))->fetch(PDO::FETCH_NUM)[1];
        $create = str_replace('utf8mb4_uca1400_ai_ci', 'utf8mb4_unicode_ci', $create);
        $w('--');
        $w('-- Table ' . $t);
        $w('--');
        $w('DROP TABLE IF EXISTS ' . q($t) . ';');
        $w($create . ';');
        if (in_array($t, NO_DATA, true)) { $w(''); continue; }
        $cols = null; $vals = []; $len = 0;
        $flush = function () use (&$vals, &$len, &$cols, $w, $t) {
            if ($vals) $w('INSERT INTO ' . q($t) . ' (' . implode(',', array_map('q', $cols)) . ') VALUES ' . implode(',', $vals) . ';');
            $vals = []; $len = 0;
        };
        $st = $pdo->query('SELECT * FROM ' . q($t));
        while ($r = $st->fetch()) {
            $cols ??= array_keys($r);
            $v = '(' . implode(',', array_map(fn($x) => $x === null ? 'NULL' : $pdo->quote((string)$x), array_values($r))) . ')';
            if ($len + strlen($v) > BATCH) $flush();
            $vals[] = $v; $len += strlen($v) + 1; $totalRows++;
        }
        $flush();
        $w('');
    }
    $w('/*!40014 SET FOREIGN_KEY_CHECKS=1 */;');
    $w('/*!40014 SET UNIQUE_CHECKS=1 */;');
    $w('-- Dump completed ' . date('Y-m-d H:i:s'));
    fclose($fh);
    rename($tmp, $path);
    echo count($ts) . " tabel, $totalRows baris → " . (str_starts_with($path, APP_ROOT) ? substr($path, strlen(APP_ROOT) + 1) : $path) . ' (' . number_format(filesize($path) / 1048576, 1) . " MB)\n";
    if (!$cpanel) echo "Commit file itu bersama perubahannya; di komputer lain: php tools/setup.php import\n";
    break;

default:
    echo "Pakai: php tools/setup.php check | import [--force] [--file dump.sql] | dump [--cpanel] [--out file]\n";
}
