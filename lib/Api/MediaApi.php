<?php
declare(strict_types=1);

/** Media library + upload/replace SVG lantai (§2.4, §2.18, §8.2). */
final class MediaApi
{
    public static function register(Router $r): void
    {
        $r->get('/admin/media', [self::class, 'list'], ['admin' => true]);
        $r->get('/admin/media/{id}', [self::class, 'get'], ['admin' => true]);
        $r->post('/admin/media', [self::class, 'upload'], ['admin' => true, 'perm' => 'media.upload']);
        $r->put('/admin/media/{id}', [self::class, 'update'], ['admin' => true, 'perm' => 'media.upload']);
        $r->delete('/admin/media/{id}', [self::class, 'delete'], ['admin' => true, 'perm' => 'media.delete']);
        $r->post('/admin/floors/{id}/svg', [self::class, 'floorSvg'], ['admin' => true, 'perm' => 'floors.edit']);
        $r->post('/admin/floors/{id}/svg/confirm', [self::class, 'floorSvgConfirm'], ['admin' => true, 'perm' => 'floors.edit']);
    }

    public static function list(): void
    {
        $w = []; $p = [];
        if (($k = Http::q('kind')) !== null && $k !== '') { $w[] = 'kind=?'; $p[] = $k; }
        if (($q = Http::q('q')) !== null && $q !== '') { $w[] = '(original_name LIKE ? OR path LIKE ? OR alt_text LIKE ?)'; array_push($p, "%$q%", "%$q%", "%$q%"); }
        $where = $w ? ' WHERE ' . implode(' AND ', $w) : '';
        [$page, $per, $lim] = Crud::page();
        $total = (int)Db::val('SELECT COUNT(*) FROM media' . $where, $p);
        $rows = Db::all('SELECT * FROM media' . $where . ' ORDER BY id DESC' . $lim, $p);
        $data = array_map(fn($m) => Media::dto($m) + ['usedBy' => Media::usedBy((int)$m['id'])], $rows);
        if (Util::bool(Http::q('unused', '0'))) $data = array_values(array_filter($data, fn($d) => !$d['usedBy']));
        Http::json(['data' => $data, 'total' => $total, 'page' => $page, 'per' => $per]);
    }

    public static function get(array $p): void
    {
        $m = Db::one('SELECT * FROM media WHERE id=?', [(int)$p['id']]);
        if (!$m) throw ApiError::notFound('Media');
        Http::ok(Media::dto($m) + ['usedBy' => Media::usedBy((int)$m['id']), 'meta' => Util::jsonDecode($m['meta'])]);
    }

    public static function upload(): void
    {
        if (!isset($_FILES['file'])) throw ApiError::validation(['file' => 'required (multipart field "file")']);
        $kind = (string)($_POST['kind'] ?? Http::q('kind', 'logo'));
        $d = Media::upload($_FILES['file'], $kind, ['alt' => $_POST['altText'] ?? null]);
        Http::ok($d, empty($d['deduped']) ? 201 : 200);
    }

    public static function update(array $p): void
    {
        $id = (int)$p['id'];
        $b = Http::body();
        if (!Db::val('SELECT id FROM media WHERE id=?', [$id])) throw ApiError::notFound('Media');
        Db::update('media', ['alt_text' => isset($b['altText']) && $b['altText'] !== '' ? mb_substr((string)$b['altText'], 0, 190) : null], ['id' => $id]);
        Audit::log('update', 'media', (string)$id, 'alt text');
        self::get($p);
    }

    public static function delete(array $p): void
    {
        $id = (int)$p['id'];
        $m = Db::one('SELECT * FROM media WHERE id=?', [$id]);
        if (!$m) throw ApiError::notFound('Media');
        $used = Media::usedBy($id);
        if ($used) throw ApiError::conflict('Media masih dipakai', ['usedBy' => $used]);
        Db::exec('DELETE FROM media WHERE id=?', [$id]);
        // file dihapus hanya bila di media/ (seed di assets/ dibiarkan), dan tidak dipakai rilis (logo di rilis lama = immutable → dibiarkan)
        Audit::log('delete', 'media', (string)$id, 'media dihapus: ' . $m['path'], $m, null);
        Http::ok(['deleted' => $id, 'fileKept' => true]);
    }

    // ---------------------------------------------------------------- SVG lantai (2 langkah)
    public static function floorSvg(array $p): void
    {
        $f = Db::one('SELECT f.*, m.path svg_path FROM floors f JOIN media m ON m.id=f.svg_media_id WHERE f.id=?', [$p['id']]);
        if (!$f) throw ApiError::notFound('Lantai');
        $file = $_FILES['file'] ?? null;
        if (!$file || ($file['error'] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) throw ApiError::validation(['file' => 'required']);
        if (filesize($file['tmp_name']) > Media::LIMITS['svg']) throw ApiError::validation(['file' => 'too_large_max_8MB']);
        if (Media::magic($file['tmp_name']) !== 'image/svg+xml') throw ApiError::validation(['file' => 'type_svg']);
        [$clean, $rep] = SvgSanitizer::sanitize((string)file_get_contents($file['tmp_name']));
        $old = [(float)$f['vb_x'], (float)$f['vb_y'], (float)$f['vb_w'], (float)$f['vb_h']];
        $new = $rep['viewBox'];
        if (!$new) throw ApiError::validation(['file' => 'svg_without_viewBox']);
        $ids = array_flip($rep['ids']);
        $missing = [];
        foreach (Db::all('SELECT id, unit_shape_id FROM tenants WHERE floor_id=? AND unit_shape_id IS NOT NULL', [$f['id']]) as $t)
            if (!isset($ids[$t['unit_shape_id']])) $missing[] = $t['unit_shape_id'];
        $token = bin2hex(random_bytes(16));
        Util::ensureDir(APP_ROOT . '/media/tmp');
        Util::atomicWrite(APP_ROOT . '/media/tmp/' . $token . '.svg', $clean);
        Util::atomicWrite(APP_ROOT . '/media/tmp/' . $token . '.json', Util::jsonEncode(['floor' => $f['id'], 'name' => mb_substr(basename((string)$file['name']), 0, 190),
            'sha' => hash_file('sha256', $file['tmp_name']), 'report' => $rep, 'user' => Auth::id(), 'ts' => time()]));
        unset($rep['ids']);
        $changed = array_map(fn($v) => round($v, 3), $old) !== array_map(fn($v) => round((float)$v, 3), $new);
        Http::ok(['uploadToken' => $token, 'report' => $rep + ['viewBoxOld' => $old, 'viewBoxNew' => $new, 'viewBoxChanged' => $changed, 'missingUnitShapes' => $missing,
            'warning' => $changed ? 'viewBox berbeda — koordinat tenant/graph TIDAK otomatis dipindah (re-registrasi = v2)' : null],
            'previewUrl' => 'media/tmp/' . $token . '.svg']);
    }

    public static function floorSvgConfirm(array $p): void
    {
        $b = Http::body();
        $tok = (string)($b['uploadToken'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $tok)) throw ApiError::validation(['uploadToken' => 'format']);
        $metaF = APP_ROOT . '/media/tmp/' . $tok . '.json'; $svgF = APP_ROOT . '/media/tmp/' . $tok . '.svg';
        if (!is_file($metaF) || !is_file($svgF)) throw ApiError::notFound('Upload sementara');
        $meta = json_decode((string)file_get_contents($metaF), true);
        if (($meta['floor'] ?? '') !== $p['id']) throw ApiError::validation(['uploadToken' => 'other_floor']);
        if (time() - (int)$meta['ts'] > 3600) throw ApiError::validation(['uploadToken' => 'expired']);
        $clean = (string)file_get_contents($svgF);
        $rel = 'media/floors/' . substr(hash('sha256', $clean), 0, 16) . '.svg';
        Util::atomicWrite(APP_ROOT . '/' . $rel, $clean);
        $vb = $meta['report']['viewBox'];
        $res = Db::tx(function () use ($p, $meta, $rel, $clean, $vb) {
            $old = Db::one('SELECT * FROM floors WHERE id=?', [$p['id']]);
            $mid = Db::val("SELECT id FROM media WHERE sha256=? AND kind='svg'", [$meta['sha']]);
            if (!$mid) {
                $rep = $meta['report']; unset($rep['ids']);
                $mid = Db::insert('media', ['kind' => 'svg', 'path' => $rel, 'mime' => 'image/svg+xml', 'bytes' => strlen($clean), 'sha256' => $meta['sha'],
                    'original_name' => $meta['name'], 'meta' => Util::jsonEncode(['encoder' => 'sanitizer', 'sanitize' => $rep, 'warnings' => []]), 'created_by' => Auth::id()]);
            }
            Db::update('floors', ['svg_media_id' => (int)$mid, 'vb_x' => $vb[0], 'vb_y' => $vb[1], 'vb_w' => $vb[2], 'vb_h' => $vb[3], 'updated_by' => Auth::id()], ['id' => $p['id']]);
            Revisions::bump('map');
            Audit::log('svg_replace', 'floor', $p['id'], 'SVG lantai diganti → ' . $rel, ['svg_media_id' => $old['svg_media_id'], 'viewBox' => [$old['vb_x'], $old['vb_y'], $old['vb_w'], $old['vb_h']]], ['svg_media_id' => $mid, 'viewBox' => $vb]);
            return (int)$mid;
        });
        @unlink($metaF); @unlink($svgF);
        Http::ok(Crud::get(CatalogApi::defs()['floors'], $p['id']) + ['mediaId' => $res]);
    }
}
