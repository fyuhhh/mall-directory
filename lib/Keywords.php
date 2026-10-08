<?php
declare(strict_types=1);

/** Keyword pencarian saat publish (§2.2) — port CAT_KW dari tools/build_data.py. */
final class Keywords
{
    public const CAT_KW = [
        'food-beverage' => ['makan', 'minum', 'kuliner'],
        'fashion' => ['fashion', 'pakaian', 'baju'],
        'beauty-health' => ['kecantikan', 'kesehatan'],
        'electronics' => ['elektronik', 'gadget'],
        'kids-family' => ['anak', 'keluarga'],
        'entertainment' => ['hiburan'],
        'department-store' => ['belanja'],
        'services' => ['layanan'],
    ];
    public const BUILDING_LABEL = ['pentacity' => 'Pentacity', 'ewalk' => 'E-Walk'];

    public static function split(?string $s): array
    {
        if ($s === null || trim($s) === '') return [];
        return array_values(array_filter(array_map(fn($x) => mb_strtolower(trim($x)), explode(',', $s)), fn($x) => $x !== ''));
    }

    public static function build(?string $kwId, ?string $kwEn, string $category, string $floorShort, string $building): array
    {
        $kw = array_merge(self::split($kwId), self::split($kwEn), self::CAT_KW[$category] ?? [],
            [mb_strtolower($floorShort), mb_strtolower(self::BUILDING_LABEL[$building] ?? $building)]);
        $out = [];
        foreach ($kw as $k) if (!in_array($k, $out, true)) $out[] = $k;
        return $out;
    }
}
