<?php
declare(strict_types=1);

/**
 * Dijkstra atas graph snapshot — semantik identik js/route.js & tools/verify_routes.py:
 * walk/lift/stairs/crossing tak berarah; escalator-* berarah (e[0]→e[1]); aksesibel membuang escalator* & stairs.
 */
final class RouteCheck
{
    /**
     * @param callable|null $edgeOpen fn(array $edge): bool — filter jadwal/closure (null = semua terbuka)
     * @return array<string, array<int, array{0:string,1:float,2:string}>>
     */
    public static function adjacency(array $D, bool $accessible, ?callable $edgeOpen = null): array
    {
        $adj = [];
        foreach ($D['graph']['nodes'] as $n) $adj[$n['id']] = [];
        foreach ($D['graph']['edges'] as $e) {
            [$a, $b, $c, $t] = $e;
            if (!isset($adj[$a]) || !isset($adj[$b])) continue;
            $isEsc = strncmp($t, 'escalator', 9) === 0;
            if ($accessible && ($isEsc || $t === 'stairs')) continue;
            if ($edgeOpen && !$edgeOpen($e)) continue;
            $adj[$a][] = [$b, (float)$c, $t];
            if (!$isEsc) $adj[$b][] = [$a, (float)$c, $t];
        }
        return $adj;
    }

    /** @return array{0: array<string,float>, 1: array<string,array>} [dist, prev] */
    public static function dijkstra(array $adj, string $src, bool $withPrev = false): array
    {
        $dist = [$src => 0.0];
        $prev = [];
        if (!isset($adj[$src])) return [$dist, $prev];
        $pq = new SplPriorityQueue();
        $pq->setExtractFlags(SplPriorityQueue::EXTR_BOTH);
        $pq->insert($src, 0.0);
        $done = [];
        while (!$pq->isEmpty()) {
            $top = $pq->extract();
            $u = $top['data']; $d = -$top['priority'];
            if (isset($done[$u])) continue;
            $done[$u] = true;
            if ($d > $dist[$u]) continue;
            foreach ($adj[$u] as [$v, $c, $t]) {
                $nd = $d + $c;
                if (!isset($dist[$v]) || $nd < $dist[$v]) {
                    $dist[$v] = $nd;
                    if ($withPrev) $prev[$v] = [$u, $t];
                    $pq->insert($v, -$nd);
                }
            }
        }
        return [$dist, $prev];
    }

    public static function path(array $prev, string $src, string $dst): array
    {
        $out = [$dst];
        $types = [];
        while (end($out) !== $src) {
            $p = $prev[end($out)] ?? null;
            if (!$p) return [];
            $types[] = $p[1];
            $out[] = $p[0];
        }
        return ['nodes' => array_reverse($out), 'types' => array_reverse($types)];
    }

    /**
     * Fungsi filter edge untuk "saat ini": jadwal (graph.rules[*].hours) + closures/edgeOverrides status.json.
     * $ignoreHours: true = hanya closure (dipakai untuk dampak closure).
     */
    public static function openFilter(array $D, ?array $status, int $now, bool $ignoreHours = false, bool $ignoreTimeOfClosure = false): callable
    {
        $rules = (array)($D['graph']['rules'] ?? []);
        $ov = [];
        foreach (($status['edgeOverrides'] ?? []) as $o) { $ov[$o[0] . '|' . $o[1]] = true; $ov[$o[1] . '|' . $o[0]] = true; }
        $cl = [];
        foreach (($status['closures'] ?? []) as $c) $cl[$c['key']][] = $c;
        return function (array $e) use ($rules, $ov, $cl, $now, $ignoreHours, $ignoreTimeOfClosure): bool {
            if ($ov && isset($ov[$e[0] . '|' . $e[1]])) return false;
            $key = $e[4] ?? null;
            if ($key === null) return true;
            $r = $rules[$key] ?? null;
            if (is_object($r)) $r = (array)$r;
            if (!$ignoreHours && $r && !empty($r['hours']) && !Schedule::isOpen((array)$r['hours'], $now)) return false;
            foreach ($cl[$key] ?? [] as $c) {
                $from = strtotime((string)$c['from']); $to = $c['to'] ? strtotime((string)$c['to']) : PHP_INT_MAX;
                $timeOk = $ignoreTimeOfClosure ? ($to > $now) : ($now >= $from && $now < $to);
                $dir = $e[3] === 'escalator-up' ? 'up' : ($e[3] === 'escalator-down' ? 'down' : 'both');
                if ($timeOk && ($c['dir'] === 'both' || $c['dir'] === $dir)) return false;
            }
            return true;
        };
    }

    /** Matriks keterjangkauan kiosk → tenant. @return array{reach:int,pairs:int,unreach:array<string,string[]>} */
    public static function reachability(array $D, bool $accessible, ?callable $filter = null): array
    {
        $adj = self::adjacency($D, $accessible, $filter);
        $pairs = 0; $reach = 0; $unreach = [];
        foreach ($D['kiosks'] as $k) {
            if (!$k['node']) continue;
            [$dist] = self::dijkstra($adj, $k['node']);
            foreach ($D['tenants'] as $t) {
                $pairs++;
                if ($t['node'] !== null && isset($dist[$t['node']])) $reach++;
                else $unreach[$t['id']][] = $k['id'];
            }
        }
        return ['reach' => $reach, 'pairs' => $pairs, 'unreach' => $unreach];
    }

    /** Biaya kiosk→tenant (untuk perbandingan legacy). @return array<string, array<string, float|null>> */
    public static function costMatrix(array $D, bool $accessible = false): array
    {
        $adj = self::adjacency($D, $accessible);
        $out = [];
        foreach ($D['kiosks'] as $k) {
            [$dist] = self::dijkstra($adj, $k['node']);
            foreach ($D['tenants'] as $t) $out[$k['id']][$t['id']] = isset($dist[$t['node']]) ? round($dist[$t['node']], 2) : null;
        }
        return $out;
    }
}
