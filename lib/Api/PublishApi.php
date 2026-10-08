<?php
declare(strict_types=1);

/** Validasi, pratinjau diff, publish, riwayat rilis, rollback (§2.14, §4.5 Publish). */
final class PublishApi
{
    public static function register(Router $r): void
    {
        $r->post('/admin/validate', [self::class, 'validate'], ['admin' => true]);
        $r->get('/admin/validation-runs', [self::class, 'runs'], ['admin' => true]);
        $r->get('/admin/validate/last', [self::class, 'last'], ['admin' => true]);
        $r->get('/admin/publish/preview', [self::class, 'preview'], ['admin' => true]);
        $r->post('/admin/publish', [self::class, 'publish'], ['admin' => true, 'perm' => ['publish.content', 'publish.map', 'publish.promos']]);
        $r->get('/admin/releases', [self::class, 'list'], ['admin' => true]);
        $r->get('/admin/releases/{id}', [self::class, 'get'], ['admin' => true]);
        $r->get('/admin/releases/{id}/download', [self::class, 'download'], ['admin' => true]);
        $r->post('/admin/releases/{id}/rollback', [self::class, 'rollback'], ['admin' => true, 'perm' => 'releases.rollback']);
    }

    public static function validate(): void
    {
        [$D, $aux] = Snapshot::directory();
        $rep = Validator::run($D, $aux, ['status' => Publisher::liveJson('status'), 'checkMedia' => true]);
        $rep['runId'] = Validator::store($rep, Auth::id());
        $rep['revisions'] = Revisions::all();
        Http::ok($rep);
    }

    public static function last(): void
    {
        $r = Db::one('SELECT v.*, u.name FROM validation_runs v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.id DESC LIMIT 1');
        if (!$r) { Http::ok(null); return; }
        Http::ok((Util::jsonDecode($r['report'], []) ?: []) + ['runId' => (int)$r['id'], 'ranAt' => Util::iso($r['created_at']), 'by' => $r['name'], 'revisions' => Util::jsonDecode($r['revs'])]);
    }

    public static function runs(): void
    {
        $rows = Db::all('SELECT v.id, v.ok, v.errors, v.warnings, v.ms, v.revs, v.created_at, u.name FROM validation_runs v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.id DESC LIMIT 20');
        Http::json(['data' => array_map(fn($r) => ['id' => (int)$r['id'], 'ok' => (bool)$r['ok'], 'errors' => (int)$r['errors'], 'warnings' => (int)$r['warnings'], 'ms' => (int)$r['ms'],
            'revisions' => Util::jsonDecode($r['revs']), 'createdAt' => Util::iso($r['created_at']), 'by' => $r['name']], $rows), 'total' => count($rows)]);
    }

    public static function preview(): void
    {
        $ch = Http::q('channel', 'directory');
        $u = Auth::require();
        if ($ch === 'promos') {
            $cand = Snapshot::promos();
            $live = Publisher::liveJson('promos');
            $ids = fn($j) => array_map(fn($p) => (string)$p['id'], $j['promos'] ?? []);
            $diff = ['promos' => ['added' => array_values(array_diff($ids($cand), $ids($live ?? []))), 'removed' => array_values(array_diff($ids($live ?? []), $ids($cand)))],
                'featuredChanged' => ($live['featured'] ?? []) !== $cand['featured'], 'events' => count($cand['events'])];
            [$seq] = [Db::val("SELECT COALESCE(MAX(seq),0)+1 FROM releases WHERE channel='promos'")];
            $can = Permissions::has($u['role'], 'publish.promos');
            Http::ok(['candidateVersion' => 'P' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT) . '-' . date('YmdHi'), 'diff' => $diff, 'sectionsChanged' => ['promos'],
                'counts' => ['promos' => count($cand['promos']), 'events' => count($cand['events']), 'featured' => count($cand['featured'])],
                'canPublish' => $can, 'blockers' => $can ? [] : ['Butuh izin publish.promos']]);
            return;
        }
        if ($ch !== 'directory') throw ApiError::validation(['channel' => 'directory|promos']);
        $pv = Publisher::preview();
        $vid = Validator::store($pv['validation'], (int)$u['id']);
        $bl = Publisher::blockers($pv['diff']['sectionsChanged'], $u);
        if (!$pv['validation']['ok']) $bl[] = 'Validasi gagal: ' . count($pv['validation']['errors']) . ' error';
        Http::ok(['candidateVersion' => $pv['candidateVersion'], 'diff' => ['content' => $pv['diff']['content'], 'map' => $pv['diff']['map']],
            'sectionsChanged' => $pv['diff']['sectionsChanged'], 'validation' => $pv['validation'] + ['runId' => $vid],
            'canPublish' => !$bl, 'blockers' => $bl, 'revisions' => Revisions::all(), 'live' => Publisher::live('directory')['version'] ?? null]);
    }

    public static function publish(): void
    {
        $b = Http::body();
        $u = Auth::require();
        $ch = $b['channel'] ?? 'directory';
        $notes = mb_substr((string)($b['notes'] ?? ''), 0, 500);
        if ($ch === 'promos') {
            Auth::requirePerm('publish.promos');
            $rel = Publisher::publishPromos($notes);
        } elseif ($ch === 'directory') {
            $rel = Publisher::publishDirectory($notes, $u);
        } else throw ApiError::validation(['channel' => 'directory|promos']);
        $row = Db::one('SELECT * FROM releases WHERE id=?', [$rel['id']]);
        Http::ok(['release' => self::dto($row, true)], 201);
    }

    public static function dto(array $r, bool $full = false): array
    {
        $o = ['id' => (int)$r['id'], 'channel' => $r['channel'], 'version' => $r['version'], 'seq' => (int)$r['seq'], 'sha256' => $r['sha256'], 'bytes' => (int)$r['bytes'],
            'path' => $r['path'], 'isLive' => (bool)(int)$r['is_live'], 'rolledBackFrom' => $r['rolled_back_from'] === null ? null : (int)$r['rolled_back_from'],
            'notes' => $r['notes'], 'createdBy' => $r['created_by'] === null ? null : (int)$r['created_by'], 'createdByName' => $r['created_by_name'] ?? null,
            'createdAt' => Util::iso($r['created_at']), 'revisions' => Util::jsonDecode($r['revs']), 'stats' => Util::jsonDecode($r['stats'])];
        if ($full) { $o['diff'] = Util::jsonDecode($r['diff']); $o['validation'] = Util::jsonDecode($r['validation']); }
        return $o;
    }

    public static function list(): void
    {
        $ch = Http::q('channel');
        $w = ''; $p = [];
        if ($ch) { if (!isset(Publisher::CHANNELS[$ch])) throw ApiError::validation(['channel' => 'directory|promos|status']); $w = ' WHERE r.channel=?'; $p[] = $ch; }
        [$page, $per, $lim] = Crud::page();
        $total = (int)Db::val('SELECT COUNT(*) FROM releases r' . $w, $p);
        $rows = Db::all('SELECT r.*, u.name created_by_name FROM releases r LEFT JOIN users u ON u.id=r.created_by' . $w . ' ORDER BY r.id DESC' . $lim, $p);
        Http::json(['data' => array_map(fn($r) => self::dto($r), $rows), 'total' => $total, 'page' => $page, 'per' => $per]);
    }

    public static function get(array $p): void
    {
        $r = Db::one('SELECT r.*, u.name created_by_name FROM releases r LEFT JOIN users u ON u.id=r.created_by WHERE r.id=?', [(int)$p['id']]);
        if (!$r) throw ApiError::notFound('Rilis');
        Http::ok(self::dto($r, true));
    }

    public static function download(array $p): void
    {
        $r = Db::one('SELECT * FROM releases WHERE id=?', [(int)$p['id']]);
        if (!$r) throw ApiError::notFound('Rilis');
        $f = APP_ROOT . '/' . $r['path'];
        if (!is_file($f)) throw ApiError::notFound('File rilis');
        if (Http::$captured !== null) { Http::$captured = ['status' => 200, 'file' => $f, 'headers' => []]; return; }
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $r['version'] . '-' . basename($r['path']) . '"');
        header('Cache-Control: no-store');
        Http::securityHeaders();
        readfile($f);
    }

    public static function rollback(array $p): void
    {
        $u = Auth::require();
        $r = Db::one('SELECT * FROM releases WHERE id=?', [(int)$p['id']]);
        if (!$r) throw ApiError::notFound('Rilis');
        if ($r['channel'] === 'promos') Auth::requirePerm('publish.promos');
        if ($r['channel'] === 'status') Auth::requirePerm('status.closures');
        $rel = Publisher::rollback((int)$p['id'], $u);
        $row = Db::one('SELECT r.*, u.name created_by_name FROM releases r LEFT JOIN users u ON u.id=r.created_by WHERE r.id=?', [$rel['id']]);
        Http::ok(['release' => self::dto($row), 'rolledBackFrom' => $rel['rolledBackFrom'],
            'banner' => $r['channel'] === 'directory' ? 'Live = rollback ke ' . $r['version'] . '; draft berbeda sampai publish berikutnya' : null], 201);
    }
}
