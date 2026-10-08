<?php
declare(strict_types=1);

/** SVG lantai hasil publish (§5.4.10) → media/pub/floors/<floorId>.<sha8>.svg (immutable, ber-cache). */
final class SvgPublisher
{
    public const DIR = 'media/pub/floors';

    /**
     * @param array $links unit_shape_id => tenantId
     * @return array{0:string,1:array} [path relatif app root, daftar unit_shape_id yang tidak ditemukan]
     */
    public static function publish(string $floorId, string $srcPath, string $srcSha, array $links, bool $write = true): array
    {
        ksort($links);
        $key = hash('sha256', $floorId . '|' . $srcSha . '|' . json_encode($links) . '|v2');
        $cacheFile = APP_ROOT . '/' . self::DIR . '/.cache.json';
        $cache = is_file($cacheFile) ? (Util::jsonDecode((string)file_get_contents($cacheFile), []) ?: []) : [];
        if (isset($cache[$key]) && is_file(APP_ROOT . '/' . $cache[$key]['path'])) return [$cache[$key]['path'], $cache[$key]['missing']];

        $abs = APP_ROOT . '/' . $srcPath;
        if (!is_file($abs)) throw new ApiError('server', 'SVG sumber lantai ' . $floorId . ' hilang: ' . $srcPath);
        [$out, $missing] = self::transform($floorId, (string)file_get_contents($abs), $links);
        $sha8 = substr(hash('sha256', $out), 0, 8);
        $rel = self::DIR . '/' . $floorId . '.' . $sha8 . '.svg';
        if ($write) {
            if (!is_file(APP_ROOT . '/' . $rel)) Util::atomicWrite(APP_ROOT . '/' . $rel, $out);
            $cache[$key] = ['path' => $rel, 'missing' => $missing];
            try { Util::atomicWrite($cacheFile, json_encode($cache)); } catch (Throwable $e) { /* cache opsional */ }
        }
        return [$rel, $missing];
    }

    /** @return array{0:string,1:array} */
    public static function transform(string $floorId, string $svg, array $links): array
    {
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $ok = $doc->loadXML($svg, LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE);
        libxml_clear_errors(); libxml_use_internal_errors($prev);
        if (!$ok || !$doc->documentElement) throw new ApiError('server', 'SVG lantai ' . $floorId . ' tidak bisa di-parse');
        $prefix = $floorId . '--';
        $found = [];
        $rename = [];
        $xp = new DOMXPath($doc);
        $els = [];
        foreach ($xp->query('//*') as $el) $els[] = $el;
        foreach ($els as $el) {
            /** @var DOMElement $el */
            $id = $el->getAttribute('id');
            if ($id !== '' && isset($links[$id])) {
                $tid = $links[$id];
                $found[$id] = true;
                $new = 'unit-' . $tid;
                if ($new !== $id) $rename[$id] = $new;
                $el->setAttribute('id', $new);
                $el->setAttribute('data-tenant', $tid);
                $cls = preg_split('/\s+/', trim($el->getAttribute('class'))) ?: [];
                if (!in_array('unit', $cls, true)) { $cls[] = 'unit'; $el->setAttribute('class', trim(implode(' ', array_filter($cls)))); }
                continue;
            }
            if ($el->hasAttribute('data-tenant') || str_starts_with($id, 'unit-')) {
                $el->removeAttribute('data-tenant');
                if (str_starts_with($id, 'unit-')) $el->removeAttribute('id');
                if ($el->hasAttribute('class')) {
                    $cls = array_filter(preg_split('/\s+/', trim($el->getAttribute('class'))) ?: [], fn($c) => $c !== 'unit' && $c !== '');
                    if ($cls) $el->setAttribute('class', implode(' ', $cls)); else $el->removeAttribute('class');
                }
                continue;
            }
            if ($id !== '' && !str_starts_with($id, $prefix)) {
                $rename[$id] = $prefix . $id;
                $el->setAttribute('id', $prefix . $id);
            }
        }
        if ($rename) {
            foreach ($els as $el) {
                foreach (iterator_to_array($el->attributes) as $attr) {
                    $v = $attr->value;
                    if (!str_contains($v, '#')) continue;
                    $nv = preg_replace_callback('/url\(\s*[\'"]?#([^\'")\s]+)[\'"]?\s*\)/', fn($m) => isset($rename[$m[1]]) ? 'url(#' . $rename[$m[1]] . ')' : $m[0], $v);
                    if (($attr->localName === 'href') && str_starts_with($nv, '#') && isset($rename[substr($nv, 1)])) $nv = '#' . $rename[substr($nv, 1)];
                    if ($nv !== $v) $attr->value = $nv;
                }
                if ($el->localName === 'style') {
                    $css = $el->textContent;
                    $ncss = preg_replace_callback('/#([A-Za-z_][\w\-]*)/', fn($m) => isset($rename[$m[1]]) ? '#' . $rename[$m[1]] : $m[0], $css);
                    if ($ncss !== $css) $el->textContent = $ncss;
                }
            }
        }
        $missing = array_values(array_diff(array_keys($links), array_keys($found)));
        return [$doc->saveXML($doc->documentElement), $missing];
    }
}
