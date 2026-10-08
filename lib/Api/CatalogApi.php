<?php
declare(strict_types=1);

/** Resource CRUD generik: categories, amenity-types, schedules, amenities, floors, kiosks, promos, events, users + i18n, featured, settings. */
final class CatalogApi
{
    public static function defs(): array
    {
        static $defs = null;
        if ($defs !== null) return $defs;
        $hex = ['color'];
        $defs = [
            'categories' => [
                'table' => 'categories', 'pk' => 'id', 'pkType' => 'str', 'entity' => 'category', 'label' => 'Kategori', 'scope' => 'content', 'perm' => 'categories.edit',
                'search' => ['id', 'name_en', 'name_id'], 'defaultSort' => 'sortOrder',
                'fields' => [
                    'id' => ['id', 'slug', ['required' => true]], 'nameEn' => ['name_en', 'str', ['required' => true, 'max' => 80]],
                    'nameId' => ['name_id', 'str', ['required' => true, 'max' => 80]], 'icon' => ['icon', 'str', ['required' => true, 'max' => 48, 'pattern' => '/^[a-z0-9-]+$/']],
                    'color' => ['color', 'color', ['default' => '#857B70']], 'sortOrder' => ['sort_order', 'int', ['default' => 0]],
                    'isActive' => ['is_active', 'bool', ['default' => 1]],
                ],
                'hooks' => [
                    'dto' => function ($r, $o) { $o['tenantCount'] = (int)Db::val('SELECT COUNT(*) FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE b.category_id=?', [$r['id']]); return $o; },
                    'canDelete' => function ($id) { if (Db::val('SELECT COUNT(*) FROM brands WHERE category_id=?', [$id])) throw ApiError::conflict('Kategori masih dipakai brand'); },
                ],
            ],
            'amenity-types' => [
                'table' => 'amenity_types', 'pk' => 'id', 'pkType' => 'str', 'entity' => 'amenity_type', 'label' => 'Tipe fasilitas', 'scope' => 'map', 'perm' => 'amenities.edit',
                'defaultSort' => 'sortOrder',
                'fields' => [
                    'id' => ['id', 'slug', ['required' => true]], 'nameEn' => ['name_en', 'str', ['required' => true, 'max' => 60]],
                    'nameId' => ['name_id', 'str', ['required' => true, 'max' => 60]], 'icon' => ['icon', 'str', ['required' => true, 'max' => 48, 'pattern' => '/^[a-z0-9-]+$/']],
                    'color' => ['color', 'color', ['default' => '#2F5BEA']], 'showInHome' => ['show_in_home', 'bool', ['default' => 0]],
                    'sortOrder' => ['sort_order', 'int', ['default' => 0]],
                ],
                'hooks' => [
                    'dto' => function ($r, $o) { $o['count'] = (int)Db::val('SELECT COUNT(*) FROM amenities WHERE type_id=?', [$r['id']]); return $o; },
                    'canDelete' => function ($id) { if (Db::val('SELECT COUNT(*) FROM amenities WHERE type_id=?', [$id])) throw ApiError::conflict('Tipe masih dipakai fasilitas'); },
                    'before' => function (&$row) { if (!empty($row['show_in_home']) && (int)Db::val('SELECT COUNT(*) FROM amenity_types WHERE show_in_home=1 AND id<>?', [$row['id'] ?? '']) >= 6) throw ApiError::validation(['showInHome' => 'max_6']); },
                ],
            ],
            'schedules' => [
                'table' => 'schedules', 'pk' => 'id', 'pkAuto' => true, 'entity' => 'schedule', 'label' => 'Jadwal', 'scope' => 'map',
                'perm' => ['connectors.edit', 'graph.edit', 'amenities.edit'], 'defaultSort' => 'name', 'search' => ['name'],
                'fields' => ['id' => ['id', 'int', ['readonly' => true]], 'name' => ['name', 'str', ['required' => true, 'max' => 80]], 'note' => ['note', 'str', ['nullable' => true, 'max' => 255]]],
                'hooks' => [
                    'dto' => function ($r, $o) {
                        $rules = Db::all('SELECT dow, open_time, close_time FROM schedule_rules WHERE schedule_id=? ORDER BY dow, open_time', [$r['id']]);
                        $o['rules'] = array_map(fn($x) => ['dow' => (int)$x['dow'], 'open' => Util::hhmm($x['open_time']), 'close' => $x['close_time'] >= '23:59:00' ? '24:00' : Util::hhmm($x['close_time'])], $rules);
                        $o['hours'] = Schedule::fromRules($rules);
                        $o['usedBy'] = ['legs' => (int)Db::val('SELECT COUNT(*) FROM connector_legs WHERE schedule_id=?', [$r['id']]),
                            'banks' => (int)Db::val('SELECT COUNT(*) FROM connector_banks WHERE schedule_id=?', [$r['id']]),
                            'edges' => (int)Db::val('SELECT COUNT(*) FROM graph_edges WHERE schedule_id=?', [$r['id']]),
                            'amenities' => (int)Db::val('SELECT COUNT(*) FROM amenities WHERE schedule_id=?', [$r['id']])];
                        return $o;
                    },
                    'after' => function ($id, $in) { if (array_key_exists('rules', $in)) self::saveRules((int)$id, $in['rules']); },
                ],
                'alwaysBump' => true,
            ],
            'amenities' => [
                'table' => 'amenities', 'pk' => 'id', 'pkType' => 'str', 'entity' => 'amenity', 'label' => 'Fasilitas', 'scope' => 'map', 'perm' => 'amenities.edit',
                'cols' => ['updated_by'], 'search' => ['id', 'name_en', 'name_id'], 'filters' => ['floor' => 'floor_id', 'type' => 'type_id', 'building' => 'building'],
                'fields' => [
                    'id' => ['id', 'slug', ['required' => true]], 'typeId' => ['type_id', 'str', ['required' => true, 'max' => 32]],
                    'floorId' => ['floor_id', 'str', ['required' => true, 'max' => 32]], 'building' => ['building', 'enum', ['values' => ['pentacity', 'ewalk'], 'nullable' => true]],
                    'x' => ['x', 'float', ['required' => true]], 'y' => ['y', 'float', ['required' => true]], 'nodeId' => ['node_id', 'int', ['nullable' => true]],
                    'nameEn' => ['name_en', 'str', ['nullable' => true, 'max' => 80]], 'nameId' => ['name_id', 'str', ['nullable' => true, 'max' => 80]],
                    'detailEn' => ['detail_en', 'str', ['nullable' => true, 'max' => 160]], 'detailId' => ['detail_id', 'str', ['nullable' => true, 'max' => 160]],
                    'isWheelchair' => ['is_wheelchair', 'bool', ['default' => 0]], 'gender' => ['gender', 'enum', ['values' => ['all', 'male', 'female', 'family'], 'default' => 'all']],
                    'scheduleId' => ['schedule_id', 'int', ['nullable' => true]], 'isPublished' => ['is_published', 'bool', ['default' => 1]],
                ],
                'hooks' => ['before' => fn(&$row, $in, $old) => self::checkPlacement($row, $old, 'amenity')],
            ],
            'floors' => [
                'table' => 'floors', 'pk' => 'id', 'pkType' => 'str', 'entity' => 'floor', 'label' => 'Lantai', 'scope' => 'map', 'perm' => 'floors.edit',
                'cols' => ['updated_by'], 'defaultSort' => 'sortOrder',
                'fields' => [
                    'id' => ['id', 'slug', ['required' => true]], 'level' => ['level', 'int', ['required' => true, 'min' => -5, 'max' => 20]],
                    'short' => ['short', 'str', ['required' => true, 'max' => 8]], 'nameEn' => ['name_en', 'str', ['required' => true, 'max' => 80]],
                    'nameId' => ['name_id', 'str', ['required' => true, 'max' => 80]], 'building' => ['building', 'enum', ['values' => ['pentacity', 'ewalk', 'both'], 'required' => true]],
                    'svgMediaId' => ['svg_media_id', 'int', ['required' => true]], 'unitScale' => ['unit_scale', 'float', ['default' => 1, 'min' => 0.0001, 'max' => 100]],
                    'northDeg' => ['north_deg', 'float', ['nullable' => true, 'min' => 0, 'max' => 359.9]], 'sortOrder' => ['sort_order', 'int', ['default' => 0]],
                    'isActive' => ['is_active', 'bool', ['default' => 1]],
                ],
                'hooks' => [
                    'dto' => function ($r, $o) {
                        $m = Db::one('SELECT path FROM media WHERE id=?', [$r['svg_media_id']]);
                        $o['svgUrl'] = $m['path'] ?? null;
                        $o['viewBox'] = [(float)$r['vb_x'], (float)$r['vb_y'], (float)$r['vb_w'], (float)$r['vb_h']];
                        $o['focus'] = new stdClass();
                        foreach (Db::all('SELECT * FROM floor_focus WHERE floor_id=?', [$r['id']]) as $f) $o['focus']->{$f['building']} = [(float)$f['x'], (float)$f['y'], (float)$f['w'], (float)$f['h']];
                        return $o;
                    },
                    'before' => function (&$row, $in, $old) {
                        if (isset($in['viewBox'])) {
                            $vb = $in['viewBox'];
                            if (!is_array($vb) || count($vb) !== 4 || array_filter($vb, fn($x) => !is_numeric($x))) throw ApiError::validation(['viewBox' => '[x,y,w,h]']);
                            [$row['vb_x'], $row['vb_y'], $row['vb_w'], $row['vb_h']] = array_map('floatval', $vb);
                        } elseif (!$old && isset($row['svg_media_id'])) {
                            $m = Db::one("SELECT * FROM media WHERE id=? AND kind='svg'", [$row['svg_media_id']]);
                            if (!$m) throw ApiError::validation(['svgMediaId' => 'not_found']);
                            $vb = SvgSanitizer::sanitize((string)file_get_contents(APP_ROOT . '/' . $m['path']))[1]['viewBox'] ?? null;
                            if (!$vb) throw ApiError::validation(['viewBox' => 'required']);
                            [$row['vb_x'], $row['vb_y'], $row['vb_w'], $row['vb_h']] = $vb;
                        }
                        if (isset($row['svg_media_id']) && !Db::val("SELECT id FROM media WHERE id=? AND kind='svg'", [$row['svg_media_id']])) throw ApiError::validation(['svgMediaId' => 'not_found']);
                    },
                    'after' => function ($id, $in) {
                        if (!isset($in['focus'])) return;
                        if (!is_array($in['focus'])) throw ApiError::validation(['focus' => 'object']);
                        Db::exec('DELETE FROM floor_focus WHERE floor_id=?', [$id]);
                        foreach ($in['focus'] as $b => $r) {
                            if (!in_array($b, ['pentacity', 'ewalk'], true) || !is_array($r) || count($r) !== 4) throw ApiError::validation(['focus' => '{building:[x,y,w,h]}']);
                            Db::insert('floor_focus', ['floor_id' => $id, 'building' => $b, 'x' => (float)$r[0], 'y' => (float)$r[1], 'w' => (float)$r[2], 'h' => (float)$r[3]]);
                        }
                    },
                    'canDelete' => function ($id) {
                        foreach (['tenants', 'kiosks', 'amenities', 'graph_nodes'] as $t) if (Db::val("SELECT COUNT(*) FROM $t WHERE floor_id=?", [$id])) throw ApiError::conflict("Lantai masih dipakai ($t) — nonaktifkan saja");
                    },
                ],
                'alwaysBump' => true,
            ],
            'kiosks' => [
                'table' => 'kiosks', 'pk' => 'id', 'pkType' => 'str', 'entity' => 'kiosk', 'label' => 'Kiosk', 'perm' => 'kiosks.edit',
                'scope' => 'map', 'cols' => ['updated_by'], 'search' => ['id', 'name'], 'filters' => ['floor' => 'floor_id', 'building' => 'building'],
                'fields' => [
                    'id' => ['id', 'slug', ['required' => true]], 'name' => ['name', 'str', ['required' => true, 'max' => 80]],
                    'floorId' => ['floor_id', 'str', ['required' => true, 'max' => 32]], 'building' => ['building', 'enum', ['values' => ['pentacity', 'ewalk'], 'nullable' => true]],
                    'x' => ['x', 'float', ['required' => true]], 'y' => ['y', 'float', ['required' => true]], 'nodeId' => ['node_id', 'int', ['nullable' => true]],
                    'facingDeg' => ['facing_deg', 'int', ['nullable' => true, 'min' => 0, 'max' => 359]],
                    'defaultLang' => ['default_lang', 'enum', ['values' => ['en', 'id'], 'default' => 'en']], 'attractLang' => ['attract_lang', 'enum', ['values' => ['en', 'id'], 'default' => 'en']],
                    'clientType' => ['client_type', 'enum', ['values' => ['windows_pc', 'smart_tv', 'android_box', 'other'], 'default' => 'windows_pc']],
                    'perfMode' => ['perf_mode', 'enum', ['values' => ['auto', 'full', 'lite'], 'default' => 'auto']],
                    'isActive' => ['is_active', 'bool', ['default' => 1]], 'tokenHint' => ['token_hint', 'str', ['readonly' => true]],
                    'hwNote' => ['hw_note', 'str', ['nullable' => true, 'max' => 255]], 'srcId' => ['src_id', 'str', ['readonly' => true]],
                ],
                'hooks' => [
                    'dto' => fn($r, $o) => $o + ['runtime' => KiosksApi::runtime($r)],
                    'before' => fn(&$row, $in, $old) => self::checkPlacement($row, $old, 'kiosk'),
                ],
            ],
            'promos' => [
                'table' => 'promos', 'pk' => 'id', 'pkAuto' => true, 'entity' => 'promo', 'label' => 'Promo', 'scope' => 'promos', 'perm' => 'promos.edit',
                'cols' => ['updated_by', 'created_by'], 'search' => ['title_en', 'title_id', 'advertiser_name'], 'filters' => ['status' => 'status', 'slot' => 'slot', 'kind' => 'kind'],
                'defaultSort' => '-startsAt', 'sort' => ['startsAt' => 'starts_at', 'endsAt' => 'ends_at', 'updatedAt' => 'updated_at'],
                'fields' => [
                    'id' => ['id', 'int', ['readonly' => true]], 'titleEn' => ['title_en', 'str', ['required' => true, 'max' => 120]], 'titleId' => ['title_id', 'str', ['required' => true, 'max' => 120]],
                    'subEn' => ['sub_en', 'str', ['nullable' => true, 'max' => 200]], 'subId' => ['sub_id', 'str', ['nullable' => true, 'max' => 200]],
                    'kind' => ['kind', 'enum', ['values' => ['text', 'image', 'video'], 'default' => 'image']],
                    'mediaId' => ['media_id', 'int', ['nullable' => true]], 'posterMediaId' => ['poster_media_id', 'int', ['nullable' => true]],
                    'bgColor' => ['bg_color', 'color', ['nullable' => true]],
                    'slot' => ['slot', 'enum', ['values' => ['attract-hero', 'attract-fullscreen', 'panel-banner', 'phone-arrival'], 'default' => 'attract-hero']],
                    'linkType' => ['link_type', 'enum', ['values' => ['none', 'tenant', 'category', 'event', 'url'], 'default' => 'none']],
                    'linkRef' => ['link_ref', 'str', ['nullable' => true, 'max' => 500]],
                    'startsAt' => ['starts_at', 'datetime', ['required' => true]], 'endsAt' => ['ends_at', 'datetime', ['required' => true]],
                    'daysMask' => ['days_mask', 'int', ['default' => 127, 'min' => 0, 'max' => 127]],
                    'timeFrom' => ['time_from', 'time', ['nullable' => true]], 'timeTo' => ['time_to', 'time', ['nullable' => true]],
                    'durationSec' => ['duration_sec', 'int', ['default' => 8, 'min' => 3, 'max' => 30]], 'weight' => ['weight', 'int', ['default' => 5, 'min' => 1, 'max' => 10]],
                    'status' => ['status', 'enum', ['values' => ['draft', 'active', 'paused', 'archived'], 'default' => 'draft']],
                    'allKiosks' => ['all_kiosks', 'bool', ['default' => 1]], 'advertiserTenantId' => ['advertiser_tenant_id', 'str', ['nullable' => true, 'max' => 64]],
                    'advertiserName' => ['advertiser_name', 'str', ['nullable' => true, 'max' => 120]], 'maxImpressions' => ['max_impressions', 'int', ['nullable' => true, 'min' => 0]],
                    'createdAt' => ['created_at', 'datetime', ['readonly' => true]], 'updatedAt' => ['updated_at', 'datetime', ['readonly' => true]],
                ],
                'hooks' => [
                    'dto' => function ($r, $o) {
                        $o['targets'] = Db::col('SELECT kiosk_id FROM promo_targets WHERE promo_id=? ORDER BY kiosk_id', [$r['id']]);
                        $o['days'] = array_values(array_filter(range(1, 7), fn($d) => (int)$r['days_mask'] & (1 << ($d - 1))));
                        $o['media'] = Media::url(Db::one('SELECT * FROM media WHERE id=?', [$r['media_id']]));
                        $o['poster'] = Media::url(Db::one('SELECT * FROM media WHERE id=?', [$r['poster_media_id']]));
                        $o['stats'] = ['impressions' => (int)Db::val("SELECT COALESCE(SUM(value),0) FROM stats_daily WHERE metric='promo_imp' AND dim=?", [(string)$r['id']]),
                            'taps' => (int)Db::val("SELECT COALESCE(SUM(value),0) FROM stats_daily WHERE metric='promo_tap' AND dim=?", [(string)$r['id']])];
                        return $o;
                    },
                    'before' => function (&$row, $in, $old) { self::promoCheck($row, $in, $old); },
                    'after' => function ($id, $in) {
                        if (!array_key_exists('targets', $in)) return;
                        if (!is_array($in['targets'])) throw ApiError::validation(['targets' => 'array']);
                        Db::exec('DELETE FROM promo_targets WHERE promo_id=?', [$id]);
                        foreach (array_unique($in['targets']) as $k) {
                            if (!Db::val('SELECT id FROM kiosks WHERE id=?', [(string)$k])) throw ApiError::validation(['targets' => 'kiosk_not_found:' . $k]);
                            Db::insert('promo_targets', ['promo_id' => (int)$id, 'kiosk_id' => (string)$k]);
                        }
                    },
                ],
                'alwaysBump' => true,
            ],
            'events' => [
                'table' => 'events', 'pk' => 'id', 'pkAuto' => true, 'entity' => 'event', 'label' => 'Event', 'scope' => 'promos', 'perm' => 'events.edit',
                'cols' => ['updated_by'], 'search' => ['title_en', 'title_id'], 'defaultSort' => '-startsAt', 'sort' => ['startsAt' => 'starts_at'],
                'fields' => [
                    'id' => ['id', 'int', ['readonly' => true]], 'titleEn' => ['title_en', 'str', ['required' => true, 'max' => 120]], 'titleId' => ['title_id', 'str', ['required' => true, 'max' => 120]],
                    'descEn' => ['desc_en', 'text', ['nullable' => true]], 'descId' => ['desc_id', 'text', ['nullable' => true]], 'mediaId' => ['media_id', 'int', ['nullable' => true]],
                    'startsAt' => ['starts_at', 'datetime', ['required' => true]], 'endsAt' => ['ends_at', 'datetime', ['required' => true]],
                    'locationType' => ['location_type', 'enum', ['values' => ['tenant', 'amenity', 'point', 'text'], 'default' => 'text']],
                    'tenantId' => ['tenant_id', 'str', ['nullable' => true, 'max' => 64]], 'amenityId' => ['amenity_id', 'str', ['nullable' => true, 'max' => 64]],
                    'floorId' => ['floor_id', 'str', ['nullable' => true, 'max' => 32]], 'x' => ['x', 'float', ['nullable' => true]], 'y' => ['y', 'float', ['nullable' => true]],
                    'nodeId' => ['node_id', 'int', ['nullable' => true]], 'locationTextEn' => ['location_text_en', 'str', ['nullable' => true, 'max' => 160]],
                    'locationTextId' => ['location_text_id', 'str', ['nullable' => true, 'max' => 160]], 'showOnAttract' => ['show_on_attract', 'bool', ['default' => 1]],
                    'isPublished' => ['is_published', 'bool', ['default' => 0]],
                ],
                'hooks' => [
                    'dto' => function ($r, $o) { $o['media'] = Media::url(Db::one('SELECT * FROM media WHERE id=?', [$r['media_id']])); return $o; },
                    'before' => function (&$row, $in, $old) {
                        $s = $row['starts_at'] ?? $old['starts_at'] ?? null; $e = $row['ends_at'] ?? $old['ends_at'] ?? null;
                        if ($s && $e && $e <= $s) throw ApiError::validation(['endsAt' => 'after_startsAt']);
                        $lt = $row['location_type'] ?? $old['location_type'] ?? 'text';
                        $need = ['tenant' => 'tenant_id', 'amenity' => 'amenity_id', 'point' => 'floor_id'][$lt] ?? null;
                        if ($need && empty($row[$need] ?? $old[$need] ?? null)) throw ApiError::validation([Util::camel($need) => 'required_for_' . $lt]);
                    },
                ],
                'alwaysBump' => true,
            ],
            'users' => [
                'table' => 'users', 'pk' => 'id', 'pkAuto' => true, 'entity' => 'user', 'label' => 'User', 'perm' => 'users.manage', 'search' => ['email', 'name'],
                'filters' => ['role' => 'role'],
                'fields' => [
                    'id' => ['id', 'int', ['readonly' => true]], 'email' => ['email', 'str', ['required' => true, 'max' => 190, 'pattern' => '/^[^@\s]+@[^@\s]+\.[^@\s]+$/']],
                    'name' => ['name', 'str', ['required' => true, 'max' => 120]],
                    'role' => ['role', 'enum', ['values' => array_keys(Permissions::ROLES), 'default' => 'viewer']],
                    'isActive' => ['is_active', 'bool', ['default' => 1]], 'mustChangePassword' => ['must_change_password', 'bool', ['default' => 1]],
                    'lastLoginAt' => ['last_login_at', 'datetime', ['readonly' => true]], 'lockedUntil' => ['locked_until', 'datetime', ['readonly' => true]],
                    'failedCount' => ['failed_count', 'int', ['readonly' => true]], 'createdAt' => ['created_at', 'datetime', ['readonly' => true]],
                ],
                'hooks' => [
                    'dto' => fn($r, $o) => $o + ['permissions' => Permissions::forRole($r['role'])],
                    'before' => function (&$row, $in, $old) {
                        if (isset($row['email'])) $row['email'] = strtolower($row['email']);
                        if (!$old) {
                            $pw = (string)($in['password'] ?? '');
                            if ($e = Auth::checkPolicy($pw, $row['email'] ?? '')) throw ApiError::validation(['password' => $e]);
                            $row['password_hash'] = Auth::hash($pw);
                            $row['password_changed_at'] = Util::now();
                        } else {
                            $me = Auth::id();
                            if ((int)$old['id'] === $me && ((isset($row['is_active']) && !$row['is_active']) || (isset($row['role']) && $row['role'] !== $old['role'])))
                                throw ApiError::validation(['role' => 'cannot_change_self']);
                            if ($old['role'] === 'superadmin' && ((isset($row['role']) && $row['role'] !== 'superadmin') || (isset($row['is_active']) && !$row['is_active']))
                                && (int)Db::val("SELECT COUNT(*) FROM users WHERE role='superadmin' AND is_active=1") <= 1) throw ApiError::validation(['role' => 'last_superadmin']);
                            if (!empty($in['password'])) {
                                if ($e = Auth::checkPolicy((string)$in['password'], $old['email'])) throw ApiError::validation(['password' => $e]);
                                $row['password_hash'] = Auth::hash((string)$in['password']);
                                $row['password_changed_at'] = Util::now();
                                if (!array_key_exists('must_change_password', $row)) $row['must_change_password'] = 1;
                            }
                            if (!empty($in['unlock'])) { $row['locked_until'] = null; $row['failed_count'] = 0; }
                        }
                    },
                    'canDelete' => function ($id, $old) {
                        if ((int)$id === Auth::id()) throw ApiError::validation(['id' => 'cannot_delete_self']);
                        if ($old['role'] === 'superadmin' && (int)Db::val("SELECT COUNT(*) FROM users WHERE role='superadmin' AND is_active=1") <= 1) throw ApiError::validation(['id' => 'last_superadmin']);
                    },
                ],
            ],
        ];
        return $defs;
    }

    /** Integrasi: DTO mengembalikan media sebagai objek {id,url}; terima bentuk yang sama saat create/update
     *  (`media:{id}` → mediaId, `poster:{id}` → posterMediaId) bila field *Id tidak dikirim. */
    private static function mediaIn(array $def, array $in): array
    {
        foreach (['media' => 'mediaId', 'poster' => 'posterMediaId'] as $obj => $idKey) {
            if (!isset($def['fields'][$idKey]) || array_key_exists($idKey, $in) || !array_key_exists($obj, $in)) continue;
            $v = $in[$obj];
            $in[$idKey] = is_array($v) ? ($v['id'] ?? null) : (is_numeric($v) ? (int)$v : null);
        }
        return $in;
    }

    public static function register(Router $r): void
    {
        foreach (self::defs() as $path => $def) {
            $base = '/admin/' . $path;
            $read = ['admin' => true] + ($path === 'users' ? ['perm' => 'users.manage'] : []);
            $w = ['admin' => true, 'perm' => $def['perm']];
            $r->get($base, fn() => Http::json(Crud::list($def)), $read);
            $r->get($base . '/{id}', fn($p) => Http::ok(Crud::get($def, $p['id'])), $read);
            $r->post($base, fn() => Http::ok(Crud::create($def, self::mediaIn($def, Http::body())), 201), $w);
            $r->put($base . '/{id}', fn($p) => Http::ok(Crud::update($def, $p['id'], self::mediaIn($def, Http::body()))), $w);
            $r->delete($base . '/{id}', function ($p) use ($def) { Crud::delete($def, $p['id']); Http::ok(['deleted' => $p['id']]); }, $w);
        }
        $r->post('/admin/categories/reorder', fn() => self::reorder('categories', 'content', 'categories.edit'), ['admin' => true, 'perm' => 'categories.edit']);
        $r->post('/admin/amenity-types/reorder', fn() => self::reorder('amenity_types', 'map', 'amenities.edit'), ['admin' => true, 'perm' => 'amenities.edit']);
        $r->post('/admin/users/{id}/reset-password', [self::class, 'resetPassword'], ['admin' => true, 'perm' => 'users.manage']);
        // i18n
        $r->get('/admin/i18n', [self::class, 'i18nList'], ['admin' => true]);
        $r->put('/admin/i18n/{key}', [self::class, 'i18nPut'], ['admin' => true, 'perm' => 'i18n.edit']);
        $r->delete('/admin/i18n/{key}', [self::class, 'i18nDelete'], ['admin' => true, 'perm' => 'i18n.edit']);
        // featured
        $r->get('/admin/featured', [self::class, 'featuredGet'], ['admin' => true]);
        $r->put('/admin/featured', [self::class, 'featuredPut'], ['admin' => true, 'perm' => 'featured.edit']);
        // settings
        $r->get('/admin/settings', [self::class, 'settingsGet'], ['admin' => true]);
        $r->put('/admin/settings/{key}', [self::class, 'settingsPut'], ['admin' => true, 'perm' => 'settings.edit']);
    }

    // ---------------------------------------------------------------- helpers
    public static function saveRules(int $id, $rules): void
    {
        if (!is_array($rules)) throw ApiError::validation(['rules' => 'array']);
        Db::exec('DELETE FROM schedule_rules WHERE schedule_id=?', [$id]);
        $seen = [];
        foreach ($rules as $i => $r) {
            $d = (int)($r['dow'] ?? 0); $o = (string)($r['open'] ?? ''); $c = (string)($r['close'] ?? '');
            if ($d < 1 || $d > 7 || !preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $o) || !preg_match('/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/', $c)) throw ApiError::validation(["rules.$i" => '{dow:1..7, open:HH:MM, close:HH:MM}']);
            if (isset($seen["$d|$o"])) throw ApiError::validation(["rules.$i" => 'duplicate']);
            $seen["$d|$o"] = true;
            Db::insert('schedule_rules', ['schedule_id' => $id, 'dow' => $d, 'open_time' => $o . ':00', 'close_time' => $c === '24:00' ? '23:59:59' : $c . ':00']);
        }
        Schedule::flush();
    }

    /** Lantai/node/viewBox/gedung untuk kiosk & amenity. */
    public static function checkPlacement(array &$row, ?array $old, string $what): void
    {
        $floorId = $row['floor_id'] ?? $old['floor_id'] ?? null;
        $f = $floorId ? Db::one('SELECT * FROM floors WHERE id=?', [$floorId]) : null;
        if (!$f) throw ApiError::validation(['floorId' => 'not_found']);
        $nid = array_key_exists('node_id', $row) ? $row['node_id'] : ($old['node_id'] ?? null);
        if ($nid !== null) {
            $nf = Db::val('SELECT floor_id FROM graph_nodes WHERE id=?', [$nid]);
            if ($nf === null) throw ApiError::validation(['nodeId' => 'not_found']);
            if ($nf !== $f['id']) throw ApiError::validation(['nodeId' => 'node_on_other_floor:' . $nf]);
        }
        $x = $row['x'] ?? $old['x'] ?? null; $y = $row['y'] ?? $old['y'] ?? null;
        if ($x !== null && ($x < $f['vb_x'] || $y < $f['vb_y'] || $x > $f['vb_x'] + $f['vb_w'] || $y > $f['vb_y'] + $f['vb_h'])) throw ApiError::validation(['x' => 'outside_viewbox']);
        if (isset($row['x'])) $row['x'] = round((float)$row['x'], 2);
        if (isset($row['y'])) $row['y'] = round((float)$row['y'], 2);
        if ($f['building'] !== 'both') $row['building'] = $f['building'];
        elseif (empty($row['building']) && empty($old['building'])) $row['building'] = TenantsApi::guessBuilding($f['id'], $x, $y);
        elseif (array_key_exists('building', $row) && $row['building'] === null) $row['building'] = $old['building'] ?? TenantsApi::guessBuilding($f['id'], $x, $y);
        if ($what === 'amenity') {
            if (isset($row['type_id']) && !Db::val('SELECT id FROM amenity_types WHERE id=?', [$row['type_id']])) throw ApiError::validation(['typeId' => 'not_found']);
            if (!empty($row['schedule_id']) && !Db::val('SELECT id FROM schedules WHERE id=?', [$row['schedule_id']])) throw ApiError::validation(['scheduleId' => 'not_found']);
            if ($nid !== null && Db::val('SELECT id FROM connector_stops WHERE node_id=?', [$nid])) throw ApiError::validation(['nodeId' => 'W_POI_NODE: node konektor tidak boleh dipakai POI']);
        }
    }

    private static function promoCheck(array &$row, array $in, ?array $old): void
    {
        if (isset($in['days']) && is_array($in['days'])) {
            $m = 0; foreach ($in['days'] as $d) { $d = (int)$d; if ($d < 1 || $d > 7) throw ApiError::validation(['days' => '1..7']); $m |= 1 << ($d - 1); }
            $row['days_mask'] = $m;
        }
        $g = fn($k) => array_key_exists($k, $row) ? $row[$k] : ($old[$k] ?? null);
        if ($g('starts_at') && $g('ends_at') && $g('ends_at') <= $g('starts_at')) throw ApiError::validation(['endsAt' => 'after_startsAt']);
        if (($g('time_from') === null) !== ($g('time_to') === null)) throw ApiError::validation(['timeTo' => 'both_or_none']);
        $kind = $g('kind');
        if ($kind !== 'text' && $g('status') === 'active' && !$g('media_id')) throw ApiError::validation(['mediaId' => 'required_for_' . $kind]);
        if ($mid = $g('media_id')) {
            $mk = Db::val('SELECT kind FROM media WHERE id=?', [$mid]);
            if (!$mk) throw ApiError::validation(['mediaId' => 'not_found']);
            if ($kind === 'video' && $mk !== 'video') throw ApiError::validation(['mediaId' => 'must_be_video']);
            if ($kind === 'image' && !in_array($mk, ['image', 'logo'], true)) throw ApiError::validation(['mediaId' => 'must_be_image']);
            if ($kind === 'video') {
                $d = (float)Db::val('SELECT duration_sec FROM media WHERE id=?', [$mid]);
                if ($d > 0 && !array_key_exists('duration_sec', $row)) $row['duration_sec'] = (int)min(30, ceil($d));
            }
        }
        if ($kind === 'video' && $g('status') === 'active' && !$g('poster_media_id')) throw ApiError::validation(['posterMediaId' => 'required_for_video (mode lite)']);
        if (($pm = $g('poster_media_id')) && !in_array(Db::val('SELECT kind FROM media WHERE id=?', [$pm]), ['image', 'logo'], true)) throw ApiError::validation(['posterMediaId' => 'must_be_image']);
        $lt = $g('link_type'); $lr = $g('link_ref');
        if ($lt && $lt !== 'none' && ($lr === null || $lr === '')) throw ApiError::validation(['linkRef' => 'required']);
        if ($lt === 'tenant' && !Db::val('SELECT id FROM tenants WHERE id=?', [$lr])) throw ApiError::validation(['linkRef' => 'tenant_not_found']);
        if ($lt === 'category' && !Db::val('SELECT id FROM categories WHERE id=?', [$lr])) throw ApiError::validation(['linkRef' => 'category_not_found']);
        if ($lt === 'url' && !preg_match('#^https://\S+$#', (string)$lr)) throw ApiError::validation(['linkRef' => 'https_url']);
        if (($a = $g('advertiser_tenant_id')) && !Db::val('SELECT id FROM tenants WHERE id=?', [$a])) throw ApiError::validation(['advertiserTenantId' => 'not_found']);
    }

    private static function reorder(string $table, string $scope, string $perm): void
    {
        $ids = Http::body()['ids'] ?? null;
        if (!is_array($ids)) throw ApiError::validation(['ids' => 'array']);
        Db::tx(function () use ($ids, $table, $scope) {
            foreach (array_values($ids) as $i => $id) Db::exec("UPDATE `$table` SET sort_order=? WHERE id=?", [$i + 1, (string)$id]);
            Revisions::bump($scope);
            Audit::log('reorder', rtrim($table, 's'), null, 'urutan diubah', null, ['ids' => $ids]);
        });
        Http::ok(['ids' => array_values($ids)]);
    }

    public static function resetPassword(array $p): void
    {
        $u = Db::one('SELECT * FROM users WHERE id=?', [(int)$p['id']]);
        if (!$u) throw ApiError::notFound('User');
        $alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        $pw = ''; for ($i = 0; $i < 14; $i++) $pw .= $alpha[random_int(0, strlen($alpha) - 1)];
        $pw = substr($pw, 0, 6) . '-' . substr($pw, 6);
        Db::update('users', ['password_hash' => Auth::hash($pw), 'must_change_password' => 1, 'failed_count' => 0, 'locked_until' => null, 'password_changed_at' => Util::now()], ['id' => $u['id']]);
        Audit::log('password_reset', 'user', (string)$u['id'], 'password direset admin');
        Http::ok(['tempPassword' => $pw, 'mustChangePassword' => true]);
    }

    // ---------------------------------------------------------------- i18n
    public static function i18nList(): void
    {
        $rows = Db::all('SELECT * FROM i18n_strings ORDER BY `key`');
        Http::json(['data' => array_map(fn($r) => ['key' => $r['key'], 'en' => $r['en'], 'id' => $r['id'], 'note' => $r['note'], 'updatedAt' => Util::iso($r['updated_at']), 'etag' => (string)$r['updated_at']], $rows), 'total' => count($rows)]);
    }
    public static function i18nPut(array $p): void
    {
        $key = $p['key'];
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/', $key)) throw ApiError::validation(['key' => 'format']);
        $b = Http::body();
        if (($b['en'] ?? '') === '' && ($b['id'] ?? '') === '' && ($b['en'] ?? null) !== '0') {
            if (Db::val('SELECT `key` FROM i18n_strings WHERE `key`=?', [$key])) { self::i18nDelete($p); return; }
            Http::ok(['key' => $key, 'en' => null, 'id' => null, 'note' => null, 'deleted' => true]); return;
        }
        $s = fn($v, $n) => ($v === null || $v === '') ? null : mb_substr((string)$v, 0, $n);
        Db::tx(function () use ($key, $b, $s) {
            $old = Db::one('SELECT * FROM i18n_strings WHERE `key`=?', [$key]);
            Db::exec('INSERT INTO i18n_strings (`key`, en, id, note, updated_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE en=VALUES(en), id=VALUES(id), note=VALUES(note), updated_by=VALUES(updated_by)',
                [$key, $s($b['en'] ?? null, 500), $s($b['id'] ?? null, 500), $s($b['note'] ?? null, 160), Auth::id()]);
            Revisions::bump('content');
            Audit::log($old ? 'update' : 'create', 'i18n', $key, 'i18n ' . $key, $old ? ['en' => $old['en'], 'id' => $old['id']] : null, ['en' => $b['en'] ?? null, 'id' => $b['id'] ?? null]);
        });
        $r = Db::one('SELECT * FROM i18n_strings WHERE `key`=?', [$key]);
        Http::ok(['key' => $key, 'en' => $r['en'], 'id' => $r['id'], 'note' => $r['note'], 'etag' => (string)$r['updated_at']]);
    }
    public static function i18nDelete(array $p): void
    {
        Db::tx(function () use ($p) {
            $old = Db::one('SELECT * FROM i18n_strings WHERE `key`=?', [$p['key']]);
            if (!$old) throw ApiError::notFound('Key');
            Db::exec('DELETE FROM i18n_strings WHERE `key`=?', [$p['key']]);
            Revisions::bump('content');
            Audit::log('delete', 'i18n', $p['key'], 'override i18n dihapus', ['en' => $old['en'], 'id' => $old['id']], null);
        });
        Http::ok(['deleted' => $p['key']]);
    }

    // ---------------------------------------------------------------- featured
    public static function featuredGet(): void
    {
        $rows = Db::all("SELECT f.*, COALESCE(t.name_override, b.name) name, t.is_published, t.status, COALESCE(mo.path, mb.path) logo
            FROM featured_tenants f JOIN tenants t ON t.id=f.tenant_id JOIN brands b ON b.id=t.brand_id
            LEFT JOIN media mo ON mo.id=t.logo_override_media_id LEFT JOIN media mb ON mb.id=b.logo_media_id ORDER BY f.sort_order, f.tenant_id");
        Http::json(['data' => array_map(fn($r) => ['tenantId' => $r['tenant_id'], 'sortOrder' => (int)$r['sort_order'], 'startsAt' => Util::iso($r['starts_at']),
            'endsAt' => Util::iso($r['ends_at']), 'name' => $r['name'], 'logo' => $r['logo'], 'valid' => (bool)$r['logo'] && (int)$r['is_published'] && $r['status'] !== 'closed'], $rows),
            'total' => count($rows), 'etag' => substr(sha1(json_encode($rows)), 0, 16)]);
    }
    public static function featuredPut(): void
    {
        $b = Http::body();
        $items = $b['items'] ?? (($b && array_keys($b) === range(0, count($b) - 1)) ? $b : null);
        if (!is_array($items)) throw ApiError::validation(['items' => 'array']);
        $err = []; $rows = [];
        foreach ($items as $i => $it) {
            $tid = is_array($it) ? (string)($it['tenantId'] ?? '') : (string)$it;
            $t = Db::one("SELECT t.id, t.is_published, t.status, COALESCE(t.logo_override_media_id, b.logo_media_id) logo FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE t.id=?", [$tid]);
            if (!$t) { $err["items.$i"] = 'tenant_not_found'; continue; }
            if (!(int)$t['is_published'] || $t['status'] === 'closed') { $err["items.$i"] = 'tenant_not_published'; continue; }
            if (!$t['logo']) { $err["items.$i"] = 'tenant_without_logo'; continue; }
            $rows[$tid] = ['tenant_id' => $tid, 'sort_order' => $i + 1,
                'starts_at' => is_array($it) ? Util::toDb($it['startsAt'] ?? null, "items.$i.startsAt") : null,
                'ends_at' => is_array($it) ? Util::toDb($it['endsAt'] ?? null, "items.$i.endsAt") : null];
        }
        if ($err) throw ApiError::validation($err);
        Db::tx(function () use ($rows) {
            $before = Db::col('SELECT tenant_id FROM featured_tenants ORDER BY sort_order');
            Db::exec('DELETE FROM featured_tenants');
            foreach ($rows as $r) Db::insert('featured_tenants', $r);
            Revisions::bump('promos');
            Audit::log('update', 'featured', null, 'daftar featured diubah (' . count($rows) . ')', ['ids' => $before], ['ids' => array_keys($rows)]);
        });
        self::featuredGet();
    }

    // ---------------------------------------------------------------- settings
    public static function settingsGet(): void
    {
        Settings::flush();
        $all = Settings::all();
        ksort($all);
        Http::ok((object)$all);
    }
    public static function settingsPut(array $p): void
    {
        $key = $p['key'];
        if (!preg_match('/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/', $key)) throw ApiError::validation(['key' => 'format']);
        $b = Http::body();
        if (!array_key_exists('value', $b)) throw ApiError::validation(['value' => 'required']);
        $v = $b['value'];
        if ($key === 'mall.hours') {
            if (!is_array($v)) throw ApiError::validation(['value' => '{"1":[["10:00","22:00"]],…}']);
            foreach ($v as $d => $ivs) foreach ((array)$ivs as $iv) if (!is_array($iv) || count($iv) !== 2 || !preg_match('/^\d\d:\d\d$/', (string)$iv[0]) || !preg_match('/^\d\d:\d\d$/', (string)$iv[1])) throw ApiError::validation(['value' => 'interval HH:MM']);
        }
        if (str_starts_with($key, 'cost.') && (!is_numeric($v) || $v < 0)) throw ApiError::validation(['value' => 'number>=0']);
        if ($key === 'map.northDeg' && $v !== null && (!is_numeric($v) || $v < 0 || $v >= 360)) throw ApiError::validation(['value' => '0..359.9|null']);
        if ($key === 'public.baseUrl' && !preg_match('#^https?://\S+$#', (string)$v)) throw ApiError::validation(['value' => 'url']);
        Db::tx(function () use ($key, $v) {
            $old = Settings::get($key);
            Settings::set($key, $v, Auth::id());
            if ($s = Settings::scopeOf($key)) Revisions::bump($s);
            Audit::log('update', 'setting', $key, 'setting ' . $key, ['value' => $old], ['value' => $v]);
        });
        Http::ok(['key' => $key, 'value' => $v]);
    }
}
