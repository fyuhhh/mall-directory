<?php
declare(strict_types=1);

/**
 * Publish 3 kanal (§2.14, §5.1): directory (D…), promos (P…), status (S…).
 * Tulis arsip data/releases/<version>/<file>, lalu ganti atomik data/<file>, lalu data/version.json — di dalam flock.
 */
final class Publisher
{
    public const CHANNELS = ['directory' => ['D', 'directory.json'], 'promos' => ['P', 'promos.json'], 'status' => ['S', 'status.json']];
    private static $lockFh = null;
    private static int $lockDepth = 0;

    public static function lock(callable $fn)
    {
        if (self::$lockDepth === 0) {
            $p = APP_ROOT . '/data/.publish.lock';
            $new = !is_file($p);
            self::$lockFh = fopen($p, 'c');
            if (!self::$lockFh) throw new ApiError('server', 'Tidak bisa membuka lock publish');
            if ($new) @chmod($p, 0666);
            if (!flock(self::$lockFh, LOCK_EX)) throw new ApiError('server', 'Gagal mengunci publish');
        }
        self::$lockDepth++;
        try { return $fn(); }
        finally {
            self::$lockDepth--;
            if (self::$lockDepth === 0) { flock(self::$lockFh, LOCK_UN); fclose(self::$lockFh); self::$lockFh = null; }
        }
    }

    public static function live(string $channel): ?array
    {
        return Db::one('SELECT * FROM releases WHERE channel=? AND is_live=1 ORDER BY id DESC LIMIT 1', [$channel]);
    }

    public static function liveJson(string $channel): ?array
    {
        $f = APP_ROOT . '/data/' . self::CHANNELS[$channel][1];
        if (!is_file($f)) return null;
        $d = json_decode((string)file_get_contents($f), true);
        return is_array($d) ? $d : null;
    }

    private static function nextVersion(string $channel): array
    {
        $seq = (int)Db::val('SELECT COALESCE(MAX(seq),0) FROM releases WHERE channel=?', [$channel]) + 1;
        return [$seq, self::CHANNELS[$channel][0] . str_pad((string)$seq, 4, '0', STR_PAD_LEFT) . '-' . date('YmdHi')];
    }

    /** Tulis rilis + live + catat DB. $mutate dipanggil untuk menyisipkan versi ke JSON. */
    private static function write(string $channel, array $json, array $row): array
    {
        [$seq, $version] = self::nextVersion($channel);
        $file = self::CHANNELS[$channel][1];
        $now = Util::nowIso();
        if ($channel === 'directory') { $json['meta']['version'] = $version; $json['meta']['publishedAt'] = $now; }
        else { $json['version'] = $version; $json['generated'] = $now; }
        $body = Util::jsonEncode($json);
        $relPath = 'data/releases/' . $version . '/' . $file;
        Util::atomicWrite(APP_ROOT . '/' . $relPath, $body);
        Util::atomicWrite(APP_ROOT . '/data/' . $file, $body);
        $sha = hash('sha256', $body);
        $id = Db::tx(function () use ($channel, $version, $seq, $sha, $body, $relPath, $row) {
            Db::exec('UPDATE releases SET is_live=0 WHERE channel=? AND is_live=1', [$channel]);
            return Db::insert('releases', array_merge([
                'channel' => $channel, 'version' => $version, 'seq' => $seq, 'sha256' => $sha, 'bytes' => strlen($body),
                'path' => $relPath, 'is_live' => 1, 'created_by' => Auth::id(),
            ], $row));
        });
        self::writeVersionJson();
        return ['id' => $id, 'version' => $version, 'sha256' => $sha, 'bytes' => strlen($body), 'path' => $relPath, 'publishedAt' => $now];
    }

    public static function versionInfo(): array
    {
        $out = [];
        foreach (self::CHANNELS as $ch => [$p, $file]) {
            $r = self::live($ch);
            $out[$ch] = $r ? ['version' => $r['version'], 'sha256' => $r['sha256'], 'url' => 'data/' . $file . '?v=' . $r['version'],
                'publishedAt' => Util::iso($r['created_at'])] : null;
        }
        $out['minAppBuild'] = Settings::get('kiosk.minAppBuild', '2026.10.1');
        return $out;
    }

    public static function writeVersionJson(): void
    {
        Util::atomicWrite(APP_ROOT . '/data/version.json', Util::jsonEncode(self::versionInfo(), true));
    }

    // ------------------------------------------------------------ directory
    /** Kandidat + validasi + diff (tanpa menulis rilis). */
    public static function preview(): array
    {
        [$cand, $aux] = Snapshot::directory();
        $status = self::liveJson('status');
        $report = Validator::run($cand, $aux, ['status' => $status, 'checkMedia' => true]);
        $live = self::liveJson('directory');
        $diff = Diff::directory($live, $cand, $aux['spurNodes']);
        [$seq, $ver] = self::nextVersion('directory');
        return ['candidate' => $cand, 'aux' => $aux, 'validation' => $report, 'diff' => $diff, 'candidateVersion' => $ver];
    }

    /** Pemblokir izin per seksi (§1.3). */
    public static function blockers(array $sections, ?array $user): array
    {
        $b = [];
        if (!$user) return ['Belum login'];
        $live = self::live('directory');
        foreach ($sections as $s) {
            $perm = 'publish.' . $s;
            if (Permissions::has($user['role'], $perm)) continue;
            $who = self::lastEditor($s, $live ? (string)$live['created_at'] : null);
            $b[] = "Butuh izin $perm" . ($who ? " (perubahan oleh {$who['name']}, " . date('j M H:i', strtotime($who['ts'])) . ')' : '');
        }
        return $b;
    }

    public static function lastEditor(string $scope, ?string $since): ?array
    {
        $types = $scope === 'map'
            ? ['floor', 'graph', 'connector_bank', 'connector_stop', 'connector_leg', 'kiosk', 'amenity', 'amenity_type', 'schedule']
            : ['tenant', 'brand', 'category', 'i18n', 'setting'];
        $in = implode(',', array_fill(0, count($types), '?'));
        $p = $types;
        $sql = "SELECT a.ts, u.name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type IN ($in)";
        if ($since) { $sql .= ' AND a.ts >= ?'; $p[] = $since; }
        return Db::one($sql . ' ORDER BY a.id DESC LIMIT 1', $p);
    }

    public static function publishDirectory(string $notes = '', ?array $user = null, bool $skipPermCheck = false): array
    {
        return self::lock(function () use ($notes, $user, $skipPermCheck) {
            $pv = self::preview();
            $vid = Validator::store($pv['validation'], $user ? (int)$user['id'] : null);
            if (!$pv['validation']['ok']) {
                throw new ApiError('validation', 'Validasi gagal: ' . count($pv['validation']['errors']) . ' error', [], ['validation' => $pv['validation'], 'validationRunId' => $vid]);
            }
            if (!$skipPermCheck) {
                $bl = self::blockers($pv['diff']['sectionsChanged'], $user);
                if ($bl) throw new ApiError('forbidden', implode('; ', $bl), [], ['blockers' => $bl, 'sectionsChanged' => $pv['diff']['sectionsChanged']]);
            }
            $v = $pv['validation'];
            $rel = self::write('directory', $pv['candidate'], [
                'revs' => Util::jsonEncode(Revisions::all()),
                'stats' => Util::jsonEncode($v['stats']),
                'diff' => Util::jsonEncode($pv['diff']),
                'validation' => Util::jsonEncode(['ok' => $v['ok'], 'errors' => $v['errors'], 'warningCounts' => $v['stats']['warningCounts'], 'stats' => $v['stats'], 'runId' => $vid]),
                'notes' => $notes !== '' ? mb_substr($notes, 0, 500) : null,
            ]);
            Audit::log('publish', 'release', (string)$rel['id'], 'publish directory ' . $rel['version'] . ($notes ? ': ' . $notes : ''), null,
                ['version' => $rel['version'], 'sections' => $pv['diff']['sectionsChanged'], 'reachable' => $v['stats']['reachable'] . '/' . $v['stats']['pairs']]);
            return $rel + ['diff' => $pv['diff'], 'validation' => ['ok' => true, 'stats' => $v['stats'], 'warningCounts' => $v['stats']['warningCounts']]];
        });
    }

    // ------------------------------------------------------------ promos
    public static function publishPromos(string $notes = ''): array
    {
        return self::lock(function () use ($notes) {
            $json = Snapshot::promos();
            $rel = self::write('promos', $json, ['revs' => Util::jsonEncode(Revisions::all()),
                'stats' => Util::jsonEncode(['promos' => count($json['promos']), 'events' => count($json['events']), 'featured' => count($json['featured'])]),
                'notes' => $notes !== '' ? mb_substr($notes, 0, 500) : null]);
            Audit::log('publish', 'release', (string)$rel['id'], 'publish promos ' . $rel['version'], null, ['version' => $rel['version']]);
            return $rel;
        });
    }

    // ------------------------------------------------------------ status
    /** @param bool $onlyIfChanged true = cron: hanya tulis bila isi berubah */
    public static function publishStatus(string $reason = '', bool $onlyIfChanged = false): ?array
    {
        return self::lock(function () use ($reason, $onlyIfChanged) {
            $json = Snapshot::status();
            if ($onlyIfChanged) {
                $live = self::liveJson('status');
                $strip = fn($j) => json_encode(array_diff_key(json_decode(json_encode($j), true), ['version' => 1, 'generated' => 1]));
                if ($live && $strip($live) === $strip($json)) return null;
            }
            $rel = self::write('status', $json, ['stats' => Util::jsonEncode(['closures' => count($json['closures']), 'edgeOverrides' => count($json['edgeOverrides']),
                'amenityClosures' => count($json['amenityClosures']), 'notice' => $json['notice'] !== null]), 'notes' => $reason ? mb_substr($reason, 0, 500) : null]);
            return $rel;
        });
    }

    // ------------------------------------------------------------ rollback
    public static function rollback(int $releaseId, ?array $user = null): array
    {
        return self::lock(function () use ($releaseId) {
            $r = Db::one('SELECT * FROM releases WHERE id=?', [$releaseId]);
            if (!$r) throw ApiError::notFound('Rilis');
            $abs = APP_ROOT . '/' . $r['path'];
            if (!is_file($abs)) throw new ApiError('server', 'File rilis hilang: ' . $r['path']);
            $json = json_decode((string)file_get_contents($abs), true);
            if (!is_array($json)) throw new ApiError('server', 'File rilis rusak');
            if ($r['channel'] === 'directory') {
                $json['meta']['rolledBackFrom'] = $r['version'];
                // aset yang dirujuk harus masih ada (SVG publish & logo immutable)
                foreach ($json['floors'] as $f) if (!is_file(APP_ROOT . '/' . $f['svg'])) throw new ApiError('conflict', "SVG {$f['svg']} untuk rilis {$r['version']} sudah tidak ada");
            } else {
                $json['rolledBackFrom'] = $r['version'];
            }
            $rel = self::write($r['channel'], $json, ['rolled_back_from' => $r['id'], 'revs' => $r['revs'], 'stats' => $r['stats'],
                'validation' => $r['validation'], 'notes' => 'Rollback ke ' . $r['version']]);
            Audit::log('rollback', 'release', (string)$rel['id'], "rollback {$r['channel']} ke {$r['version']} → {$rel['version']}", null, ['from' => $r['version'], 'to' => $rel['version']]);
            return $rel + ['rolledBackFrom' => $r['version']];
        });
    }
}
