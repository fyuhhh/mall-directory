<?php
/**
 * cron.php — tugas terjadwal (§8.4).
 *   php tools/cron.php            tiap 5 menit: rollup analitik hari ini, sinkron status.json (closure/notice mulai/berakhir), bersihkan rate_limits
 *   php tools/cron.php --daily    02:00: rollup final kemarin, retensi (raw 180 hari, heartbeat 30 hari, audit 2 thn), republish promos bila isi berubah
 *   php tools/cron.php --backup   02:30: jalankan tools/backup.sh / backup.ps1
 * Windows Task Scheduler: "C:\xampp\php\php.exe" C:\xampp\htdocs\bsb-directory\tools\cron.php
 * crontab: (titik-bintang)/5 * * * * php /path/tools/cron.php ; 0 2 * * * php /path/tools/cron.php --daily ; 30 2 * * * php /path/tools/cron.php --backup
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$args = $argv ?? [];
$lockF = APP_ROOT . '/data/.cron.lock';
$new = !is_file($lockF);
$fh = fopen($lockF, 'c');
if ($new) @chmod($lockF, 0666);
if (!$fh || !flock($fh, LOCK_EX | LOCK_NB)) { echo "cron lain masih berjalan\n"; exit(0); }
$t0 = microtime(true);
$out = [];
try {
    if (in_array('--backup', $args, true)) {
        $win = DIRECTORY_SEPARATOR === '\\';
        $cmd = $win ? 'powershell -NoProfile -ExecutionPolicy Bypass -File ' . escapeshellarg(__DIR__ . '/backup.ps1') : 'sh ' . escapeshellarg(__DIR__ . '/backup.sh');
        passthru($cmd, $rc);
        Audit::log('backup', 'system', null, 'backup terjadwal rc=' . $rc, null, null, null);
        exit($rc);
    }
    // status.json: closure/notice yang mulai/berakhir sejak publish terakhir
    $rel = Publisher::publishStatus('cron: sinkron jadwal closure/notice', true);
    $out[] = 'status: ' . ($rel ? 'republish ' . $rel['version'] : 'tidak berubah');
    $out[] = 'rollup hari ini: ' . Rollup::day(date('Y-m-d')) . ' baris';
    if ((int)date('G') === 0 && (int)date('i') < 15) $out[] = 'rollup kemarin: ' . Rollup::day(date('Y-m-d', strtotime('-1 day'))) . ' baris';
    $out[] = 'rate_limits dibersihkan: ' . RateLimit::cleanup();
    if (in_array('--daily', $args, true)) {
        $out[] = 'rollup final kemarin: ' . Rollup::day(date('Y-m-d', strtotime('-1 day'))) . ' baris';
        $out[] = 'retensi: ' . json_encode(Rollup::retention());
        // promos.json: buang promo/event yang sudah lewat (hanya bila isi berubah)
        $live = Publisher::liveJson('promos');
        $cand = Snapshot::promos();
        $strip = fn($j) => json_encode(array_diff_key(json_decode(json_encode($j), true), ['version' => 1, 'generated' => 1]));
        if (!$live || $strip($live) !== $strip($cand)) {
            $liveRev = Util::jsonDecode(Publisher::live('promos')['revs'] ?? null, []) ?: [];
            // hanya kedaluwarsa (bukan perubahan draft marketing yang belum dipublish)
            if ((int)($liveRev['promos'] ?? -1) === Revisions::get('promos')) { $p = Publisher::publishPromos('cron: buang promo kedaluwarsa'); $out[] = 'promos: republish ' . $p['version']; }
            else $out[] = 'promos: ada draft belum dipublish — tidak dipublish otomatis';
        }
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'cron error: ' . $e->getMessage() . "\n");
    exit(1);
} finally {
    flock($fh, LOCK_UN); fclose($fh);
}
echo '[' . date('c') . '] ' . implode(' | ', $out) . sprintf(' (%d ms)', (microtime(true) - $t0) * 1000) . "\n";
