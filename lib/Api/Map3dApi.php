<?php
declare(strict_types=1);

/**
 * Peta 3D (docs/3D.md): status lantai 3D, edit atap (nama/logo/penempatan) dari editor3d.html, denah tampak atas
 * untuk CMS, dan tenant CMS dari unit bernama di gambar. Edit atap langsung dibaca kiosk (≤ 60 dtk), tanpa publish.
 */
final class Map3dApi
{
    private const MAX_EDITS = 2_000_000;
    private const MAX_LOGO = 8_000_000;

    public static function register(Router $r): void
    {
        $r->get('/3d/ping', [self::class, 'ping']);
        $r->get('/admin/3d/floors', [self::class, 'floors'], ['admin' => true]);
        $r->post('/admin/3d/edits', [self::class, 'saveEdits'], ['admin' => true, 'perm' => 'tenants.edit']);
        $r->post('/admin/3d/logo', [self::class, 'logo'], ['admin' => true, 'perm' => 'media.upload']);
        $r->post('/admin/3d/floors/{id}/plan', [self::class, 'plan'], ['admin' => true, 'perm' => 'floors.edit']);
        $r->post('/admin/3d/floors/{id}/import-units', [self::class, 'importUnits'], ['admin' => true, 'perm' => 'tenants.edit']);
        $r->post('/admin/3d/floors/{id}/import-facilities', [self::class, 'importFacilities'], ['admin' => true, 'perm' => 'amenities.edit']);
        $r->post('/admin/3d/floors/{id}/link-units', [self::class, 'linkUnits'], ['admin' => true, 'perm' => 'tenants.edit']);
        $r->post('/admin/graph/reconnect', [self::class, 'reconnect'], ['admin' => true, 'perm' => ['graph.edit', 'tenants.place']]);
    }

    /** Editor 3D: server PHP CMS ada (simpan lewat /admin/3d/*, butuh login). serve3d.py menjawab tanpa "cms". */
    public static function ping(): void { Http::ok(['ok' => true, 'cms' => true]); }

    public static function floors(): void
    {
        $out = [];
        $names = [];
        foreach (Db::all('SELECT id, short, name_id, building, vb_x, vb_y, vb_w, vb_h FROM floors') as $f) $names[$f['id']] = $f;
        foreach (Map3d::registry()['floors'] as $fid => $e) {
            if (!is_array($e) || !isset($names[$fid])) continue;
            $m = Map3d::model($e);
            $named = $m ? count(array_filter($m['units'], fn($u) => trim((string)($u['name'] ?? '')) !== '')) : 0;
            $uids = $m ? array_column($m['units'], 'id') : [];
            $linked = count(array_intersect(Db::col('SELECT unit_shape_id FROM tenants WHERE floor_id=? AND unit_shape_id IS NOT NULL', [$fid]), $uids));
            $out[] = ['id' => $fid, 'short' => $names[$fid]['short'], 'name' => $names[$fid]['name_id'], 'building' => $names[$fid]['building'],
                'frame' => Map3d::isPlan($e) ? 'plan' : 'legacy', 'model' => $e['model'] ?? null, 'edits' => Map3d::editsFile($e),
                'modelOk' => (bool)$m, 'units' => $m ? count($m['units']) : 0, 'named' => $named, 'facilities' => $m ? count($m['facilities'] ?? []) : 0,
                'linked' => $linked, 'unlinked' => $m && Map3d::isPlan($e) ? Map3d::unlinkedUnits($fid, $m) : [],
                'unlinkedFacilities' => $m && Map3d::isPlan($e) ? Map3d::unlinkedFacilities($fid, $m) : [],
                'artboard' => $m['artboard'] ?? null, 'planCurrent' => Map3d::isPlan($e) && Map3d::planIsCurrent($fid, $e)];
        }
        Http::ok($out);
    }

    private static function entryOr404(string $fid): array
    {
        $e = Map3d::entry($fid);
        if (!$e) throw ApiError::notFound('Lantai 3D');
        return $e;
    }

    /** Body {units: {unitId: {name, logo, show, style, tone, color, scale, rot, dx, dy, c, category}}} → file edit lantai itu (atomik). */
    public static function saveEdits(): void
    {
        $fid = (string)Http::q('floor', '');
        $e = self::entryOr404($fid);
        $file = Map3d::editsFile($e);
        if (!$file) throw new ApiError('validation', 'Lantai ini tidak punya file edit 3D di registry');
        $in = Http::body(self::MAX_EDITS);
        if (!is_array($in['units'] ?? null)) throw ApiError::validation(['units' => 'object']);
        $units = [];
        foreach ($in['units'] as $uid => $o) {
            if (!is_string($uid) || !preg_match('/^[A-Za-z0-9_.:-]{1,120}$/', $uid) || !is_array($o)) throw ApiError::validation(['units' => 'unit_id:' . $uid]);
            $c = self::cleanUnit($o);
            if ($c) $units[$uid] = $c;
        }
        $abs = APP_ROOT . '/' . $file;
        $old = is_file($abs) ? (Util::jsonDecode((string)file_get_contents($abs), [])['units'] ?? []) : [];
        Util::atomicWrite($abs, Util::jsonEncode(['units' => (object)$units, 'saved_at' => date('Y-m-d\TH:i:s'), 'saved_by' => Auth::user()['name'] ?? null], true));
        $changed = array_keys(array_filter(array_merge($old, $units), fn($v, $k) => json_encode($old[$k] ?? null) !== json_encode($units[$k] ?? null), ARRAY_FILTER_USE_BOTH));
        if ($changed) Audit::log('update', 'map3d', $fid, 'Atap 3D diubah: ' . implode(', ', array_slice($changed, 0, 12)),
            array_intersect_key($old, array_flip($changed)), array_intersect_key($units, array_flip($changed)));
        Http::ok(['ok' => true, 'path' => $file, 'units' => count($units)]);
    }

    private static function num($v, float $lo, float $hi): ?float
    {
        return is_numeric($v) && is_finite((float)$v) ? max($lo, min($hi, round((float)$v, 3))) : null;
    }

    private static function cleanUnit(array $o): array
    {
        $r = [];
        if (isset($o['name']) && is_string($o['name']) && trim($o['name']) !== '') $r['name'] = mb_substr(trim($o['name']), 0, 120);
        if (array_key_exists('logo', $o) && is_string($o['logo'])) {
            $p = $o['logo'];
            if ($p === '' || (preg_match('#^(assets/logos|media)/[A-Za-z0-9_./-]+\.(png|webp|jpe?g|svg)$#i', $p) && !str_contains($p, '..'))) $r['logo'] = $p;
            else throw ApiError::validation(['logo' => 'path']);
        }
        if (in_array($o['show'] ?? null, ['logo', 'name'], true)) $r['show'] = $o['show'];
        if (in_array($o['style'] ?? null, ['emboss', 'plate'], true)) $r['style'] = $o['style'];
        if (in_array($o['tone'] ?? null, ['light', 'dark'], true)) $r['tone'] = $o['tone']; // warna atap; kosong = otomatis per jenis unit
        if (isset($o['color']) && is_string($o['color']) && preg_match('/^#[0-9a-fA-F]{6}$/', $o['color'])) $r['color'] = strtolower($o['color']); // warna atap bebas
        foreach (['scale' => [0.2, 4], 'rot' => [-360, 360], 'dx' => [-60, 60], 'dy' => [-60, 60]] as $k => [$lo, $hi])
            if (isset($o[$k]) && ($v = self::num($o[$k], $lo, $hi)) !== null) $r[$k] = $v;
        if (isset($o['c']) && is_array($o['c']) && count($o['c']) === 2 && is_numeric($o['c'][0]) && is_numeric($o['c'][1]))
            $r['c'] = [round((float)$o['c'][0], 2), round((float)$o['c'][1], 2)];
        if (isset($o['category']) && is_string($o['category']) && preg_match('/^[a-z0-9-]{1,48}$/', $o['category'])) $r['category'] = $o['category'];
        return $r;
    }

    /** Body PNG (editor sudah mengubah gambar apa pun jadi PNG ≤ 1024 px) → media/3d/<slug>-<waktu>.png */
    public static function logo(): void
    {
        $raw = Http::rawBody(self::MAX_LOGO);
        if (!str_starts_with($raw, "\x89PNG\r\n\x1a\n")) throw ApiError::validation(['file' => 'png']);
        $info = @getimagesizefromstring($raw);
        if (!$info || $info[2] !== IMAGETYPE_PNG || $info[0] < 1 || $info[1] < 1 || $info[0] > 4096 || $info[1] > 4096) throw ApiError::validation(['file' => 'png_dims']);
        $slug = substr(Util::slug((string)Http::q('name', 'logo')), 0, 40);
        $rel = 'media/3d/' . $slug . '-' . time() . '-' . bin2hex(random_bytes(2)) . '.png';
        Util::atomicWrite(APP_ROOT . '/' . $rel, $raw);
        Audit::log('upload', 'map3d', null, 'Logo atap 3D diunggah: ' . $rel);
        Http::ok(['ok' => true, 'path' => $rel]);
    }

    /** Buat ulang denah tampak atas lantai ini dari model 3D-nya (setelah gambar Illustrator dikonversi ulang). */
    public static function plan(array $p): void
    {
        $e = self::entryOr404($p['id']);
        if (!Map3d::isPlan($e)) throw new ApiError('validation', 'Koordinat CMS lantai ini masih di gambar lama — jalankan tools/3d/rebase_floor.php dulu');
        $m = Map3d::model($e);
        if (!$m) throw new ApiError('validation', 'Model 3D lantai ini tidak bisa dibaca');
        $r = Db::tx(fn() => Map3d::installPlan($p['id'], $e, $m));
        Http::ok($r);
    }

    /** Body {units: [unitId, ...]} → tenant CMS baru untuk unit bernama yang belum punya tenant. */
    public static function importUnits(array $p): void
    {
        Auth::requirePerm('tenants.place');
        $ids = Http::body()['units'] ?? null;
        if (!is_array($ids) || !$ids || count($ids) > 300) throw ApiError::validation(['units' => 'array']);
        Http::ok(Map3d::importUnits($p['id'], $ids));
    }

    /**
     * Body {floor, tenants: [id…], amenities: [id…], all: bool} → sambung ulang pin ke jalur yang sekarang (lewat lantai yang
     * bisa dilalui bila lantainya punya denah 3D). all = semua tenant & fasilitas lantai itu yang belum punya node.
     */
    public static function reconnect(): void
    {
        $b = Http::body();
        $fid = (string)($b['floor'] ?? '');
        if (!Db::val('SELECT id FROM floors WHERE id=?', [$fid])) throw ApiError::validation(['floor' => 'not_found']);
        $t = array_map('strval', (array)($b['tenants'] ?? [])); $a = array_map('strval', (array)($b['amenities'] ?? []));
        if (!empty($b['all'])) {
            $t = array_merge($t, Db::col('SELECT id FROM tenants WHERE floor_id=? AND (node_id IS NULL OR node_id NOT IN (SELECT id FROM graph_nodes))', [$fid]));
            $a = array_merge($a, Db::col('SELECT id FROM amenities WHERE floor_id=? AND (node_id IS NULL OR node_id NOT IN (SELECT id FROM graph_nodes))', [$fid]));
        }
        if (count($t) + count($a) > 300) throw ApiError::validation(['tenants' => 'max_300']);
        if ($a) Auth::requirePerm(['amenities.edit', 'graph.edit']);
        Http::ok(['connected' => Map3d::reconnect($fid, array_values(array_unique($t)), array_values(array_unique($a))), 'revision' => Revisions::get('map')]);
    }

    /** Body {links: {unitId: tenantId}} → tautkan unit gambar ke tenant CMS yang sudah ada (pin pindah ke muka toko, disambung ke jalur). */
    public static function linkUnits(array $p): void
    {
        Auth::requirePerm('tenants.place');
        $links = Http::body()['links'] ?? null;
        if (!is_array($links) || !$links || count($links) > 300) throw ApiError::validation(['links' => 'object']);
        Http::ok(Map3d::linkUnits($p['id'], $links));
    }

    /** Body {facilities: [facilityId, ...]} → fasilitas CMS untuk fasilitas gambar (toilet, musholla, ATM, …). */
    public static function importFacilities(array $p): void
    {
        $ids = Http::body()['facilities'] ?? null;
        if (!is_array($ids) || !$ids || count($ids) > 100) throw ApiError::validation(['facilities' => 'array']);
        Http::ok(Map3d::importFacilities($p['id'], $ids));
    }
}
