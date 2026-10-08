<?php
declare(strict_types=1);

/**
 * Encoder QR Code minimal (byte mode, ECC M, versi 1–20) → SVG. Untuk QR provisioning kiosk (§4.5).
 * Algoritma mengikuti ISO/IEC 18004 (struktur ala Nayuki "QR Code generator", MIT).
 */
final class Qr
{
    // versi => [ecPerBlock, [[blok, dataPerBlok], ...]]  (level M)
    private const M = [
        1 => [10, [[1, 16]]], 2 => [16, [[1, 28]]], 3 => [26, [[1, 44]]], 4 => [18, [[2, 32]]], 5 => [24, [[2, 43]]],
        6 => [16, [[4, 27]]], 7 => [18, [[4, 31]]], 8 => [22, [[2, 38], [2, 39]]], 9 => [22, [[3, 36], [2, 37]]], 10 => [26, [[4, 43], [1, 44]]],
        11 => [30, [[1, 50], [4, 51]]], 12 => [22, [[6, 36], [2, 37]]], 13 => [22, [[8, 37], [1, 38]]], 14 => [24, [[4, 40], [5, 41]]],
        15 => [24, [[5, 41], [5, 42]]], 16 => [28, [[7, 45], [3, 46]]], 17 => [28, [[10, 46], [1, 47]]], 18 => [26, [[9, 43], [4, 44]]],
        19 => [26, [[3, 44], [11, 45]]], 20 => [26, [[3, 41], [13, 42]]],
    ];
    private const ALIGN = [1 => [], 2 => [6, 18], 3 => [6, 22], 4 => [6, 26], 5 => [6, 30], 6 => [6, 34], 7 => [6, 22, 38], 8 => [6, 24, 42],
        9 => [6, 26, 46], 10 => [6, 28, 50], 11 => [6, 30, 54], 12 => [6, 32, 58], 13 => [6, 34, 62], 14 => [6, 26, 46, 66], 15 => [6, 26, 48, 70],
        16 => [6, 26, 50, 74], 17 => [6, 30, 54, 78], 18 => [6, 30, 56, 82], 19 => [6, 30, 58, 86], 20 => [6, 34, 62, 90]];

    private int $size;
    private array $mod = [];
    private array $fn = [];

    /** @return bool[][] matriks [y][x]; $forceMask untuk pengujian */
    public static function matrix(string $text, ?int $forceMask = null): array
    {
        $bytes = array_values(unpack('C*', $text) ?: []);
        $len = count($bytes);
        $ver = null;
        foreach (self::M as $v => [$ec, $groups]) {
            $cap = 0; foreach ($groups as [$n, $d]) $cap += $n * $d;
            $need = 4 + ($v < 10 ? 8 : 16) + 8 * $len;
            if ($need <= $cap * 8) { $ver = $v; break; }
        }
        if ($ver === null) throw new InvalidArgumentException('Teks terlalu panjang untuk QR v20-M');
        $q = new self();
        return $q->build($ver, $bytes, $forceMask);
    }

    private function build(int $ver, array $bytes, ?int $forceMask): array
    {
        [$ecLen, $groups] = self::M[$ver];
        $cap = 0; foreach ($groups as [$n, $d]) $cap += $n * $d;
        // bit stream
        $bits = [];
        $put = function (int $val, int $n) use (&$bits) { for ($i = $n - 1; $i >= 0; $i--) $bits[] = ($val >> $i) & 1; };
        $put(4, 4); $put(count($bytes), $ver < 10 ? 8 : 16);
        foreach ($bytes as $b) $put($b, 8);
        $put(0, min(4, $cap * 8 - count($bits)));
        while (count($bits) % 8) $bits[] = 0;
        $data = [];
        for ($i = 0; $i < count($bits); $i += 8) { $v = 0; for ($j = 0; $j < 8; $j++) $v = ($v << 1) | $bits[$i + $j]; $data[] = $v; }
        for ($pad = 0xEC; count($data) < $cap; $pad ^= 0xEC ^ 0x11) $data[] = $pad;
        // blok + ECC
        $div = self::rsDivisor($ecLen);
        $blocks = []; $eccs = []; $k = 0;
        foreach ($groups as [$n, $d]) for ($i = 0; $i < $n; $i++) { $blk = array_slice($data, $k, $d); $k += $d; $blocks[] = $blk; $eccs[] = self::rsRemainder($blk, $div); }
        $maxD = max(array_map('count', $blocks));
        $all = [];
        for ($i = 0; $i < $maxD; $i++) foreach ($blocks as $b) if ($i < count($b)) $all[] = $b[$i];
        for ($i = 0; $i < $ecLen; $i++) foreach ($eccs as $e) $all[] = $e[$i];

        $this->size = $ver * 4 + 17;
        $s = $this->size;
        $this->mod = array_fill(0, $s, array_fill(0, $s, false));
        $this->fn = array_fill(0, $s, array_fill(0, $s, false));
        for ($i = 0; $i < $s; $i++) { $this->set(6, $i, $i % 2 === 0); $this->set($i, 6, $i % 2 === 0); }
        $this->finder(3, 3); $this->finder($s - 4, 3); $this->finder(3, $s - 4);
        $al = self::ALIGN[$ver]; $na = count($al);
        for ($i = 0; $i < $na; $i++) for ($j = 0; $j < $na; $j++) {
            if (($i === 0 && $j === 0) || ($i === 0 && $j === $na - 1) || ($i === $na - 1 && $j === 0)) continue;
            for ($dy = -2; $dy <= 2; $dy++) for ($dx = -2; $dx <= 2; $dx++) $this->set($al[$i] + $dx, $al[$j] + $dy, max(abs($dx), abs($dy)) !== 1);
        }
        $this->format(0);
        $this->version($ver);
        // data
        $i = 0; $nb = count($all) * 8;
        for ($right = $s - 1; $right >= 1; $right -= 2) {
            if ($right === 6) $right = 5;
            for ($vert = 0; $vert < $s; $vert++) for ($j = 0; $j < 2; $j++) {
                $x = $right - $j; $up = (($right + 1) & 2) === 0; $y = $up ? $s - 1 - $vert : $vert;
                if (!$this->fn[$y][$x] && $i < $nb) { $this->mod[$y][$x] = (($all[$i >> 3] >> (7 - ($i & 7))) & 1) === 1; $i++; }
            }
        }
        // mask
        $best = $forceMask; $bestScore = PHP_INT_MAX;
        if ($best === null) {
            for ($m = 0; $m < 8; $m++) {
                $this->mask($m); $this->format($m);
                $sc = $this->penalty();
                if ($sc < $bestScore) { $bestScore = $sc; $best = $m; }
                $this->mask($m);
            }
        }
        $this->mask($best); $this->format($best);
        return $this->mod;
    }

    private function set(int $x, int $y, bool $dark): void { $this->mod[$y][$x] = $dark; $this->fn[$y][$x] = true; }

    private function finder(int $x, int $y): void
    {
        for ($dy = -4; $dy <= 4; $dy++) for ($dx = -4; $dx <= 4; $dx++) {
            $xx = $x + $dx; $yy = $y + $dy;
            if ($xx >= 0 && $xx < $this->size && $yy >= 0 && $yy < $this->size) { $d = max(abs($dx), abs($dy)); $this->set($xx, $yy, $d !== 2 && $d !== 4); }
        }
    }

    private function format(int $mask): void
    {
        $data = (0 << 3) | $mask;   // ECC M = 00
        $rem = $data;
        for ($i = 0; $i < 10; $i++) $rem = ($rem << 1) ^ (($rem >> 9) * 0x537);
        $bits = (($data << 10) | $rem) ^ 0x5412;
        $g = fn($i) => (($bits >> $i) & 1) === 1;
        $s = $this->size;
        for ($i = 0; $i <= 5; $i++) $this->set(8, $i, $g($i));
        $this->set(8, 7, $g(6)); $this->set(8, 8, $g(7)); $this->set(7, 8, $g(8));
        for ($i = 9; $i < 15; $i++) $this->set(14 - $i, 8, $g($i));
        for ($i = 0; $i < 8; $i++) $this->set($s - 1 - $i, 8, $g($i));
        for ($i = 8; $i < 15; $i++) $this->set(8, $s - 15 + $i, $g($i));
        $this->set(8, $s - 8, true);
    }

    private function version(int $ver): void
    {
        if ($ver < 7) return;
        $rem = $ver;
        for ($i = 0; $i < 12; $i++) $rem = ($rem << 1) ^ (($rem >> 11) * 0x1F25);
        $bits = ($ver << 12) | $rem;
        for ($i = 0; $i < 18; $i++) {
            $bit = (($bits >> $i) & 1) === 1; $a = $this->size - 11 + $i % 3; $b = intdiv($i, 3);
            $this->set($a, $b, $bit); $this->set($b, $a, $bit);
        }
    }

    private function mask(int $m): void
    {
        $s = $this->size;
        for ($y = 0; $y < $s; $y++) for ($x = 0; $x < $s; $x++) {
            if ($this->fn[$y][$x]) continue;
            switch ($m) {
                case 0: $inv = ($x + $y) % 2 === 0; break;
                case 1: $inv = $y % 2 === 0; break;
                case 2: $inv = $x % 3 === 0; break;
                case 3: $inv = ($x + $y) % 3 === 0; break;
                case 4: $inv = (intdiv($x, 3) + intdiv($y, 2)) % 2 === 0; break;
                case 5: $inv = ($x * $y % 2 + $x * $y % 3) === 0; break;
                case 6: $inv = (($x * $y % 2 + $x * $y % 3) % 2) === 0; break;
                default: $inv = ((($x + $y) % 2 + $x * $y % 3) % 2) === 0;
            }
            if ($inv) $this->mod[$y][$x] = !$this->mod[$y][$x];
        }
    }

    /** Penalti N1 (run), N2 (blok 2×2), N3 (pola finder), N4 (keseimbangan). */
    private function penalty(): int
    {
        $s = $this->size; $m = $this->mod; $p = 0; $dark = 0;
        for ($pass = 0; $pass < 2; $pass++) {
            for ($a = 0; $a < $s; $a++) {
                $run = 0; $prev = null; $line = [];
                for ($b = 0; $b < $s; $b++) {
                    $v = $pass === 0 ? $m[$a][$b] : $m[$b][$a];
                    $line[] = $v ? 1 : 0;
                    if ($v === $prev) { $run++; if ($run === 5) $p += 3; elseif ($run > 5) $p++; }
                    else { $run = 1; $prev = $v; }
                }
                $str = implode('', $line);
                $p += 40 * (substr_count('0000' . $str, '00001011101') + substr_count($str . '0000', '10111010000'));
            }
        }
        for ($y = 0; $y < $s; $y++) for ($x = 0; $x < $s; $x++) {
            if ($m[$y][$x]) $dark++;
            if ($x < $s - 1 && $y < $s - 1) { $c = $m[$y][$x]; if ($c === $m[$y][$x + 1] && $c === $m[$y + 1][$x] && $c === $m[$y + 1][$x + 1]) $p += 3; }
        }
        $total = $s * $s;
        $k = (int)ceil(abs($dark * 20 - $total * 10) / $total) - 1;
        return $p + max(0, $k) * 10;
    }

    private static function gmul(int $x, int $y): int
    {
        $z = 0;
        for ($i = 7; $i >= 0; $i--) { $z = ($z << 1) ^ (($z >> 7) * 0x11D); $z ^= (($y >> $i) & 1) * $x; }
        return $z & 0xFF;
    }
    private static function rsDivisor(int $deg): array
    {
        $r = array_fill(0, $deg, 0); $r[$deg - 1] = 1; $root = 1;
        for ($i = 0; $i < $deg; $i++) {
            for ($j = 0; $j < $deg; $j++) { $r[$j] = self::gmul($r[$j], $root); if ($j + 1 < $deg) $r[$j] ^= $r[$j + 1]; }
            $root = self::gmul($root, 0x02);
        }
        return $r;
    }
    private static function rsRemainder(array $data, array $div): array
    {
        $r = array_fill(0, count($div), 0);
        foreach ($data as $b) {
            $f = $b ^ array_shift($r); $r[] = 0;
            foreach ($div as $i => $c) $r[$i] ^= self::gmul($c, $f);
        }
        return $r;
    }

    public static function svg(string $text, int $margin = 2): string
    {
        $m = self::matrix($text);
        $n = count($m); $size = $n + 2 * $margin; $d = '';
        for ($y = 0; $y < $n; $y++) for ($x = 0; $x < $n; $x++) {
            if (!$m[$y][$x]) continue;
            $s = $x; while ($x + 1 < $n && $m[$y][$x + 1]) $x++;
            $w = $x - $s + 1;
            $d .= 'M' . ($s + $margin) . ' ' . ($y + $margin) . 'h' . $w . 'v1h-' . $w . 'z';
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $size . ' ' . $size . '" shape-rendering="crispEdges"><rect width="' . $size . '" height="' . $size . '" fill="#fff"/><path d="' . $d . '" fill="#1d1a17"/></svg>';
    }
}
