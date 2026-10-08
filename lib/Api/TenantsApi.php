<?php
declare(strict_types=1);

/** Tenant (outlet) + brand (§2.2, DTO §4.5). */
final class TenantsApi
{
    public const STATUS = ['open', 'coming_soon', 'temp_closed', 'closed'];
    public const HOURS_MODE = ['mall', 'custom', '24h', 'unknown'];

    public static function register(Router $r): void
    {
        $ro = ['admin' => true];
        $w = ['admin' => true, 'perm' => 'tenants.edit'];
        $r->get('/admin/tenants', [self::class, 'list'], $ro);
        $r->get('/admin/tenants/export.csv', [self::class, 'exportCsv'], $ro);
        $r->post('/admin/tenants/import.csv', [self::class, 'importCsv'], $w);
        $r->post('/admin/tenants/bulk', [self::class, 'bulk'], $w);
        $r->get('/admin/tenants/{id}', fn($p) => Http::ok(self::get($p['id'])), $ro);
        $r->post('/admin/tenants', [self::class, 'create'], $w);
        $r->put('/admin/tenants/{id}', [self::class, 'update'], ['admin' => true, 'perm' => ['tenants.edit', 'tenants.place']]);
        $r->delete('/admin/tenants/{id}', [self::class, 'delete'], $w);
        $r->get('/admin/brands', [self::class, 'brandList'], $ro);
        $r->get('/admin/brands/{id}', fn($p) => Http::ok(self::brandDto(self::brandRow((int)$p['id']))), $ro);
        $r->post('/admin/brands', [self::class, 'brandCreate'], $w);
        $r->put('/admin/brands/{id}', [self::class, 'brandUpdate'], $w);
        $r->delete('/admin/brands/{id}', [self::class, 'brandDelete'], $w);
    }

    // ================================================================= DTO
    private const SELECT = "SELECT t.*, b.slug b_slug, b.name b_name, b.category_id b_category_id, b.logo_media_id b_logo_media_id,
        b.desc_en b_desc_en, b.desc_id b_desc_id, b.keywords_en b_keywords_en, b.keywords_id b_keywords_id, b.url b_url, b.instagram b_instagram,
        b.tiktok b_tiktok, b.facebook b_facebook, b.whatsapp b_whatsapp, b.updated_at b_updated_at,
        mb.id mb_id, mb.path mb_path, mb.path_2x mb_path_2x, mo.id mo_id, mo.path mo_path, mo.path_2x mo_path_2x,
        (SELECT COUNT(*) FROM tenants t2 WHERE t2.brand_id=t.brand_id) b_outlets
        FROM tenants t JOIN brands b ON b.id=t.brand_id
        LEFT JOIN media mb ON mb.id=b.logo_media_id LEFT JOIN media mo ON mo.id=t.logo_override_media_id";

    private static ?array $outletCache = null;
    private static ?array $floorCache = null;

    private static function floors(): array
    {
        if (self::$floorCache === null) { self::$floorCache = []; foreach (Db::all('SELECT * FROM floors') as $f) self::$floorCache[$f['id']] = $f; }
        return self::$floorCache;
    }
    private static function outlets(): array
    {
        if (self::$outletCache === null) {
            self::$outletCache = [];
            foreach (Db::all("SELECT id, brand_id, building, floor_id FROM tenants WHERE is_published=1 AND status<>'closed'") as $o) self::$outletCache[(int)$o['brand_id']][] = $o;
        }
        return self::$outletCache;
    }

    public static function brandDtoFromJoin(array $r): array
    {
        return ['id' => (int)$r['brand_id'], 'slug' => $r['b_slug'], 'name' => $r['b_name'], 'categoryId' => $r['b_category_id'],
            'logo' => $r['mb_id'] ? ['id' => (int)$r['mb_id'], 'url' => $r['mb_path'], 'url2x' => $r['mb_path_2x']] : null,
            'descEn' => $r['b_desc_en'], 'descId' => $r['b_desc_id'], 'keywordsEn' => $r['b_keywords_en'], 'keywordsId' => $r['b_keywords_id'],
            'url' => $r['b_url'], 'instagram' => $r['b_instagram'], 'tiktok' => $r['b_tiktok'], 'facebook' => $r['b_facebook'], 'whatsapp' => $r['b_whatsapp'],
            'outletCount' => (int)$r['b_outlets']];
    }

    public static function dto(array $r, array $hours): array
    {
        $floors = self::floors();
        $outs = self::outlets()[(int)$r['brand_id']] ?? [];
        $t = $r + ['brand_name' => $r['b_name']];
        $display = Snapshot::displayName($t, $outs ?: [$r], $floors);
        $issues = [];
        if (!$r['mo_id'] && !$r['mb_id']) $issues[] = 'W_NO_LOGO';
        if ($r['hours_mode'] === 'unknown') $issues[] = 'W_NO_HOURS';
        if ($r['node_id'] === null) $issues[] = 'W_NOT_PLACED';
        if ($r['unit_shape_id'] === null) $issues[] = 'W_NO_UNIT';
        return [
            'id' => $r['id'], 'brandId' => (int)$r['brand_id'], 'brand' => self::brandDtoFromJoin($r),
            'nameOverride' => $r['name_override'], 'displayName' => $display, 'floorId' => $r['floor_id'], 'building' => $r['building'],
            'unitNo' => $r['unit_no'], 'x' => $r['x'] === null ? null : (float)$r['x'], 'y' => $r['y'] === null ? null : (float)$r['y'],
            'nodeId' => $r['node_id'] === null ? null : (int)$r['node_id'], 'unitShapeId' => $r['unit_shape_id'], 'phone' => $r['phone'],
            'urlOverride' => $r['url_override'],
            'logoOverride' => $r['mo_id'] ? ['id' => (int)$r['mo_id'], 'url' => $r['mo_path'], 'url2x' => $r['mo_path_2x']] : null,
            'status' => $r['status'], 'statusNoteEn' => $r['status_note_en'], 'statusNoteId' => $r['status_note_id'],
            'statusUntil' => $r['status_until'], 'openingDate' => $r['opening_date'], 'hoursMode' => $r['hours_mode'],
            'hours' => array_map(fn($h) => ['dow' => (int)$h['dow'], 'open' => Util::hhmm($h['open_time']), 'close' => Util::hhmm($h['close_time']), 'closed' => (bool)(int)$h['is_closed']], $hours),
            'hoursNoteEn' => $r['hours_note_en'], 'hoursNoteId' => $r['hours_note_id'], 'isPublished' => (bool)(int)$r['is_published'],
            'srcId' => $r['src_id'], 'issues' => $issues, 'createdAt' => Util::iso($r['created_at']), 'updatedAt' => Util::iso($r['updated_at']),
            'etag' => self::etagOf($r),
        ];
    }

    private static function etagOf(array $r): string { return $r['updated_at'] . ($r['b_updated_at'] > $r['updated_at'] ? '|b' . $r['b_updated_at'] : ''); }

    public static function row(string $id): array
    {
        $r = Db::one(self::SELECT . ' WHERE t.id=?', [$id]);
        if (!$r) throw ApiError::notFound('Tenant');
        return $r;
    }
    public static function get(string $id): array
    {
        self::$outletCache = null;
        $r = self::row($id);
        return self::dto($r, Db::all('SELECT * FROM tenant_hours WHERE tenant_id=? ORDER BY dow', [$id]));
    }

    // ================================================================= list
    public static function list(): void
    {
        $w = []; $p = [];
        if (($q = Http::q('q')) !== null && $q !== '') { $w[] = '(t.id LIKE ? OR b.name LIKE ? OR t.name_override LIKE ? OR t.unit_no LIKE ?)'; array_push($p, "%$q%", "%$q%", "%$q%", "%$q%"); }
        foreach (['floor' => 't.floor_id', 'building' => 't.building', 'category' => 'b.category_id', 'status' => 't.status'] as $k => $c) {
            if (($v = Http::q($k)) !== null && $v !== '') { $w[] = "$c = ?"; $p[] = $v; }
        }
        if (($v = Http::q('published')) !== null && $v !== '') { $w[] = 't.is_published = ?'; $p[] = Util::bool($v) ? 1 : 0; }
        if (($v = Http::q('brandId')) !== null && $v !== '') { $w[] = 't.brand_id = ?'; $p[] = (int)$v; }
        switch (Http::q('missing')) {
            case 'logo': $w[] = 't.logo_override_media_id IS NULL AND b.logo_media_id IS NULL'; break;
            case 'hours': $w[] = "t.hours_mode = 'unknown'"; break;
            case 'placement': $w[] = 't.node_id IS NULL'; break;
            case 'unit': $w[] = 't.unit_shape_id IS NULL'; break;
        }
        $where = $w ? ' WHERE ' . implode(' AND ', $w) : '';
        $total = (int)Db::val('SELECT COUNT(*) FROM tenants t JOIN brands b ON b.id=t.brand_id' . $where, $p);
        $sorts = ['name' => 'COALESCE(t.name_override,b.name)', 'id' => 't.id', 'floor' => 't.floor_id', 'updated_at' => 't.updated_at', 'status' => 't.status', 'category' => 'b.category_id'];
        $s = Http::q('sort', 'name');
        $desc = str_starts_with((string)$s, '-'); $s = ltrim((string)$s, '-');
        $order = ($sorts[$s] ?? $sorts['name']) . ($desc ? ' DESC' : '') . ', t.id';
        [$page, $per, $lim] = Crud::page();
        $rows = Db::all(self::SELECT . $where . ' ORDER BY ' . $order . $lim, $p);
        $hours = [];
        if ($rows) {
            $ids = array_column($rows, 'id');
            $in = implode(',', array_fill(0, count($ids), '?'));
            foreach (Db::all("SELECT * FROM tenant_hours WHERE tenant_id IN ($in) ORDER BY dow", $ids) as $h) $hours[$h['tenant_id']][] = $h;
        }
        self::$outletCache = null;
        Http::json(['data' => array_map(fn($r) => self::dto($r, $hours[$r['id']] ?? []), $rows), 'total' => $total, 'page' => $page, 'per' => $per]);
    }

    // ================================================================= tulis
    private static function brandFields(array $b, bool $create): array
    {
        $row = []; $err = [];
        $map = ['slug' => 'slug', 'name' => 'name', 'categoryId' => 'category_id', 'descEn' => 'desc_en', 'descId' => 'desc_id',
            'keywordsEn' => 'keywords_en', 'keywordsId' => 'keywords_id', 'url' => 'url', 'instagram' => 'instagram', 'tiktok' => 'tiktok',
            'facebook' => 'facebook', 'whatsapp' => 'whatsapp'];
        $max = ['name' => 120, 'keywordsEn' => 500, 'keywordsId' => 500, 'url' => 500, 'instagram' => 120, 'tiktok' => 120, 'facebook' => 255, 'whatsapp' => 32];
        foreach ($map as $k => $c) {
            if (!array_key_exists($k, $b)) continue;
            $v = is_string($b[$k]) ? trim($b[$k]) : $b[$k];
            if ($v === '') $v = null;
            if ($v !== null && !is_scalar($v)) { $err[$k] = 'string'; continue; }
            if ($v !== null && isset($max[$k]) && mb_strlen((string)$v) > $max[$k]) { $err[$k] = 'max_len_' . $max[$k]; continue; }
            $row[$c] = $v === null ? null : (string)$v;
        }
        if (array_key_exists('logo', $b) || array_key_exists('logoId', $b)) {
            $lid = $b['logoId'] ?? (is_array($b['logo'] ?? null) ? ($b['logo']['id'] ?? null) : null);
            if ($lid !== null && !Db::val("SELECT id FROM media WHERE id=? AND kind='logo'", [(int)$lid])) $err['logoId'] = 'not_found';
            $row['logo_media_id'] = $lid === null ? null : (int)$lid;
        }
        if (array_key_exists('name', $row) && !$row['name']) $err['name'] = 'required';
        if ($create && empty($row['name'])) $err['name'] = 'required';
        if ($create && empty($row['category_id'])) $err['categoryId'] = 'required';
        if (!empty($row['category_id']) && !Db::val('SELECT id FROM categories WHERE id=?', [$row['category_id']])) $err['categoryId'] = 'not_found';
        if (!empty($row['url']) && !preg_match('#^https://\S+$#i', $row['url'])) $err['url'] = 'https_url';
        if (!empty($row['whatsapp']) && !preg_match('/^\+[1-9]\d{6,14}$/', $row['whatsapp'])) $err['whatsapp'] = 'e164';
        if (array_key_exists('slug', $row) && $row['slug'] !== null && !preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $row['slug'])) $err['slug'] = 'slug_a-z0-9-';
        if ($err) throw ApiError::validation(array_combine(array_map(fn($k) => 'brand.' . $k, array_keys($err)), $err));
        if ($create && empty($row['slug'])) {
            $base = Util::slug($row['name']); $s = $base; $i = 2;
            while (Db::val('SELECT id FROM brands WHERE slug=?', [$s])) $s = $base . '-' . $i++;
            $row['slug'] = $s;
        }
        return $row;
    }

    private static function tenantFields(array $in, bool $create, ?array $old): array
    {
        $row = []; $err = [];
        $str = ['nameOverride' => ['name_override', 120], 'unitNo' => ['unit_no', 32], 'unitShapeId' => ['unit_shape_id', 128], 'phone' => ['phone', 32],
            'urlOverride' => ['url_override', 500], 'statusNoteEn' => ['status_note_en', 160], 'statusNoteId' => ['status_note_id', 160],
            'hoursNoteEn' => ['hours_note_en', 160], 'hoursNoteId' => ['hours_note_id', 160], 'srcId' => ['src_id', 120]];
        foreach ($str as $k => [$c, $max]) {
            if (!array_key_exists($k, $in)) continue;
            $v = is_string($in[$k]) ? trim($in[$k]) : $in[$k];
            if ($v === '' || $v === null) { $row[$c] = null; continue; }
            if (!is_scalar($v) || mb_strlen((string)$v) > $max) { $err[$k] = 'max_len_' . $max; continue; }
            $row[$c] = (string)$v;
        }
        if (!empty($row['url_override']) && !preg_match('#^https://\S+$#i', $row['url_override'])) $err['urlOverride'] = 'https_url';
        if (!empty($row['phone']) && !preg_match('/^\+?[0-9][0-9 ()\-]{5,24}$/', $row['phone'])) $err['phone'] = 'phone';
        if (array_key_exists('floorId', $in)) {
            if (!Db::val('SELECT id FROM floors WHERE id=?', [(string)$in['floorId']])) $err['floorId'] = 'not_found'; else $row['floor_id'] = (string)$in['floorId'];
        } elseif ($create) $err['floorId'] = 'required';
        if (array_key_exists('building', $in) && $in['building'] !== null && $in['building'] !== '') {
            if (!in_array($in['building'], ['pentacity', 'ewalk'], true)) $err['building'] = 'one_of:pentacity|ewalk'; else $row['building'] = $in['building'];
        }
        foreach (['x' => 'x', 'y' => 'y'] as $k => $c) if (array_key_exists($k, $in)) {
            if ($in[$k] === null || $in[$k] === '') $row[$c] = null; elseif (!is_numeric($in[$k])) $err[$k] = 'number'; else $row[$c] = round((float)$in[$k], 2);
        }
        if (array_key_exists('nodeId', $in)) {
            if ($in['nodeId'] === null || $in['nodeId'] === '') $row['node_id'] = null;
            elseif (!is_numeric($in['nodeId']) || !Db::val('SELECT id FROM graph_nodes WHERE id=?', [(int)$in['nodeId']])) $err['nodeId'] = 'not_found';
            else $row['node_id'] = (int)$in['nodeId'];
        }
        foreach (['status' => [self::STATUS, 'status'], 'hoursMode' => [self::HOURS_MODE, 'hours_mode']] as $k => [$vals, $c]) if (array_key_exists($k, $in)) {
            if (!in_array($in[$k], $vals, true)) $err[$k] = 'one_of:' . implode('|', $vals); else $row[$c] = $in[$k];
        }
        foreach (['statusUntil' => 'status_until', 'openingDate' => 'opening_date'] as $k => $c) if (array_key_exists($k, $in)) {
            if ($in[$k] === null || $in[$k] === '') $row[$c] = null;
            elseif (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$in[$k])) $err[$k] = 'date_YYYY-MM-DD'; else $row[$c] = $in[$k];
        }
        if (array_key_exists('isPublished', $in)) $row['is_published'] = Util::bool($in['isPublished']) ? 1 : 0;
        if (array_key_exists('logoOverride', $in) || array_key_exists('logoOverrideId', $in)) {
            $lid = $in['logoOverrideId'] ?? (is_array($in['logoOverride'] ?? null) ? ($in['logoOverride']['id'] ?? null) : null);
            if ($lid !== null && !Db::val("SELECT id FROM media WHERE id=? AND kind='logo'", [(int)$lid])) $err['logoOverrideId'] = 'not_found';
            $row['logo_override_media_id'] = $lid === null ? null : (int)$lid;
        }
        if ($err) throw ApiError::validation($err);
        // konsistensi lantai / node / viewBox
        $floorId = $row['floor_id'] ?? ($old['floor_id'] ?? null);
        $f = $floorId ? Db::one('SELECT * FROM floors WHERE id=?', [$floorId]) : null;
        $nodeId = array_key_exists('node_id', $row) ? $row['node_id'] : ($old['node_id'] ?? null);
        if ($f && $nodeId !== null) {
            $nf = Db::val('SELECT floor_id FROM graph_nodes WHERE id=?', [$nodeId]);
            if ($nf !== $f['id']) $err['nodeId'] = 'node_on_other_floor:' . $nf;
        }
        $x = array_key_exists('x', $row) ? $row['x'] : ($old['x'] ?? null); $y = array_key_exists('y', $row) ? $row['y'] : ($old['y'] ?? null);
        if ($f && $x !== null && $y !== null && ($x < (float)$f['vb_x'] || $y < (float)$f['vb_y'] || $x > (float)$f['vb_x'] + (float)$f['vb_w'] || $y > (float)$f['vb_y'] + (float)$f['vb_h']))
            $err['x'] = 'outside_viewbox';
        if ($f) {
            if ($f['building'] !== 'both') $row['building'] = $f['building'];
            elseif (empty($row['building']) && empty($old['building']) || (isset($row['floor_id']) && empty($row['building']) && $old && $old['floor_id'] !== $row['floor_id'])) {
                $row['building'] = self::guessBuilding($f['id'], $x, $y);
            }
        }
        if ($err) throw ApiError::validation($err);
        return $row;
    }

    /** Gedung untuk lantai gabungan: tetangga terdekat yang sudah diketahui. */
    public static function guessBuilding(string $floorId, $x, $y): string
    {
        if ($x === null || $y === null) return 'pentacity';
        $r = Db::one('SELECT building FROM (SELECT building, x, y FROM tenants WHERE floor_id=? AND x IS NOT NULL UNION ALL SELECT building, x, y FROM kiosks WHERE floor_id=?) z
            ORDER BY (x-?)*(x-?)+(y-?)*(y-?) LIMIT 1', [$floorId, $floorId, (float)$x, (float)$x, (float)$y, (float)$y]);
        return $r['building'] ?? 'pentacity';
    }

    private static function saveHours(string $id, $hours): void
    {
        if (!is_array($hours)) throw ApiError::validation(['hours' => 'array']);
        $rows = []; $err = [];
        foreach ($hours as $i => $h) {
            $d = (int)($h['dow'] ?? 0);
            if ($d < 1 || $d > 7) { $err["hours.$i.dow"] = '1..7'; continue; }
            $closed = Util::bool($h['closed'] ?? false);
            $o = $h['open'] ?? null; $c = $h['close'] ?? null;
            if (!$closed && (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', (string)$o) || !preg_match('/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/', (string)$c))) { $err["hours.$i"] = 'time_HH:MM'; continue; }
            $rows[$d] = [$id, $d, $closed ? null : $o . ':00', $closed ? null : ($c === '24:00' ? '23:59:59' : $c . ':00'), $closed ? 1 : 0];
        }
        if ($err) throw ApiError::validation($err);
        Db::exec('DELETE FROM tenant_hours WHERE tenant_id=?', [$id]);
        foreach ($rows as $r) Db::q('INSERT INTO tenant_hours (tenant_id,dow,open_time,close_time,is_closed) VALUES (?,?,?,?,?)', $r);
    }

    private static function snap(string $id): array
    {
        $r = Db::one('SELECT * FROM tenants WHERE id=?', [$id]);
        if ($r) { unset($r['updated_at'], $r['created_at']); $r['hours'] = Db::all('SELECT dow,open_time,close_time,is_closed FROM tenant_hours WHERE tenant_id=? ORDER BY dow', [$id]); }
        return $r ?? [];
    }

    public static function create(): void
    {
        $in = Http::body();
        $out = Db::tx(function () use ($in) {
            $brandId = $in['brandId'] ?? null;
            if ($brandId === null) {
                if (!is_array($in['brand'] ?? null)) throw ApiError::validation(['brandId' => 'required']);
                $b = self::brandFields($in['brand'], true);
                $b['updated_by'] = Auth::id();
                $brandId = Db::insert('brands', $b);
                Audit::log('create', 'brand', (string)$brandId, 'brand dibuat: ' . $b['name'], null, $b);
            } else {
                if (!Db::val('SELECT id FROM brands WHERE id=?', [(int)$brandId])) throw ApiError::validation(['brandId' => 'not_found']);
                if (is_array($in['brand'] ?? null)) self::applyBrand((int)$brandId, $in['brand']);
            }
            $row = self::tenantFields($in, true, null);
            $row['brand_id'] = (int)$brandId;
            $id = isset($in['id']) && $in['id'] !== '' ? (string)$in['id'] : null;
            if ($id !== null) {
                if (!preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $id)) throw ApiError::validation(['id' => 'slug_a-z0-9-']);
                if (Db::val('SELECT id FROM tenants WHERE id=?', [$id])) throw ApiError::conflict('ID tenant sudah dipakai', ['id' => $id]);
            } else {
                $slug = (string)Db::val('SELECT slug FROM brands WHERE id=?', [$brandId]);
                $base = substr($slug . '-' . $row['floor_id'], 0, 60); $id = $base; $i = 2;
                while (Db::val('SELECT id FROM tenants WHERE id=?', [$id])) $id = $base . '-' . $i++;
            }
            $row['id'] = $id;
            $row['updated_by'] = Auth::id();
            $row += ['building' => 'pentacity'];
            Db::insert('tenants', $row);
            if (array_key_exists('hours', $in)) self::saveHours($id, $in['hours']);
            Revisions::bump('content');
            Audit::log('create', 'tenant', $id, 'tenant dibuat', null, self::snap($id));
            return $id;
        });
        Http::ok(self::get($out), 201);
    }

    private static function applyBrand(int $brandId, array $b): void
    {
        $old = Db::one('SELECT * FROM brands WHERE id=?', [$brandId]);
        $row = self::brandFields($b, false);
        unset($row['slug']);
        if (!$row) return;
        $row['updated_by'] = Auth::id();
        try { Db::update('brands', $row, ['id' => $brandId]); } catch (PDOException $e) { throw Crud::pdoErr($e); }
        $new = Db::one('SELECT * FROM brands WHERE id=?', [$brandId]);
        [$bb, $aa] = Audit::changed($old, $new);
        if ($bb !== null || $aa !== null) Audit::log('update', 'brand', (string)$brandId, 'brand diubah: ' . $new['name'], $bb, $aa);
    }

    public static function update(array $p): void
    {
        $id = $p['id'];
        $in = Http::body();
        $u = Auth::require();
        $placeOnly = !Permissions::has($u['role'], 'tenants.edit');
        if ($placeOnly) {
            $allowed = ['x', 'y', 'nodeId', 'unitShapeId', 'floorId', 'building'];
            $bad = array_diff(array_keys($in), $allowed);
            if ($bad) throw ApiError::forbidden('Izin tenants.place hanya boleh mengubah posisi/unit (' . implode(',', $bad) . ')');
        }
        Db::tx(function () use ($id, $in) {
            $old = Db::one('SELECT * FROM tenants WHERE id=? FOR UPDATE', [$id]);
            if (!$old) throw ApiError::notFound('Tenant');
            $cur = self::row($id);
            Crud::checkEtag(self::etagOf($cur), null);
            if (isset($in['id']) && $in['id'] !== $id) throw ApiError::validation(['id' => 'immutable']);
            $before = self::snap($id);
            if (array_key_exists('brandId', $in) && $in['brandId'] !== null && (int)$in['brandId'] !== (int)$old['brand_id']) {
                if (!Db::val('SELECT id FROM brands WHERE id=?', [(int)$in['brandId']])) throw ApiError::validation(['brandId' => 'not_found']);
                Db::update('tenants', ['brand_id' => (int)$in['brandId']], ['id' => $id]);
            }
            if (is_array($in['brand'] ?? null)) self::applyBrand((int)($in['brandId'] ?? $old['brand_id']), $in['brand']);
            $row = self::tenantFields($in, false, $old);
            $row['updated_by'] = Auth::id();
            Db::update('tenants', $row, ['id' => $id]);
            if (array_key_exists('hours', $in)) self::saveHours($id, $in['hours']);
            Db::exec('UPDATE tenants SET updated_at=NOW() WHERE id=?', [$id]);
            $after = self::snap($id);
            [$b, $a] = Audit::changed($before, $after);
            Revisions::bump('content');
            Audit::log('update', 'tenant', $id, 'tenant diubah', $b, $a);
        });
        Http::ok(self::get($id));
    }

    public static function delete(array $p): void
    {
        $id = $p['id'];
        Db::tx(function () use ($id) {
            $before = self::snap($id);
            if (!$before) throw ApiError::notFound('Tenant');
            Db::exec('DELETE FROM tenants WHERE id=?', [$id]);
            $left = (int)Db::val('SELECT COUNT(*) FROM tenants WHERE brand_id=?', [$before['brand_id']]);
            if ($left === 0) { Db::exec('DELETE FROM brands WHERE id=?', [$before['brand_id']]); Audit::log('delete', 'brand', (string)$before['brand_id'], 'brand tanpa outlet dihapus'); }
            Revisions::bump('content');
            Audit::log('delete', 'tenant', $id, 'tenant dihapus', $before, null);
        });
        Http::ok(['deleted' => $id]);
    }

    /** Bulk set status / kategori (brand) / isPublished untuk banyak tenant (WP-B). */
    public static function bulk(): void
    {
        $b = Http::body();
        $ids = $b['ids'] ?? null; $set = $b['set'] ?? null;
        if (!is_array($ids) || !$ids || count($ids) > 500) throw ApiError::validation(['ids' => 'array 1..500']);
        if (!is_array($set) || !$set) throw ApiError::validation(['set' => '{status?|categoryId?|isPublished?}']);
        if (isset($set['status']) && !in_array($set['status'], self::STATUS, true)) throw ApiError::validation(['set.status' => 'one_of:' . implode('|', self::STATUS)]);
        if (isset($set['categoryId']) && !Db::val('SELECT id FROM categories WHERE id=?', [$set['categoryId']])) throw ApiError::validation(['set.categoryId' => 'not_found']);
        $n = Db::tx(function () use ($ids, $set) {
            $n = 0;
            foreach (array_unique($ids) as $id) {
                $t = Db::one('SELECT id, brand_id, status, is_published FROM tenants WHERE id=?', [(string)$id]);
                if (!$t) throw ApiError::validation(['ids' => 'not_found:' . $id]);
                $row = [];
                if (isset($set['status'])) $row['status'] = $set['status'];
                if (array_key_exists('isPublished', $set)) $row['is_published'] = Util::bool($set['isPublished']) ? 1 : 0;
                if ($row) Db::update('tenants', $row + ['updated_by' => Auth::id()], ['id' => $t['id']]);
                if (isset($set['categoryId'])) Db::update('brands', ['category_id' => $set['categoryId'], 'updated_by' => Auth::id()], ['id' => $t['brand_id']]);
                Audit::log('update', 'tenant', $t['id'], 'bulk ' . json_encode($set), ['status' => $t['status'], 'is_published' => $t['is_published']], $set);
                $n++;
            }
            Revisions::bump('content');
            return $n;
        });
        Http::ok(['updated' => $n]);
    }

    // ================================================================= brands
    public static function brandRow(int $id): array
    {
        $r = Db::one('SELECT b.*, m.id mb_id, m.path mb_path, m.path_2x mb_path_2x, (SELECT COUNT(*) FROM tenants t WHERE t.brand_id=b.id) b_outlets FROM brands b LEFT JOIN media m ON m.id=b.logo_media_id WHERE b.id=?', [$id]);
        if (!$r) throw ApiError::notFound('Brand');
        return $r;
    }
    public static function brandDto(array $r): array
    {
        $j = ['brand_id' => $r['id'], 'b_slug' => $r['slug'], 'b_name' => $r['name'], 'b_category_id' => $r['category_id'], 'mb_id' => $r['mb_id'],
            'mb_path' => $r['mb_path'], 'mb_path_2x' => $r['mb_path_2x'], 'b_desc_en' => $r['desc_en'], 'b_desc_id' => $r['desc_id'],
            'b_keywords_en' => $r['keywords_en'], 'b_keywords_id' => $r['keywords_id'], 'b_url' => $r['url'], 'b_instagram' => $r['instagram'],
            'b_tiktok' => $r['tiktok'], 'b_facebook' => $r['facebook'], 'b_whatsapp' => $r['whatsapp'], 'b_outlets' => $r['b_outlets']];
        return self::brandDtoFromJoin($j) + ['outlets' => Db::col('SELECT id FROM tenants WHERE brand_id=? ORDER BY id', [$r['id']]), 'etag' => (string)$r['updated_at']];
    }
    public static function brandList(): void
    {
        $w = ''; $p = [];
        if (($q = Http::q('q')) !== null && $q !== '') { $w = ' WHERE b.name LIKE ? OR b.slug LIKE ?'; $p = ["%$q%", "%$q%"]; }
        $total = (int)Db::val('SELECT COUNT(*) FROM brands b' . $w, $p);
        [$page, $per, $lim] = Crud::page();
        $rows = Db::all('SELECT b.*, m.id mb_id, m.path mb_path, m.path_2x mb_path_2x, (SELECT COUNT(*) FROM tenants t WHERE t.brand_id=b.id) b_outlets FROM brands b LEFT JOIN media m ON m.id=b.logo_media_id' . $w . ' ORDER BY b.name' . $lim, $p);
        Http::json(['data' => array_map([self::class, 'brandDto'], $rows), 'total' => $total, 'page' => $page, 'per' => $per]);
    }
    public static function brandCreate(): void
    {
        $b = self::brandFields(Http::body(), true);
        $b['updated_by'] = Auth::id();
        $id = Db::tx(function () use ($b) {
            try { $id = Db::insert('brands', $b); } catch (PDOException $e) { throw Crud::pdoErr($e); }
            Revisions::bump('content');
            Audit::log('create', 'brand', (string)$id, 'brand dibuat: ' . $b['name'], null, $b);
            return $id;
        });
        Http::ok(self::brandDto(self::brandRow($id)), 201);
    }
    public static function brandUpdate(array $p): void
    {
        $id = (int)$p['id'];
        $in = Http::body();
        Db::tx(function () use ($id, $in) {
            $r = self::brandRow($id);
            Crud::checkEtag((string)$r['updated_at'], null);
            if (isset($in['slug']) && $in['slug'] !== $r['slug']) throw ApiError::validation(['slug' => 'immutable']);
            self::applyBrand($id, $in);
            Revisions::bump('content');
        });
        Http::ok(self::brandDto(self::brandRow($id)));
    }
    public static function brandDelete(array $p): void
    {
        $id = (int)$p['id'];
        Db::tx(function () use ($id) {
            $r = self::brandRow($id);
            if ((int)$r['b_outlets'] > 0) throw ApiError::conflict('Brand masih punya outlet', ['outlets' => Db::col('SELECT id FROM tenants WHERE brand_id=?', [$id])]);
            Db::exec('DELETE FROM brands WHERE id=?', [$id]);
            Revisions::bump('content');
            Audit::log('delete', 'brand', (string)$id, 'brand dihapus: ' . $r['name']);
        });
        Http::ok(['deleted' => $id]);
    }

    // ================================================================= CSV
    public const CSV_COLS = ['id', 'displayName', 'brand', 'category', 'floor', 'building', 'unit', 'status', 'hoursMode', 'phone', 'url', 'urlOverride',
        'logo', 'x', 'y', 'node', 'unitShapeId', 'isPublished', 'srcId'];

    public static function exportCsv(): void
    {
        self::$outletCache = null;
        $rows = Db::all(self::SELECT . ' ORDER BY t.id');
        $fh = fopen('php://temp', 'w+');
        fwrite($fh, "\xEF\xBB\xBF");
        fputcsv($fh, self::CSV_COLS);
        foreach ($rows as $r) {
            $d = self::dto($r, []);
            fputcsv($fh, [$d['id'], $d['displayName'], $d['brand']['name'], $d['brand']['categoryId'], $d['floorId'], $d['building'], $d['unitNo'],
                $d['status'], $d['hoursMode'], $d['phone'], $d['brand']['url'], $d['urlOverride'], ($d['logoOverride']['url'] ?? $d['brand']['logo']['url'] ?? ''),
                $d['x'], $d['y'], $d['nodeId'], $d['unitShapeId'], $d['isPublished'] ? 1 : 0, $d['srcId']]);
        }
        rewind($fh);
        $csv = stream_get_contents($fh);
        Audit::log('export', 'tenant', null, 'export CSV ' . count($rows) . ' tenant');
        if (Http::$captured !== null) { Http::$captured = ['status' => 200, 'body' => $csv, 'headers' => []]; return; }
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="tenants-' . date('Ymd-Hi') . '.csv"');
        header('Cache-Control: no-store');
        Http::securityHeaders();
        echo $csv;
    }

    /** Import CSV (S): kolom sama dengan export; ?dryRun=1 hanya rencana. Update tenant yang ada; id baru → tenant baru (belum ditempatkan). */
    public static function importCsv(): void
    {
        $dry = Util::bool(Http::q('dryRun', '0'));
        $raw = isset($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name']) ? (string)file_get_contents($_FILES['file']['tmp_name']) : Http::rawBody(2_000_000);
        $raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw);
        $lines = array_values(array_filter(preg_split('/\R/', (string)$raw), fn($l) => trim($l) !== ''));
        if (count($lines) < 2) throw ApiError::validation(['file' => 'empty_csv']);
        $head = array_map('trim', str_getcsv(array_shift($lines)));
        if (!in_array('id', $head, true)) throw ApiError::validation(['file' => 'missing_id_column']);
        $plan = []; $errors = [];
        foreach ($lines as $n => $line) {
            $vals = str_getcsv($line);
            $r = [];
            foreach ($head as $i => $h) $r[$h] = isset($vals[$i]) ? trim($vals[$i]) : null;
            $id = (string)$r['id'];
            $old = $id !== '' ? Db::one('SELECT t.*, b.name brand_name, b.category_id FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE t.id=?', [$id]) : null;
            $ch = [];
            $map = ['unit' => 'unit_no', 'status' => 'status', 'hoursMode' => 'hours_mode', 'phone' => 'phone', 'urlOverride' => 'url_override', 'isPublished' => 'is_published', 'building' => 'building'];
            foreach ($map as $k => $c) {
                if (!array_key_exists($k, $r) || $r[$k] === null) continue;
                $v = $r[$k] === '' ? null : $r[$k];
                if ($k === 'status' && !in_array($v, self::STATUS, true)) { $errors[] = ['line' => $n + 2, 'field' => $k, 'msg' => 'status tidak valid']; continue; }
                if ($k === 'hoursMode' && !in_array($v, self::HOURS_MODE, true)) { $errors[] = ['line' => $n + 2, 'field' => $k, 'msg' => 'hoursMode tidak valid']; continue; }
                if ($k === 'urlOverride' && $v !== null && !str_starts_with($v, 'https://')) { $errors[] = ['line' => $n + 2, 'field' => $k, 'msg' => 'url harus https']; continue; }
                if ($k === 'isPublished') $v = Util::bool($v) ? 1 : 0;
                if ($k === 'building' && !in_array($v, ['pentacity', 'ewalk'], true)) continue;
                if (!$old || (string)$old[$c] !== (string)$v) $ch[$c] = $v;
            }
            if ($old) { if ($ch) $plan[] = ['action' => 'update', 'id' => $id, 'changes' => $ch]; }
            else {
                $floor = $r['floor'] ?? null; $cat = $r['category'] ?? null; $brand = $r['brand'] ?? null;
                if (!$brand || !$floor || !Db::val('SELECT id FROM floors WHERE id=?', [$floor]) || !Db::val('SELECT id FROM categories WHERE id=?', [(string)$cat])) {
                    $errors[] = ['line' => $n + 2, 'field' => 'id', 'msg' => 'tenant baru butuh brand, category & floor valid']; continue;
                }
                $plan[] = ['action' => 'create', 'id' => $id ?: null, 'brand' => $brand, 'category' => $cat, 'floor' => $floor, 'changes' => $ch];
            }
        }
        if (!$dry && !$errors) {
            Db::tx(function () use (&$plan) {
                foreach ($plan as &$p) {
                    if ($p['action'] === 'update') {
                        Db::update('tenants', $p['changes'] + ['updated_by' => Auth::id()], ['id' => $p['id']]);
                        Audit::log('update', 'tenant', $p['id'], 'import CSV', null, $p['changes']);
                    } else {
                        $bid = Db::val('SELECT id FROM brands WHERE name=?', [$p['brand']]);
                        if (!$bid) { $s = Util::slug($p['brand']); $base = $s; $i = 2; while (Db::val('SELECT id FROM brands WHERE slug=?', [$s])) $s = $base . '-' . $i++;
                            $bid = Db::insert('brands', ['slug' => $s, 'name' => $p['brand'], 'category_id' => $p['category'], 'updated_by' => Auth::id()]); }
                        $id = $p['id'] ?: Util::slug($p['brand'] . '-' . $p['floor']);
                        $base = $id; $i = 2; while (Db::val('SELECT id FROM tenants WHERE id=?', [$id])) $id = $base . '-' . $i++;
                        $f = Db::one('SELECT building FROM floors WHERE id=?', [$p['floor']]);
                        Db::insert('tenants', $p['changes'] + ['id' => $id, 'brand_id' => (int)$bid, 'floor_id' => $p['floor'],
                            'building' => $f['building'] !== 'both' ? $f['building'] : ($p['changes']['building'] ?? 'pentacity'), 'is_published' => 0, 'updated_by' => Auth::id()]);
                        $p['id'] = $id;
                        Audit::log('create', 'tenant', $id, 'import CSV (belum ditempatkan, belum terpublish)');
                    }
                }
                if ($plan) Revisions::bump('content');
            });
        }
        Http::ok(['dryRun' => $dry, 'applied' => !$dry && !$errors, 'plan' => $plan, 'errors' => $errors,
            'summary' => ['update' => count(array_filter($plan, fn($p) => $p['action'] === 'update')), 'create' => count(array_filter($plan, fn($p) => $p['action'] === 'create')), 'errors' => count($errors)]]);
    }
}
