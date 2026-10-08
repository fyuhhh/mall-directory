<?php
declare(strict_types=1);

/** Bank eskalator/lift/tangga/jembatan → stop → leg (§2.6, §4.5 Konektor). */
final class ConnectorsApi
{
    public static function register(Router $r): void
    {
        $w = ['admin' => true, 'perm' => 'connectors.edit'];
        $r->get('/admin/connectors', [self::class, 'list'], ['admin' => true]);
        $r->get('/admin/connectors/{bankId}', fn($p) => Http::ok(self::bankDto($p['bankId'])), ['admin' => true]);
        $r->post('/admin/connectors', [self::class, 'createBank'], $w);
        $r->put('/admin/connectors/{bankId}', [self::class, 'updateBank'], $w);
        $r->delete('/admin/connectors/{bankId}', [self::class, 'deleteBank'], $w);
        $r->post('/admin/connectors/{bankId}/stops', [self::class, 'addStop'], $w);
        $r->put('/admin/connector-stops/{id}', [self::class, 'updateStop'], $w);
        $r->delete('/admin/connector-stops/{id}', [self::class, 'deleteStop'], $w);
        $r->post('/admin/connectors/{bankId}/legs', [self::class, 'addLeg'], $w);
        $r->put('/admin/connector-legs/{id}', [self::class, 'updateLeg'], $w);
        $r->delete('/admin/connector-legs/{id}', [self::class, 'deleteLeg'], $w);
        $r->post('/admin/connectors/{bankId}/regenerate-lift-legs', [self::class, 'regenLift'], $w);
    }

    private const BANK_FIELDS = [
        'type' => ['type', 'enum', ['values' => ['escalator', 'lift', 'stairs', 'bridge', 'travelator'], 'required' => true]],
        'building' => ['building', 'enum', ['values' => ['pentacity', 'ewalk', 'both'], 'required' => true]],
        'code' => ['code', 'str', ['nullable' => true, 'max' => 8]],
        'nameEn' => ['name_en', 'str', ['required' => true, 'max' => 80]], 'nameId' => ['name_id', 'str', ['required' => true, 'max' => 80]],
        'landmarkEn' => ['landmark_en', 'str', ['nullable' => true, 'max' => 120]], 'landmarkId' => ['landmark_id', 'str', ['nullable' => true, 'max' => 120]],
        'isEnabled' => ['is_enabled', 'bool', ['default' => 1]], 'scheduleId' => ['schedule_id', 'int', ['nullable' => true]],
        'notes' => ['notes', 'text', ['nullable' => true]], 'sortOrder' => ['sort_order', 'int', ['default' => 0]],
    ];

    private static function bankDef(): array
    {
        return ['table' => 'connector_banks', 'pk' => 'id', 'pkType' => 'str', 'fields' => ['id' => ['id', 'slug', ['required' => true]]] + self::BANK_FIELDS];
    }

    public static function bankDto(string $id, ?array $legsAll = null, ?array $closuresAll = null): array
    {
        $b = Db::one('SELECT * FROM connector_banks WHERE id=?', [$id]);
        if (!$b) throw ApiError::notFound('Bank');
        $legsAll = $legsAll ?? Snapshot::legsFull();
        $closuresAll = $closuresAll ?? self::activeClosures();
        $stops = Db::all('SELECT s.*, f.level, f.short, f.building floor_building, n.x, n.y FROM connector_stops s JOIN floors f ON f.id=s.floor_id JOIN graph_nodes n ON n.id=s.node_id WHERE s.bank_id=? ORDER BY f.level DESC, f.sort_order, s.public_id', [$id]);
        $legs = [];
        foreach ($legsAll as $l) {
            if ($l['bank_id'] !== $id) continue;
            $cost = Snapshot::legCost($l['bank_type'], $l['cost_override'], (int)$l['lower_level'], (int)$l['upper_level']);
            $cl = array_values(array_merge($closuresAll['leg'][(int)$l['id']] ?? [], $closuresAll['bank'][$id] ?? []));
            $legs[] = ['id' => (int)$l['id'], 'key' => 'L' . $l['id'], 'lowerStopId' => (int)$l['lower_stop_id'], 'upperStopId' => (int)$l['upper_stop_id'],
                'lowerFloor' => $l['lower_floor'], 'upperFloor' => $l['upper_floor'], 'lowerLevel' => (int)$l['lower_level'], 'upperLevel' => (int)$l['upper_level'],
                'direction' => $l['direction'], 'isEnabled' => (bool)(int)$l['is_enabled'], 'exported' => Snapshot::legExported($l),
                'scheduleId' => $l['schedule_id'] === null ? null : (int)$l['schedule_id'], 'costOverride' => $l['cost_override'] === null ? null : (float)$l['cost_override'],
                'cost' => $cost, 'srcKey' => $l['src_key'], 'label' => Snapshot::legLabel($l), 'verifiedAt' => Util::iso($l['verified_at']),
                'verifiedBy' => $l['verified_by'] === null ? null : (int)$l['verified_by'], 'fieldNote' => $l['field_note'], 'activeClosures' => $cl,
                'etag' => (string)$l['updated_at']];
        }
        return ['id' => $b['id'], 'type' => $b['type'], 'building' => $b['building'], 'code' => $b['code'], 'nameEn' => $b['name_en'], 'nameId' => $b['name_id'],
            'landmarkEn' => $b['landmark_en'], 'landmarkId' => $b['landmark_id'], 'isEnabled' => (bool)(int)$b['is_enabled'],
            'scheduleId' => $b['schedule_id'] === null ? null : (int)$b['schedule_id'], 'notes' => $b['notes'], 'sortOrder' => (int)$b['sort_order'],
            'stops' => array_map(fn($s) => ['id' => (int)$s['id'], 'publicId' => $s['public_id'], 'floorId' => $s['floor_id'], 'level' => (int)$s['level'], 'short' => $s['short'],
                'nodeId' => (int)$s['node_id'], 'x' => (float)$s['x'], 'y' => (float)$s['y'], 'isServed' => (bool)(int)$s['is_served'], 'labelEn' => $s['label_en'], 'labelId' => $s['label_id'], 'notes' => $s['notes']], $stops),
            'legs' => $legs, 'etag' => (string)$b['updated_at']];
    }

    public static function activeClosures(): array
    {
        $o = ['leg' => [], 'bank' => []];
        foreach (Db::all('SELECT * FROM closures WHERE (leg_id IS NOT NULL OR bank_id IS NOT NULL) AND (ends_at IS NULL OR ends_at > NOW()) ORDER BY starts_at') as $c) {
            $d = ['id' => (int)$c['id'], 'direction' => $c['direction'], 'startsAt' => Util::iso($c['starts_at']), 'endsAt' => Util::iso($c['ends_at']),
                'reasonEn' => $c['reason_en'], 'reasonId' => $c['reason_id'], 'scope' => $c['leg_id'] !== null ? 'leg' : 'bank'];
            if ($c['leg_id'] !== null) $o['leg'][(int)$c['leg_id']][] = $d; else $o['bank'][$c['bank_id']][] = $d;
        }
        return $o;
    }

    public static function list(): void
    {
        $legs = Snapshot::legsFull(); $cl = self::activeClosures();
        $w = ''; $p = [];
        if (($b = Http::q('building')) !== null && $b !== '') { $w = ' WHERE building=? OR building=\'both\''; $p[] = $b; }
        $ids = Db::col('SELECT id FROM connector_banks' . $w . ' ORDER BY building, sort_order, id', $p);
        $data = array_map(fn($id) => self::bankDto($id, $legs, $cl), $ids);
        Http::json(['data' => $data, 'total' => count($data), 'revision' => Revisions::get('map')]);
    }

    private static function touch(string $bankId): void { Db::exec('UPDATE connector_banks SET updated_at=NOW(), updated_by=? WHERE id=?', [Auth::id(), $bankId]); }

    public static function createBank(): void
    {
        $in = Http::body();
        $row = Crud::input(self::bankDef(), $in, true);
        Db::tx(function () use ($row) {
            if (Db::val('SELECT id FROM connector_banks WHERE id=?', [$row['id']])) throw ApiError::conflict('ID bank sudah dipakai');
            if (!empty($row['schedule_id']) && !Db::val('SELECT id FROM schedules WHERE id=?', [$row['schedule_id']])) throw ApiError::validation(['scheduleId' => 'not_found']);
            $row['updated_by'] = Auth::id();
            Db::insert('connector_banks', $row);
            Revisions::bump('map');
            Audit::log('create', 'connector_bank', $row['id'], 'bank dibuat', null, $row);
        });
        Http::ok(self::bankDto($row['id']), 201);
    }

    public static function updateBank(array $p): void
    {
        $id = $p['bankId'];
        $in = Http::body();
        Db::tx(function () use ($id, $in) {
            $old = Db::one('SELECT * FROM connector_banks WHERE id=? FOR UPDATE', [$id]);
            if (!$old) throw ApiError::notFound('Bank');
            Crud::checkEtag((string)$old['updated_at'], null);
            $row = Crud::input(self::bankDef(), $in, false);
            if (isset($row['type']) && $row['type'] !== $old['type'] && Db::val('SELECT COUNT(*) FROM connector_legs WHERE bank_id=?', [$id])) throw ApiError::validation(['type' => 'cannot_change_with_legs']);
            if (!empty($row['schedule_id']) && !Db::val('SELECT id FROM schedules WHERE id=?', [$row['schedule_id']])) throw ApiError::validation(['scheduleId' => 'not_found']);
            $row['updated_by'] = Auth::id();
            Db::update('connector_banks', $row, ['id' => $id]);
            $new = Db::one('SELECT * FROM connector_banks WHERE id=?', [$id]);
            [$b, $a] = Audit::changed($old, $new);
            Revisions::bump('map');
            Audit::log('update', 'connector_bank', $id, 'bank diubah', $b, $a);
        });
        Http::ok(self::bankDto($id));
    }

    public static function deleteBank(array $p): void
    {
        $id = $p['bankId'];
        Db::tx(function () use ($id) {
            $old = Db::one('SELECT * FROM connector_banks WHERE id=?', [$id]);
            if (!$old) throw ApiError::notFound('Bank');
            Db::exec('DELETE FROM connector_banks WHERE id=?', [$id]);   // cascade stop & leg
            Revisions::bump('map');
            Audit::log('delete', 'connector_bank', $id, 'bank dihapus (beserta stop & leg)', $old, null);
        });
        Http::ok(['deleted' => $id]);
    }

    public static function addStop(array $p): void
    {
        $bankId = $p['bankId'];
        $in = Http::body();
        $sid = Db::tx(function () use ($bankId, $in) {
            $bank = Db::one('SELECT * FROM connector_banks WHERE id=?', [$bankId]);
            if (!$bank) throw ApiError::notFound('Bank');
            $fid = (string)($in['floorId'] ?? '');
            $f = Db::one('SELECT * FROM floors WHERE id=?', [$fid]);
            if (!$f) throw ApiError::validation(['floorId' => 'not_found']);
            if (isset($in['nodeId']) && $in['nodeId'] !== null) {
                $nid = (int)$in['nodeId'];
                $nf = Db::val('SELECT floor_id FROM graph_nodes WHERE id=?', [$nid]);
                if ($nf !== $fid) throw ApiError::validation(['nodeId' => $nf ? 'node_on_other_floor:' . $nf : 'not_found']);
                if (Db::val('SELECT id FROM amenities WHERE node_id=?', [$nid])) throw ApiError::validation(['nodeId' => 'W_POI_NODE: node dipakai POI']);
            } elseif (isset($in['x'], $in['y']) && is_numeric($in['x']) && is_numeric($in['y'])) {
                $x = (float)$in['x']; $y = (float)$in['y'];
                if ($x < $f['vb_x'] || $y < $f['vb_y'] || $x > $f['vb_x'] + $f['vb_w'] || $y > $f['vb_y'] + $f['vb_h']) throw ApiError::validation(['x' => 'outside_viewbox']);
                $nid = GraphApi::snapToCorridor($fid, $x, $y, null);
            } else throw ApiError::validation(['nodeId' => 'nodeId atau x,y wajib']);
            $pub = isset($in['publicId']) && $in['publicId'] !== '' ? (string)$in['publicId'] : null;
            if ($pub !== null && !preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $pub)) throw ApiError::validation(['publicId' => 'slug']);
            if ($pub === null) { $base = $bankId . '-' . $fid; $pub = $base; $i = 2; while (Db::val('SELECT id FROM connector_stops WHERE public_id=?', [$pub])) $pub = $base . '-' . $i++; }
            elseif (Db::val('SELECT id FROM connector_stops WHERE public_id=?', [$pub])) throw ApiError::conflict('publicId sudah dipakai');
            if (Db::val('SELECT id FROM connector_stops WHERE bank_id=? AND node_id=?', [$bankId, $nid])) throw ApiError::conflict('Node sudah menjadi stop bank ini');
            $sid = Db::insert('connector_stops', ['bank_id' => $bankId, 'floor_id' => $fid, 'node_id' => $nid, 'public_id' => $pub,
                'is_served' => isset($in['isServed']) ? (Util::bool($in['isServed']) ? 1 : 0) : 1,
                'label_en' => $in['labelEn'] ?? null, 'label_id' => $in['labelId'] ?? null, 'notes' => isset($in['notes']) ? mb_substr((string)$in['notes'], 0, 255) : null]);
            self::touch($bankId);
            Revisions::bump('map');
            Audit::log('create', 'connector_stop', (string)$sid, "stop $pub (bank $bankId, n$nid)");
            return $sid;
        });
        Http::ok(self::bankDto($bankId) + ['createdStopId' => $sid], 201);
    }

    public static function updateStop(array $p): void
    {
        $id = (int)$p['id']; $in = Http::body();
        $bankId = Db::tx(function () use ($id, $in) {
            $old = Db::one('SELECT * FROM connector_stops WHERE id=?', [$id]);
            if (!$old) throw ApiError::notFound('Stop');
            $row = [];
            if (array_key_exists('isServed', $in)) $row['is_served'] = Util::bool($in['isServed']) ? 1 : 0;
            foreach (['labelEn' => 'label_en', 'labelId' => 'label_id'] as $k => $c) if (array_key_exists($k, $in)) $row[$c] = $in[$k] === '' || $in[$k] === null ? null : mb_substr((string)$in[$k], 0, 80);
            if (array_key_exists('notes', $in)) $row['notes'] = $in['notes'] === '' || $in['notes'] === null ? null : mb_substr((string)$in['notes'], 0, 255);
            if (array_key_exists('nodeId', $in)) {
                $nf = Db::val('SELECT floor_id FROM graph_nodes WHERE id=?', [(int)$in['nodeId']]);
                if ($nf !== $old['floor_id']) throw ApiError::validation(['nodeId' => 'node_on_other_floor']);
                $row['node_id'] = (int)$in['nodeId'];
            }
            if ($row) Db::update('connector_stops', $row, ['id' => $id]);
            self::touch($old['bank_id']);
            Revisions::bump('map');
            Audit::log('update', 'connector_stop', (string)$id, 'stop ' . $old['public_id'] . ' diubah', null, $row);
            return $old['bank_id'];
        });
        Http::ok(self::bankDto($bankId));
    }

    public static function deleteStop(array $p): void
    {
        $id = (int)$p['id'];
        $bankId = Db::tx(function () use ($id) {
            $old = Db::one('SELECT * FROM connector_stops WHERE id=?', [$id]);
            if (!$old) throw ApiError::notFound('Stop');
            $legs = Db::col('SELECT id FROM connector_legs WHERE lower_stop_id=? OR upper_stop_id=?', [$id, $id]);
            Db::exec('DELETE FROM connector_stops WHERE id=?', [$id]);
            self::touch($old['bank_id']);
            Revisions::bump('map');
            Audit::log('delete', 'connector_stop', (string)$id, 'stop ' . $old['public_id'] . ' dihapus' . ($legs ? ' (+leg ' . implode(',', $legs) . ')' : ''), $old, null);
            return $old['bank_id'];
        });
        Http::ok(self::bankDto($bankId));
    }

    private static function legRow(array $in, bool $create): array
    {
        $row = []; $err = [];
        if (array_key_exists('direction', $in)) { if (!in_array($in['direction'], ['both', 'up', 'down'], true)) $err['direction'] = 'one_of:both|up|down'; else $row['direction'] = $in['direction']; }
        if (array_key_exists('isEnabled', $in)) $row['is_enabled'] = Util::bool($in['isEnabled']) ? 1 : 0;
        if (array_key_exists('scheduleId', $in)) {
            if ($in['scheduleId'] !== null && !Db::val('SELECT id FROM schedules WHERE id=?', [(int)$in['scheduleId']])) $err['scheduleId'] = 'not_found';
            $row['schedule_id'] = $in['scheduleId'] === null ? null : (int)$in['scheduleId'];
        }
        if (array_key_exists('costOverride', $in)) {
            if ($in['costOverride'] !== null && (!is_numeric($in['costOverride']) || $in['costOverride'] < 0)) $err['costOverride'] = 'number>=0';
            $row['cost_override'] = $in['costOverride'] === null ? null : round((float)$in['costOverride'], 2);
        }
        if (array_key_exists('fieldNote', $in)) $row['field_note'] = $in['fieldNote'] === null || $in['fieldNote'] === '' ? null : mb_substr((string)$in['fieldNote'], 0, 255);
        if (array_key_exists('srcKey', $in)) $row['src_key'] = $in['srcKey'] === null || $in['srcKey'] === '' ? null : mb_substr((string)$in['srcKey'], 0, 48);
        if (array_key_exists('verified', $in)) {
            if (Util::bool($in['verified'])) { $row['verified_at'] = Util::now(); $row['verified_by'] = Auth::id(); }
            else { $row['verified_at'] = null; $row['verified_by'] = null; }
        }
        if ($err) throw ApiError::validation($err);
        return $row;
    }

    private static function checkLeg(string $bankId, int $lowerId, int $upperId, string $direction): array
    {
        $bank = Db::one('SELECT * FROM connector_banks WHERE id=?', [$bankId]);
        $lo = Db::one('SELECT s.*, f.level FROM connector_stops s JOIN floors f ON f.id=s.floor_id WHERE s.id=?', [$lowerId]);
        $up = Db::one('SELECT s.*, f.level FROM connector_stops s JOIN floors f ON f.id=s.floor_id WHERE s.id=?', [$upperId]);
        if (!$lo || !$up) throw ApiError::validation(['lowerStopId' => 'not_found']);
        if ($lo['bank_id'] !== $bankId || $up['bank_id'] !== $bankId) throw ApiError::validation(['lowerStopId' => 'E_LEG_LEVEL: stop bukan milik bank ini']);
        if ($lowerId === $upperId) throw ApiError::validation(['upperStopId' => 'same_stop']);
        if ($bank['type'] === 'bridge') {
            if ((int)$lo['level'] !== (int)$up['level'] || $lo['floor_id'] === $up['floor_id']) throw ApiError::validation(['upperStopId' => 'E_LEG_LEVEL: jembatan = level sama, sheet berbeda']);
            if ($direction !== 'both') throw ApiError::validation(['direction' => 'bridge_must_be_both']);
        } elseif ((int)$lo['level'] >= (int)$up['level']) throw ApiError::validation(['upperStopId' => 'E_LEG_LEVEL: level bawah harus < level atas']);
        if ($bank['type'] === 'lift' && $direction !== 'both') throw ApiError::validation(['direction' => 'lift_must_be_both']);
        return $bank;
    }

    public static function addLeg(array $p): void
    {
        $bankId = $p['bankId']; $in = Http::body();
        Db::tx(function () use ($bankId, $in) {
            if (!Db::val('SELECT id FROM connector_banks WHERE id=?', [$bankId])) throw ApiError::notFound('Bank');
            $lo = (int)($in['lowerStopId'] ?? 0); $up = (int)($in['upperStopId'] ?? 0);
            $dir = (string)($in['direction'] ?? 'both');
            self::checkLeg($bankId, $lo, $up, $dir);
            if (Db::val('SELECT id FROM connector_legs WHERE lower_stop_id=? AND upper_stop_id=? AND direction=?', [$lo, $up, $dir])) throw ApiError::conflict('Leg yang sama sudah ada');
            $row = self::legRow($in, true) + ['direction' => $dir];
            $row += ['bank_id' => $bankId, 'lower_stop_id' => $lo, 'upper_stop_id' => $up, 'updated_by' => Auth::id()];
            $id = Db::insert('connector_legs', $row);
            self::touch($bankId);
            Revisions::bump('map');
            Audit::log('create', 'connector_leg', (string)$id, "leg L$id bank $bankId ($dir)", null, $row);
        });
        Http::ok(self::bankDto($bankId), 201);
    }

    public static function updateLeg(array $p): void
    {
        $id = (int)$p['id']; $in = Http::body();
        $bankId = Db::tx(function () use ($id, $in) {
            $old = Db::one('SELECT * FROM connector_legs WHERE id=? FOR UPDATE', [$id]);
            if (!$old) throw ApiError::notFound('Leg');
            Crud::checkEtag((string)$old['updated_at'], null);
            $row = self::legRow($in, false);
            $dir = $row['direction'] ?? $old['direction'];
            $lo = isset($in['lowerStopId']) ? (int)$in['lowerStopId'] : (int)$old['lower_stop_id'];
            $up = isset($in['upperStopId']) ? (int)$in['upperStopId'] : (int)$old['upper_stop_id'];
            self::checkLeg($old['bank_id'], $lo, $up, $dir);
            $row['lower_stop_id'] = $lo; $row['upper_stop_id'] = $up; $row['updated_by'] = Auth::id();
            Db::update('connector_legs', $row, ['id' => $id]);
            $new = Db::one('SELECT * FROM connector_legs WHERE id=?', [$id]);
            [$b, $a] = Audit::changed($old, $new);
            self::touch($old['bank_id']);
            Revisions::bump('map');
            $lbl = Db::one('SELECT name_id FROM connector_banks WHERE id=?', [$old['bank_id']]);
            Audit::log('update', 'connector_leg', (string)$id, "leg L$id ({$lbl['name_id']}) diubah" . (isset($a['direction']) ? ": arah {$b['direction']}→{$a['direction']}" : '')
                . (isset($a['is_enabled']) ? ': ' . ($a['is_enabled'] ? 'aktif' : 'nonaktif') : ''), $b, $a);
            return $old['bank_id'];
        });
        Http::ok(self::bankDto($bankId));
    }

    public static function deleteLeg(array $p): void
    {
        $id = (int)$p['id'];
        $bankId = Db::tx(function () use ($id) {
            $old = Db::one('SELECT * FROM connector_legs WHERE id=?', [$id]);
            if (!$old) throw ApiError::notFound('Leg');
            Db::exec('DELETE FROM connector_legs WHERE id=?', [$id]);
            self::touch($old['bank_id']);
            Revisions::bump('map');
            Audit::log('delete', 'connector_leg', (string)$id, "leg L$id dihapus", $old, null);
            return $old['bank_id'];
        });
        Http::ok(self::bankDto($bankId));
    }

    /** Lift: leg antar stop is_served=1 berurutan per level; leg lama yang tidak cocok dihapus. */
    public static function regenLift(array $p): void
    {
        $bankId = $p['bankId'];
        $res = Db::tx(function () use ($bankId) {
            $bank = Db::one('SELECT * FROM connector_banks WHERE id=?', [$bankId]);
            if (!$bank) throw ApiError::notFound('Bank');
            if ($bank['type'] !== 'lift') throw ApiError::validation(['bankId' => 'not_a_lift']);
            $stops = Db::all('SELECT s.id, f.level FROM connector_stops s JOIN floors f ON f.id=s.floor_id WHERE s.bank_id=? AND s.is_served=1 ORDER BY f.level, f.sort_order, s.id', [$bankId]);
            $byLevel = [];
            foreach ($stops as $s) if (!isset($byLevel[(int)$s['level']])) $byLevel[(int)$s['level']] = (int)$s['id'];
            ksort($byLevel);
            $want = []; $prev = null;
            foreach ($byLevel as $lvl => $sid) { if ($prev !== null) $want[$prev . '-' . $sid] = [$prev, $sid]; $prev = $sid; }
            $existing = Db::all('SELECT * FROM connector_legs WHERE bank_id=?', [$bankId]);
            $kept = 0; $removed = 0; $added = 0;
            foreach ($existing as $l) {
                $k = $l['lower_stop_id'] . '-' . $l['upper_stop_id'];
                if (isset($want[$k])) { unset($want[$k]); $kept++; if ($l['direction'] !== 'both') Db::exec("UPDATE connector_legs SET direction='both' WHERE id=?", [$l['id']]); }
                else { Db::exec('DELETE FROM connector_legs WHERE id=?', [$l['id']]); $removed++; }
            }
            foreach ($want as [$lo, $up]) { Db::insert('connector_legs', ['bank_id' => $bankId, 'lower_stop_id' => $lo, 'upper_stop_id' => $up, 'direction' => 'both', 'updated_by' => Auth::id()]); $added++; }
            self::touch($bankId);
            Revisions::bump('map');
            Audit::log('regenerate', 'connector_bank', $bankId, "regenerate lift legs: +$added −$removed =$kept");
            return ['added' => $added, 'removed' => $removed, 'kept' => $kept];
        });
        Http::ok(self::bankDto($bankId) + ['regenerated' => $res]);
    }
}
