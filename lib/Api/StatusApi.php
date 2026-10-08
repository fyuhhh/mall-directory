<?php
declare(strict_types=1);

/** Status live: closures (leg/bank/edge/amenity) + notice → status.json langsung (§2.7, §5.6). */
final class StatusApi
{
    public static function register(Router $r): void
    {
        $c = ['admin' => true, 'perm' => 'status.closures'];
        $n = ['admin' => true, 'perm' => 'status.notice'];
        $r->get('/admin/closures', [self::class, 'list'], ['admin' => true]);
        $r->post('/admin/closures', [self::class, 'create'], $c);
        $r->post('/admin/closures/{id}/end', [self::class, 'end'], $c);
        $r->post('/admin/closures/impact', [self::class, 'impactPreview'], ['admin' => true]);
        $r->get('/admin/notices', [self::class, 'notices'], ['admin' => true]);
        $r->post('/admin/notices', [self::class, 'noticeCreate'], $n);
        $r->post('/admin/notices/{id}/end', [self::class, 'noticeEnd'], $n);
        $r->get('/admin/status', fn() => Http::ok(['live' => Publisher::liveJson('status'), 'release' => self::rel(Publisher::live('status'))]), ['admin' => true]);
    }

    private static function rel(?array $r): ?array { return $r ? ['id' => (int)$r['id'], 'version' => $r['version'], 'publishedAt' => Util::iso($r['created_at'])] : null; }

    public static function dto(array $c): array
    {
        $now = Util::now();
        $target = $c['leg_id'] !== null ? ['type' => 'leg', 'id' => (string)$c['leg_id']] : ($c['bank_id'] !== null ? ['type' => 'bank', 'id' => $c['bank_id']]
            : ($c['edge_id'] !== null ? ['type' => 'edge', 'id' => (string)$c['edge_id']] : ['type' => 'amenity', 'id' => $c['amenity_id']]));
        $label = null;
        if ($c['leg_id'] !== null) { foreach (Snapshot::legsFull() as $l) if ((int)$l['id'] === (int)$c['leg_id']) $label = Snapshot::legLabel($l); }
        elseif ($c['bank_id'] !== null) { $b = Db::one('SELECT name_en, name_id FROM connector_banks WHERE id=?', [$c['bank_id']]); $label = $b ? ['en' => $b['name_en'], 'id' => $b['name_id']] : null; }
        elseif ($c['edge_id'] !== null) { $e = Db::one('SELECT label, node_a, node_b FROM graph_edges WHERE id=?', [$c['edge_id']]); $label = $e ? ['en' => $e['label'] ?: "Corridor n{$e['node_a']}–n{$e['node_b']}", 'id' => $e['label'] ?: "Koridor n{$e['node_a']}–n{$e['node_b']}"] : null; }
        else { $a = Db::one('SELECT COALESCE(a.name_en,t.name_en) en, COALESCE(a.name_id,t.name_id) id FROM amenities a JOIN amenity_types t ON t.id=a.type_id WHERE a.id=?', [$c['amenity_id']]); $label = $a ? ['en' => $a['en'], 'id' => $a['id']] : null; }
        $target['label'] = $label;
        $target['bankId'] = $c['bank_id'] ?? ($c['leg_id'] !== null ? Db::val('SELECT bank_id FROM connector_legs WHERE id=?', [$c['leg_id']]) : null);
        $state = $c['ends_at'] !== null && $c['ends_at'] <= $now ? 'ended' : ($c['starts_at'] > $now ? 'scheduled' : 'active');
        return ['id' => (int)$c['id'], 'target' => $target, 'label' => $label, 'direction' => $c['direction'], 'startsAt' => Util::iso($c['starts_at']),
            'endsAt' => Util::iso($c['ends_at']), 'reasonEn' => $c['reason_en'], 'reasonId' => $c['reason_id'], 'state' => $state,
            'createdBy' => $c['created_by'] === null ? null : (int)$c['created_by'], 'createdByName' => $c['created_by_name'] ?? null, 'createdAt' => Util::iso($c['created_at']),
            'endedAt' => Util::iso($c['ended_at']), 'endedBy' => $c['ended_by'] === null ? null : (int)$c['ended_by']];
    }

    public static function list(): void
    {
        $w = '';
        if (Util::bool(Http::q('active', '0'))) $w = ' WHERE c.ends_at IS NULL OR c.ends_at > NOW()';
        [$page, $per, $lim] = Crud::page();
        $total = (int)Db::val('SELECT COUNT(*) FROM closures c' . $w);
        $rows = Db::all('SELECT c.*, u.name created_by_name FROM closures c LEFT JOIN users u ON u.id=c.created_by' . $w . ' ORDER BY c.starts_at DESC, c.id DESC' . $lim);
        Http::json(['data' => array_map([self::class, 'dto'], $rows), 'total' => $total, 'page' => $page, 'per' => $per,
            'statusVersion' => Publisher::live('status')['version'] ?? null]);
    }

    private static function parse(array $b): array
    {
        $t = $b['target'] ?? null;
        if (!is_array($t) || !in_array($t['type'] ?? null, ['leg', 'bank', 'edge', 'amenity'], true) || !isset($t['id']) || $t['id'] === '')
            throw ApiError::validation(['target' => '{type:leg|bank|edge|amenity,id}']);
        $row = ['leg_id' => null, 'bank_id' => null, 'edge_id' => null, 'amenity_id' => null];
        switch ($t['type']) {
            case 'leg': if (!Db::val('SELECT id FROM connector_legs WHERE id=?', [(int)$t['id']])) throw ApiError::validation(['target' => 'leg_not_found']); $row['leg_id'] = (int)$t['id']; break;
            case 'bank': if (!Db::val('SELECT id FROM connector_banks WHERE id=?', [(string)$t['id']])) throw ApiError::validation(['target' => 'bank_not_found']); $row['bank_id'] = (string)$t['id']; break;
            case 'edge': if (!Db::val('SELECT id FROM graph_edges WHERE id=?', [(int)$t['id']])) throw ApiError::validation(['target' => 'edge_not_found']); $row['edge_id'] = (int)$t['id']; break;
            case 'amenity': if (!Db::val('SELECT id FROM amenities WHERE id=?', [(string)$t['id']])) throw ApiError::validation(['target' => 'amenity_not_found']); $row['amenity_id'] = (string)$t['id']; break;
        }
        $dir = $b['direction'] ?? 'both';
        if (!in_array($dir, ['both', 'up', 'down'], true)) throw ApiError::validation(['direction' => 'one_of:both|up|down']);
        $row['direction'] = $dir;
        $row['starts_at'] = Util::toDb($b['startsAt'] ?? null, 'startsAt') ?? Util::now();
        $row['ends_at'] = Util::toDb($b['endsAt'] ?? null, 'endsAt');
        if ($row['ends_at'] !== null && $row['ends_at'] <= $row['starts_at']) throw ApiError::validation(['endsAt' => 'after_startsAt']);
        $row['reason_en'] = isset($b['reasonEn']) && $b['reasonEn'] !== '' ? mb_substr((string)$b['reasonEn'], 0, 160) : null;
        $row['reason_id'] = isset($b['reasonId']) && $b['reasonId'] !== '' ? mb_substr((string)$b['reasonId'], 0, 160) : null;
        return $row;
    }

    /** Dampak: tenant yang menjadi tak terjangkau (kiosk mana pun) karena closure di status (live directory). */
    public static function impact(?array $status): array
    {
        $D = Publisher::liveJson('directory');
        if (!$D) return ['unreachableDefault' => [], 'unreachableAccessible' => []];
        $names = [];
        foreach ($D['tenants'] as $t) $names[$t['id']] = $t['name'];
        $out = [];
        foreach (['unreachableDefault' => false, 'unreachableAccessible' => true] as $k => $acc) {
            $base = RouteCheck::reachability($D, $acc)['unreach'];
            $after = RouteCheck::reachability($D, $acc, RouteCheck::openFilter($D, $status, time(), true, true))['unreach'];
            $list = [];
            foreach ($after as $tid => $ks) {
                $extra = array_values(array_diff($ks, $base[$tid] ?? []));
                if ($extra) $list[] = ['tenant' => $tid, 'name' => $names[$tid] ?? $tid, 'fromKiosks' => $extra, 'allKiosks' => count($ks) >= count($D['kiosks'])];
            }
            $out[$k] = $list;
        }
        return $out;
    }

    public static function create(): void
    {
        $row = self::parse(Http::body());
        $row['created_by'] = Auth::id();
        $id = Db::tx(function () use ($row) {
            $id = Db::insert('closures', $row);
            Audit::log('closure_start', 'closure', (string)$id, 'closure ' . json_encode(array_filter(['leg' => $row['leg_id'], 'bank' => $row['bank_id'], 'edge' => $row['edge_id'], 'amenity' => $row['amenity_id']])) . ' arah ' . $row['direction'], null, $row);
            return $id;
        });
        $rel = Publisher::publishStatus('closure #' . $id);
        $status = Publisher::liveJson('status');
        $c = Db::one('SELECT c.*, u.name created_by_name FROM closures c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?', [$id]);
        Http::ok(['closure' => self::dto($c), 'statusVersion' => $rel['version'], 'impact' => self::impact($status)], 201);
    }

    public static function impactPreview(): void
    {
        $row = self::parse(Http::body());
        // status hipotetis = status live + closure ini
        $st = Publisher::liveJson('status') ?? ['closures' => [], 'edgeOverrides' => []];
        $keys = [];
        if ($row['leg_id']) $keys[] = 'L' . $row['leg_id'];
        if ($row['bank_id']) foreach (Db::col('SELECT id FROM connector_legs WHERE bank_id=?', [$row['bank_id']]) as $l) $keys[] = 'L' . $l;
        foreach ($keys as $k) $st['closures'][] = ['key' => $k, 'dir' => $row['direction'], 'from' => Util::iso($row['starts_at']), 'to' => Util::iso($row['ends_at'])];
        if ($row['edge_id']) { $e = Db::one('SELECT node_a, node_b FROM graph_edges WHERE id=?', [$row['edge_id']]); $st['edgeOverrides'][] = ['n' . $e['node_a'], 'n' . $e['node_b']]; }
        Http::ok(['impact' => self::impact($st)]);
    }

    public static function end(array $p): void
    {
        $id = (int)$p['id'];
        Db::tx(function () use ($id) {
            $c = Db::one('SELECT * FROM closures WHERE id=? FOR UPDATE', [$id]);
            if (!$c) throw ApiError::notFound('Closure');
            if ($c['ends_at'] !== null && $c['ends_at'] <= Util::now()) throw ApiError::conflict('Closure sudah berakhir');
            $now = Util::now();
            Db::update('closures', ['ends_at' => $now, 'ended_at' => $now, 'ended_by' => Auth::id()], ['id' => $id]);
            Audit::log('closure_end', 'closure', (string)$id, 'closure diakhiri', ['ends_at' => $c['ends_at']], ['ends_at' => $now]);
        });
        $rel = Publisher::publishStatus('closure #' . $id . ' end');
        $c = Db::one('SELECT c.*, u.name created_by_name FROM closures c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?', [$id]);
        Http::ok(['closure' => self::dto($c), 'statusVersion' => $rel['version'], 'impact' => self::impact(Publisher::liveJson('status'))]);
    }

    // ---------------------------------------------------------------- notices
    private static function noticeDto(array $n): array
    {
        $now = Util::now();
        return ['id' => (int)$n['id'], 'level' => $n['level'], 'textEn' => $n['text_en'], 'textId' => $n['text_id'], 'startsAt' => Util::iso($n['starts_at']),
            'endsAt' => Util::iso($n['ends_at']), 'allKiosks' => (bool)(int)$n['all_kiosks'], 'kioskIds' => Util::jsonDecode($n['kiosk_ids'], []) ?: [],
            'state' => $n['ends_at'] !== null && $n['ends_at'] <= $now ? 'ended' : ($n['starts_at'] > $now ? 'scheduled' : 'active'),
            'createdBy' => $n['created_by'] === null ? null : (int)$n['created_by'], 'createdAt' => Util::iso($n['created_at'])];
    }
    public static function notices(): void
    {
        $w = Util::bool(Http::q('active', '0')) ? ' WHERE ends_at IS NULL OR ends_at > NOW()' : '';
        $rows = Db::all('SELECT * FROM notices' . $w . ' ORDER BY id DESC LIMIT 100');
        Http::json(['data' => array_map([self::class, 'noticeDto'], $rows), 'total' => count($rows)]);
    }
    public static function noticeCreate(): void
    {
        $b = Http::body();
        $err = [];
        if (!in_array($b['level'] ?? null, ['info', 'warning', 'emergency'], true)) $err['level'] = 'one_of:info|warning|emergency';
        foreach (['textEn', 'textId'] as $k) if (!isset($b[$k]) || trim((string)$b[$k]) === '') $err[$k] = 'required'; elseif (mb_strlen((string)$b[$k]) > 300) $err[$k] = 'max_len_300';
        $all = Util::bool($b['allKiosks'] ?? true);
        $ks = $b['kioskIds'] ?? [];
        if (!$all) { if (!is_array($ks) || !$ks) $err['kioskIds'] = 'required'; else foreach ($ks as $k) if (!Db::val('SELECT id FROM kiosks WHERE id=?', [(string)$k])) $err['kioskIds'] = 'not_found:' . $k; }
        if ($err) throw ApiError::validation($err);
        $start = Util::toDb($b['startsAt'] ?? null, 'startsAt') ?? Util::now();
        $end = Util::toDb($b['endsAt'] ?? null, 'endsAt');
        if ($end !== null && $end <= $start) throw ApiError::validation(['endsAt' => 'after_startsAt']);
        $id = Db::tx(function () use ($b, $all, $ks, $start, $end) {
            // satu pesan aktif: akhiri notice aktif lain
            $now = Util::now();
            $ended = Db::col('SELECT id FROM notices WHERE starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)', [$now, $now]);
            if ($ended) Db::exec('UPDATE notices SET ends_at=? WHERE id IN (' . implode(',', array_map('intval', $ended)) . ')', [$now]);
            $id = Db::insert('notices', ['level' => $b['level'], 'text_en' => trim((string)$b['textEn']), 'text_id' => trim((string)$b['textId']), 'starts_at' => $start, 'ends_at' => $end,
                'all_kiosks' => $all ? 1 : 0, 'kiosk_ids' => $all ? null : Util::jsonEncode(array_values($ks)), 'created_by' => Auth::id()]);
            Audit::log('notice_start', 'notice', (string)$id, $b['level'] . ': ' . mb_substr((string)$b['textId'], 0, 120), $ended ? ['ended' => $ended] : null, ['level' => $b['level']]);
            return $id;
        });
        $rel = Publisher::publishStatus('notice #' . $id);
        Http::ok(['notice' => self::noticeDto(Db::one('SELECT * FROM notices WHERE id=?', [$id])), 'statusVersion' => $rel['version']], 201);
    }
    public static function noticeEnd(array $p): void
    {
        $id = (int)$p['id'];
        Db::tx(function () use ($id) {
            $n = Db::one('SELECT * FROM notices WHERE id=?', [$id]);
            if (!$n) throw ApiError::notFound('Notice');
            Db::update('notices', ['ends_at' => Util::now()], ['id' => $id]);
            Audit::log('notice_end', 'notice', (string)$id, 'notice diakhiri');
        });
        $rel = Publisher::publishStatus('notice #' . $id . ' end');
        Http::ok(['notice' => self::noticeDto(Db::one('SELECT * FROM notices WHERE id=?', [$id])), 'statusVersion' => $rel['version']]);
    }
}
