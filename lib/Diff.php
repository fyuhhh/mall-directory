<?php
declare(strict_types=1);

/** Diff directory kandidat vs rilis live, per seksi content/map (§2.14). */
final class Diff
{
    private const IGNORE_TENANT = [];

    /**
     * @param array|null $live  snapshot live (null = belum ada)
     * @param array $spurNodes  node id 'n<k>' berlabel spur:<tenant> → dihitung sebagai bagian tenant, bukan map
     */
    public static function directory(?array $live, array $cand, array $spurNodes = []): array
    {
        $live = $live ?? ['floors' => [], 'categories' => [], 'tenants' => [], 'kiosks' => [], 'amenities' => [], 'graph' => ['nodes' => [], 'edges' => [], 'rules' => []], 'i18n' => [], 'meta' => []];
        $spur = array_flip($spurNodes);
        $content = [
            'tenants' => self::coll($live['tenants'] ?? [], $cand['tenants'] ?? []),
            'categories' => self::coll($live['categories'] ?? [], $cand['categories'] ?? []),
            'i18n' => self::i18n($live['i18n'] ?? [], $cand['i18n'] ?? []),
            'settings' => self::fields($live['meta'] ?? [], $cand['meta'] ?? [], ['mallHours', 'config']),
            // SVG publish berubah karena tautan unit tenant (penggantian SVG sumber juga mengubah floors.viewBox → seksi map)
            'floorSvg' => self::svgChanged($live['floors'] ?? [], $cand['floors'] ?? []),
        ];
        // map
        $nodes = self::nodes($live['graph']['nodes'] ?? [], $cand['graph']['nodes'] ?? [], $spur);
        $edges = self::edges($live['graph']['edges'] ?? [], $cand['graph']['edges'] ?? [], $spur);
        $legs = self::legs($live['graph'] ?? [], $cand['graph'] ?? []);
        $map = [
            'nodes' => $nodes,
            'edges' => $edges,
            'legs' => $legs,
            'floors' => self::coll($live['floors'] ?? [], $cand['floors'] ?? [], ['svg']),
            'kiosks' => self::coll($live['kiosks'] ?? [], $cand['kiosks'] ?? []),
            'amenities' => self::coll($live['amenities'] ?? [], $cand['amenities'] ?? []),
            'amenityTypes' => self::coll($live['amenityTypes'] ?? [], $cand['amenityTypes'] ?? []),
            'settings' => self::fields($live['meta'] ?? [], $cand['meta'] ?? [], ['mapNorthDeg']),
        ];
        $sections = [];
        if (self::nonEmpty($content)) $sections[] = 'content';
        if (self::nonEmpty($map)) $sections[] = 'map';
        return ['content' => $content, 'map' => $map, 'sectionsChanged' => $sections];
    }

    private static function nonEmpty(array $sec): bool
    {
        foreach ($sec as $v) {
            if (!is_array($v)) { if ($v) return true; continue; }
            foreach (['added', 'removed', 'changed', 'moved'] as $k) {
                if (isset($v[$k]) && (is_array($v[$k]) ? count($v[$k]) : $v[$k])) return true;
            }
            if (isset($v['fields']) && $v['fields']) return true;
        }
        return false;
    }

    private static function index(array $list): array { $o = []; foreach ($list as $x) $o[$x['id']] = $x; return $o; }

    private static function coll(array $a, array $b, array $ignoreFields = []): array
    {
        $A = self::index($a); $B = self::index($b);
        $added = array_values(array_diff(array_keys($B), array_keys($A)));
        $removed = array_values(array_diff(array_keys($A), array_keys($B)));
        $changed = [];
        foreach ($B as $id => $x) {
            if (!isset($A[$id])) continue;
            $f = [];
            foreach (array_unique(array_merge(array_keys($A[$id]), array_keys($x))) as $k) {
                if (in_array($k, $ignoreFields, true)) continue;
                if (json_encode($A[$id][$k] ?? null) !== json_encode($x[$k] ?? null)) $f[] = $k;
            }
            if ($f) $changed[] = ['id' => (string)$id, 'fields' => $f];
        }
        return ['added' => $added, 'removed' => $removed, 'changed' => $changed];
    }

    private static function fields(array $a, array $b, array $keys): array
    {
        $f = [];
        foreach ($keys as $k) if (json_encode($a[$k] ?? null) !== json_encode($b[$k] ?? null)) $f[] = $k;
        return ['fields' => $f];
    }

    private static function i18n(array $a, array $b): array
    {
        $ch = [];
        foreach (['en', 'id'] as $l) {
            $x = (array)($a[$l] ?? []); $y = (array)($b[$l] ?? []);
            foreach (array_unique(array_merge(array_keys($x), array_keys($y))) as $k) if (($x[$k] ?? null) !== ($y[$k] ?? null)) $ch[] = $l . ':' . $k;
        }
        return ['changed' => $ch];
    }

    private static function nodes(array $a, array $b, array $spur): array
    {
        $A = self::index($a); $B = self::index($b);
        $added = 0; $removed = 0; $moved = 0; $spurN = 0;
        foreach ($B as $id => $n) {
            if (isset($spur[$id])) { if (!isset($A[$id]) || $A[$id]['x'] != $n['x'] || $A[$id]['y'] != $n['y']) $spurN++; continue; }
            if (!isset($A[$id])) $added++;
            elseif ($A[$id]['x'] != $n['x'] || $A[$id]['y'] != $n['y'] || $A[$id]['floor'] !== $n['floor']) $moved++;
        }
        foreach ($A as $id => $_) if (!isset($B[$id]) && !isset($spur[$id])) $removed++;
        return ['added' => $added, 'removed' => $removed, 'moved' => $moved, 'spur' => $spurN];
    }

    private static function ekey(array $e): string
    {
        $dir = strncmp($e[3], 'escalator', 9) === 0;
        [$x, $y] = $dir ? [$e[0], $e[1]] : (strcmp($e[0], $e[1]) < 0 ? [$e[0], $e[1]] : [$e[1], $e[0]]);
        return $x . '|' . $y . '|' . $e[3];
    }

    private static function edges(array $a, array $b, array $spur): array
    {
        $A = []; $B = [];
        foreach ($a as $e) if ($e[3] === 'walk') $A[self::ekey($e)] = $e;
        foreach ($b as $e) if ($e[3] === 'walk') $B[self::ekey($e)] = $e;
        $isSpur = fn($e) => isset($spur[$e[0]]) || isset($spur[$e[1]]);
        $added = 0; $removed = 0; $changed = 0;
        foreach ($B as $k => $e) {
            if ($isSpur($e)) continue;
            if (!isset($A[$k])) $added++;
            elseif (json_encode($A[$k]) !== json_encode($e)) $changed++;
        }
        foreach ($A as $k => $e) if (!isset($B[$k]) && !$isSpur($e)) $removed++;
        return ['added' => $added, 'removed' => $removed, 'changed' => $changed];
    }

    /** Leg: dibandingkan per key L<id> (atau pasangan node untuk snapshot lama tanpa key). */
    private static function legs(array $ga, array $gb): array
    {
        $sig = function (array $g): array {
            $o = [];
            foreach ($g['edges'] ?? [] as $e) {
                if ($e[3] === 'walk') continue;
                $k = $e[4] ?? null;
                if ($k === null) { $p = [$e[0], $e[1]]; sort($p); $k = 'pair:' . implode('-', $p); }
                $o[$k]['types'][] = $e[3];
                $o[$k]['cost'] = $e[2];
                $o[$k]['nodes'] = [$e[0], $e[1]];
            }
            foreach ($o as &$x) { sort($x['types']); } unset($x);
            return $o;
        };
        $A = $sig($ga); $B = $sig($gb);
        // map snapshot lama (tanpa key) ke key baru lewat pasangan node
        $pairOf = function (array $x) { $p = $x['nodes']; sort($p); return 'pair:' . implode('-', $p); };
        $Ap = []; foreach ($A as $k => $x) $Ap[$pairOf($x)] = $k;
        $rules = (array)($gb['rules'] ?? []);
        $label = function ($k) use ($rules) { $r = $rules[$k] ?? null; $r = is_object($r) ? (array)$r : $r; $l = $r['label'] ?? null; $l = is_object($l) ? (array)$l : $l; return $l['id'] ?? $k; };
        $dirOf = fn($types) => in_array('escalator-up', $types, true) && in_array('escalator-down', $types, true) ? 'both'
            : (in_array('escalator-up', $types, true) ? 'up' : (in_array('escalator-down', $types, true) ? 'down' : 'both'));
        $changed = []; $added = []; $removed = [];
        $matched = [];
        foreach ($B as $k => $x) {
            $ak = isset($A[$k]) ? $k : ($Ap[$pairOf($x)] ?? null);
            if ($ak === null) { $added[] = ['id' => $k, 'label' => $label($k), 'direction' => $dirOf($x['types'])]; continue; }
            $matched[$ak] = true;
            $f = [];
            $da = $dirOf($A[$ak]['types']); $db = $dirOf($x['types']);
            if ($da !== $db) $f[] = "direction: {$da}→{$db}";
            if ((float)$A[$ak]['cost'] !== (float)$x['cost']) $f[] = "cost: {$A[$ak]['cost']}→{$x['cost']}";
            if ($f) $changed[] = ['id' => $k, 'label' => $label($k), 'fields' => $f];
        }
        foreach ($A as $k => $x) if (!isset($matched[$k])) $removed[] = ['id' => $k, 'nodes' => $x['nodes']];
        return ['added' => $added, 'removed' => $removed, 'changed' => $changed];
    }

    private static function svgChanged(array $a, array $b): array
    {
        $A = self::index($a); $ch = [];
        foreach ($b as $f) if (isset($A[$f['id']]) && ($A[$f['id']]['svg'] ?? null) !== $f['svg']) $ch[] = $f['id'];
        return ['changed' => $ch];
    }
}
