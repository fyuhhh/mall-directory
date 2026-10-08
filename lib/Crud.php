<?php
declare(strict_types=1);

/**
 * CRUD generik berbasis definisi field (camelCase DTO ↔ snake_case kolom).
 * def: table, pk, pkAuto, pkType ('int'|'str'), entity (audit), scope (revisi), perm (izin tulis),
 *      fields: [camel => [col, type, opts]], search: [kolom LIKE], filters: [param => kolom], sort: [camel => kolom],
 *      hooks: dto(fn(row,dto):dto), before(fn(array &row, array in, ?array old)), after(fn(id, array in, ?array old)), canDelete(fn(id)), defaultSort
 * Tipe: str, text, int, float, bool, enum, color, url, datetime, date, time, json, slug
 */
final class Crud
{
    public static function etag(array $def, array $row): string
    {
        if (array_key_exists('updated_at', $row) && $row['updated_at'] !== null) return (string)$row['updated_at'];
        return substr(sha1(json_encode($row)), 0, 16);
    }

    public static function find(array $def, $id): ?array
    {
        return Db::one('SELECT * FROM `' . $def['table'] . '` WHERE `' . $def['pk'] . '`=?', [self::pkVal($def, $id)]);
    }
    public static function pkVal(array $def, $id) { return ($def['pkType'] ?? 'int') === 'int' ? (int)$id : (string)$id; }

    public static function dto(array $def, array $row): array
    {
        $o = [];
        foreach ($def['fields'] as $camel => $f) {
            if (!empty($f['writeOnly'])) continue;
            $v = $row[$f[0]] ?? null;
            $o[$camel] = self::out($f[1], $v);
        }
        if (isset($def['hooks']['dto'])) $o = ($def['hooks']['dto'])($row, $o);
        $o['etag'] = self::etag($def, $row);
        return $o;
    }

    private static function out(string $type, $v)
    {
        if ($v === null) return null;
        switch ($type) {
            case 'int': return (int)$v;
            case 'float': return round((float)$v, 4) == (int)$v && abs((float)$v) < 1e15 ? (float)$v : round((float)$v, 4);
            case 'bool': return (bool)(int)$v;
            case 'datetime': return Util::iso($v);
            case 'time': return Util::hhmm((string)$v);
            case 'json': return is_string($v) ? Util::jsonDecode($v) : $v;
            default: return $v;
        }
    }

    /** Validasi + konversi input → kolom. */
    public static function input(array $def, array $in, bool $create): array
    {
        $row = []; $err = [];
        foreach ($def['fields'] as $camel => $f) {
            [$col, $type] = $f;
            $o = $f[2] ?? [];
            if (!empty($o['readonly'])) continue;
            if ($col === $def['pk'] && !$create) continue;
            if (!array_key_exists($camel, $in)) {
                if ($create && !empty($o['required']) && !array_key_exists('default', $o)) $err[$camel] = 'required';
                elseif ($create && array_key_exists('default', $o)) $row[$col] = $o['default'];
                continue;
            }
            $v = $in[$camel];
            if (is_string($v)) $v = trim($v);
            if ($v === '' && $type !== 'str' && $type !== 'text') $v = null;
            if ($v === '' && !empty($o['nullable'])) $v = null;
            if ($v === null) {
                if (!empty($o['nullable'])) { $row[$col] = null; continue; }
                if (array_key_exists('default', $o) && empty($o['required'])) { $row[$col] = $o['default']; continue; }
                $err[$camel] = 'required'; continue;
            }
            try { $row[$col] = self::conv($type, $v, $o); }
            catch (InvalidArgumentException $e) { $err[$camel] = $e->getMessage(); }
        }
        if ($err) throw ApiError::validation($err);
        return $row;
    }

    private static function conv(string $type, $v, array $o)
    {
        switch ($type) {
            case 'int':
                if (!is_numeric($v) || (int)$v != $v) throw new InvalidArgumentException('integer');
                $v = (int)$v;
                if (isset($o['min']) && $v < $o['min']) throw new InvalidArgumentException('min_' . $o['min']);
                if (isset($o['max']) && $v > $o['max']) throw new InvalidArgumentException('max_' . $o['max']);
                return $v;
            case 'float':
                if (!is_numeric($v)) throw new InvalidArgumentException('number');
                $v = (float)$v;
                if (isset($o['min']) && $v < $o['min']) throw new InvalidArgumentException('min_' . $o['min']);
                if (isset($o['max']) && $v > $o['max']) throw new InvalidArgumentException('max_' . $o['max']);
                return $v;
            case 'bool': return Util::bool($v) ? 1 : 0;
            case 'enum':
                if (!in_array($v, $o['values'], true)) throw new InvalidArgumentException('one_of:' . implode('|', $o['values']));
                return $v;
            case 'color':
                if (!is_string($v) || !preg_match('/^#[0-9A-Fa-f]{6}$/', $v)) throw new InvalidArgumentException('color_#RRGGBB');
                return strtoupper($v);
            case 'url':
                if (!is_string($v) || !preg_match('#^https://[^\s<>"]+$#i', $v) || !filter_var($v, FILTER_VALIDATE_URL)) throw new InvalidArgumentException('https_url');
                return mb_substr($v, 0, $o['max'] ?? 500);
            case 'datetime':
                $t = strtotime((string)$v);
                if ($t === false) throw new InvalidArgumentException('datetime');
                return date('Y-m-d H:i:s', $t);
            case 'date':
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$v)) throw new InvalidArgumentException('date_YYYY-MM-DD');
                return (string)$v;
            case 'time':
                if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/', (string)$v) && $v !== '24:00') throw new InvalidArgumentException('time_HH:MM');
                return $v === '24:00' ? '23:59:59' : (strlen((string)$v) === 5 ? $v . ':00' : $v);
            case 'json':
                return Util::jsonEncode($v);
            case 'slug':
                if (!is_string($v) || !preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $v)) throw new InvalidArgumentException('slug_a-z0-9-');
                return $v;
            default: // str/text
                if (!is_scalar($v)) throw new InvalidArgumentException('string');
                $v = (string)$v;
                $max = $o['max'] ?? ($type === 'text' ? 65000 : 255);
                if (mb_strlen($v) > $max) throw new InvalidArgumentException('max_len_' . $max);
                if (isset($o['pattern']) && !preg_match($o['pattern'], $v)) throw new InvalidArgumentException('format');
                return $v;
        }
    }

    // ---------------------------------------------------------------- operasi
    public static function list(array $def, array $extraWhere = [], array $extraParams = []): array
    {
        $where = $extraWhere; $p = $extraParams;
        $q = Http::q('q');
        if ($q !== null && $q !== '' && !empty($def['search'])) {
            $or = [];
            foreach ($def['search'] as $c) { $or[] = "`$c` LIKE ?"; $p[] = '%' . $q . '%'; }
            $where[] = '(' . implode(' OR ', $or) . ')';
        }
        foreach ($def['filters'] ?? [] as $param => $col) {
            $v = Http::q($param);
            if ($v === null || $v === '') continue;
            $where[] = "`$col` = ?"; $p[] = $v;
        }
        $sql = 'FROM `' . $def['table'] . '`' . ($where ? ' WHERE ' . implode(' AND ', $where) : '');
        $total = (int)Db::val('SELECT COUNT(*) ' . $sql, $p);
        $sortKey = Http::q('sort', $def['defaultSort'] ?? null);
        $order = '`' . $def['pk'] . '`';
        if ($sortKey) {
            $desc = str_starts_with($sortKey, '-');
            $k = ltrim($sortKey, '-');
            $col = $def['sort'][$k] ?? (isset($def['fields'][$k]) ? $def['fields'][$k][0] : null);
            if ($col) $order = '`' . $col . '`' . ($desc ? ' DESC' : '') . ', `' . $def['pk'] . '`';
        }
        [$page, $per, $lim] = self::page();
        $rows = Db::all('SELECT * ' . $sql . ' ORDER BY ' . $order . $lim, $p);
        return ['data' => array_map(fn($r) => self::dto($def, $r), $rows), 'total' => $total, 'page' => $page, 'per' => $per];
    }

    public static function page(): array
    {
        $page = max(1, (int)(Http::q('page') ?? 1));
        $per = min(500, max(1, (int)(Http::q('per') ?? 50)));
        return [$page, $per, ' LIMIT ' . $per . ' OFFSET ' . (($page - 1) * $per)];
    }

    public static function get(array $def, $id): array
    {
        $r = self::find($def, $id);
        if (!$r) throw ApiError::notFound($def['label'] ?? 'Data');
        return self::dto($def, $r);
    }

    public static function create(array $def, array $in): array
    {
        $row = self::input($def, $in, true);
        return Db::tx(function () use ($def, $in, $row) {
            if (isset($def['hooks']['before'])) ($def['hooks']['before'])($row, $in, null);
            if (empty($def['pkAuto'])) {
                $pk = $row[$def['pk']] ?? null;
                if ($pk === null || $pk === '') throw ApiError::validation([Util::camel($def['pk']) => 'required']);
                if (self::find($def, $pk)) throw ApiError::conflict('ID sudah dipakai', ['id' => $pk]);
            }
            if (in_array('updated_by', $def['cols'] ?? [], true)) $row['updated_by'] = Auth::id();
            if (in_array('created_by', $def['cols'] ?? [], true)) $row['created_by'] = Auth::id();
            try { $id = Db::insert($def['table'], $row); }
            catch (PDOException $e) { throw self::pdoErr($e); }
            $id = empty($def['pkAuto']) ? $row[$def['pk']] : $id;
            if (isset($def['hooks']['after'])) ($def['hooks']['after'])($id, $in, null);
            if (!empty($def['scope'])) foreach ((array)$def['scope'] as $s) Revisions::bump($s);
            $new = self::find($def, $id);
            Audit::log('create', $def['entity'], (string)$id, ($def['label'] ?? $def['entity']) . ' dibuat', null, self::auditRow($def, $new));
            return self::dto($def, $new);
        });
    }

    /** Cek If-Match (§4.1). '*' = timpa paksa. */
    public static function checkEtag(string $current, $currentDto = null): void
    {
        $im = Http::header('If-Match');
        if ($im === null || $im === '') throw new ApiError('precondition', 'Header If-Match wajib (etag dari GET); pakai "*" untuk menimpa', [], ['currentEtag' => $current]);
        $im = trim($im, '" ');
        if ($im !== '*' && $im !== $current) throw ApiError::conflict('Data sudah diubah pengguna lain', ['current' => $currentDto, 'currentEtag' => $current]);
    }

    public static function update(array $def, $id, array $in): array
    {
        return Db::tx(function () use ($def, $id, $in) {
            $old = Db::one('SELECT * FROM `' . $def['table'] . '` WHERE `' . $def['pk'] . '`=? FOR UPDATE', [self::pkVal($def, $id)]);
            if (!$old) throw ApiError::notFound($def['label'] ?? 'Data');
            self::checkEtag(self::etag($def, $old), self::dto($def, $old));
            if (isset($in['id']) && empty($def['pkAuto']) && (string)$in['id'] !== (string)$id) throw ApiError::validation(['id' => 'immutable']);
            $row = self::input($def, $in, false);
            if (isset($def['hooks']['before'])) ($def['hooks']['before'])($row, $in, $old);
            if (in_array('updated_by', $def['cols'] ?? [], true)) $row['updated_by'] = Auth::id();
            try { if ($row) Db::update($def['table'], $row, [$def['pk'] => self::pkVal($def, $id)]); }
            catch (PDOException $e) { throw self::pdoErr($e); }
            if (isset($def['hooks']['after'])) ($def['hooks']['after'])($id, $in, $old);
            $new = self::find($def, $id);
            [$b, $a] = Audit::changed(self::auditRow($def, $old), self::auditRow($def, $new));
            if ($b !== null || $a !== null || !empty($def['alwaysBump'])) {
                if (!empty($def['scope'])) foreach ((array)(is_callable($def['scope']) ? ($def['scope'])($b, $a) : $def['scope']) as $s) Revisions::bump($s);
            }
            Audit::log('update', $def['entity'], (string)$id, ($def['label'] ?? $def['entity']) . ' diubah', $b, $a);
            return self::dto($def, $new);
        });
    }

    public static function delete(array $def, $id): void
    {
        Db::tx(function () use ($def, $id) {
            $old = self::find($def, $id);
            if (!$old) throw ApiError::notFound($def['label'] ?? 'Data');
            if (isset($def['hooks']['canDelete'])) ($def['hooks']['canDelete'])($id, $old);
            try { Db::exec('DELETE FROM `' . $def['table'] . '` WHERE `' . $def['pk'] . '`=?', [self::pkVal($def, $id)]); }
            catch (PDOException $e) { throw self::pdoErr($e, true); }
            if (!empty($def['scope'])) foreach ((array)(is_callable($def['scope']) ? ($def['scope'])(null, null) : $def['scope']) as $s) Revisions::bump($s);
            Audit::log('delete', $def['entity'], (string)$id, ($def['label'] ?? $def['entity']) . ' dihapus', self::auditRow($def, $old), null);
        });
    }

    private static function auditRow(array $def, ?array $r): ?array
    {
        if ($r === null) return null;
        unset($r['password_hash'], $r['token_hash'], $r['updated_at']);
        return $r;
    }

    public static function pdoErr(PDOException $e, bool $delete = false): ApiError
    {
        $m = $e->getMessage();
        if (str_contains($m, '1451') || str_contains($m, 'foreign key constraint fails') && $delete) return ApiError::conflict('Masih dipakai oleh data lain', ['db' => 'fk_restrict']);
        if (str_contains($m, '1452')) return ApiError::validation(['ref' => 'not_found'], 'Referensi tidak ditemukan');
        if (str_contains($m, '1062')) return ApiError::conflict('Nilai unik sudah dipakai', ['db' => 'duplicate']);
        if (str_contains($m, '4025') || str_contains($m, 'CONSTRAINT')) return ApiError::validation(['constraint' => 'violated'], 'Melanggar aturan data');
        return new ApiError('server', 'Kesalahan database');
    }
}
