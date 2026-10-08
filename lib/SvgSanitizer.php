<?php
declare(strict_types=1);

/** Sanitasi SVG whitelist (§8.2). Mengembalikan [svgBersih, laporan]. */
final class SvgSanitizer
{
    public const ELEMENTS = ['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
        'text', 'tspan', 'textPath', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'style'];
    public const SHAPES = ['path', 'rect', 'polygon', 'ellipse', 'circle', 'polyline'];
    private const SVG_NS = 'http://www.w3.org/2000/svg';
    private const XLINK_NS = 'http://www.w3.org/1999/xlink';

    public static function sanitize(string $svg, string $idPrefix = 'shp-'): array
    {
        $report = ['bytesIn' => strlen($svg), 'bytesOut' => 0,
            'removed' => ['script' => 0, 'foreignObject' => 0, 'on*' => 0, 'externalHref' => 0, 'image' => 0, 'aipgf' => 0, 'other' => 0, 'attr' => 0, 'styleRules' => 0],
            'assignedIds' => 0, 'shapes' => 0, 'viewBox' => null];
        if (preg_match('/<!DOCTYPE|<!ENTITY/i', $svg)) throw ApiError::validation(['file' => 'svg_doctype_not_allowed'], 'SVG berisi DOCTYPE/ENTITY — ditolak');
        if (str_contains($svg, '<?xml-stylesheet')) throw ApiError::validation(['file' => 'svg_stylesheet_pi'], 'SVG berisi xml-stylesheet — ditolak');
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $ok = $doc->loadXML($svg, LIBXML_NONET | LIBXML_PARSEHUGE);
        libxml_clear_errors(); libxml_use_internal_errors($prev);
        if (!$ok || !$doc->documentElement || $doc->documentElement->localName !== 'svg') throw ApiError::validation(['file' => 'svg_invalid'], 'Bukan file SVG yang valid');

        // buang processing instruction & komentar
        $xp = new DOMXPath($doc);
        foreach (iterator_to_array($xp->query('//processing-instruction()|//comment()')) as $n) $n->parentNode->removeChild($n);

        $walk = function (DOMElement $el) use (&$walk, &$report, $doc) {
            foreach (iterator_to_array($el->childNodes) as $ch) {
                if ($ch instanceof DOMElement) {
                    $name = $ch->localName;
                    $nsOk = $ch->namespaceURI === null || $ch->namespaceURI === self::SVG_NS;
                    if (!$nsOk || !in_array($name, self::ELEMENTS, true)) {
                        $k = $name === 'script' ? 'script' : ($name === 'foreignObject' ? 'foreignObject' : ($name === 'image' ? 'image' : (stripos($name, 'pgf') !== false || $ch->namespaceURI && stripos((string)$ch->namespaceURI, 'adobe') !== false ? 'aipgf' : 'other')));
                        $report['removed'][$k]++;
                        $el->removeChild($ch);
                        continue;
                    }
                    self::cleanAttrs($ch, $report);
                    if ($name === 'style') {
                        $css = $ch->textContent;
                        $clean = self::cleanCss($css, $report);
                        if ($clean !== $css) { while ($ch->firstChild) $ch->removeChild($ch->firstChild); $ch->appendChild($doc->createTextNode($clean)); }
                        continue;
                    }
                    $walk($ch);
                }
            }
        };
        self::cleanAttrs($doc->documentElement, $report);
        $walk($doc->documentElement);

        // id untuk shape tanpa id
        $n = 0; $used = [];
        foreach ($xp->query('//*[@id]') as $e) $used[$e->getAttribute('id')] = true;
        foreach ($xp->query('//*') as $e) {
            if (!in_array($e->localName, self::SHAPES, true)) continue;
            $report['shapes']++;
            if ($e->hasAttribute('id')) continue;
            do { $id = $idPrefix . (++$n); } while (isset($used[$id]));
            $e->setAttribute('id', $id); $used[$id] = true; $report['assignedIds']++;
        }
        $root = $doc->documentElement;
        $vb = preg_split('/[\s,]+/', trim($root->getAttribute('viewBox')));
        if (count($vb) === 4 && is_numeric($vb[2])) $report['viewBox'] = array_map('floatval', $vb);
        elseif (is_numeric($root->getAttribute('width')) && is_numeric($root->getAttribute('height'))) $report['viewBox'] = [0.0, 0.0, (float)$root->getAttribute('width'), (float)$root->getAttribute('height')];
        $out = $doc->saveXML($root);
        $report['bytesOut'] = strlen($out);
        $report['ids'] = array_keys($used);
        return [$out, $report];
    }

    private static function cleanAttrs(DOMElement $el, array &$report): void
    {
        foreach (iterator_to_array($el->attributes) as $a) {
            $n = strtolower($a->nodeName); $ln = strtolower($a->localName); $v = $a->value;
            $drop = false;
            if (str_starts_with($ln, 'on')) { $drop = true; $report['removed']['on*']++; }
            elseif ($ln === 'href') {
                if (!preg_match('/^#[\w.\-:]+$/', trim($v))) { $drop = true; $report['removed']['externalHref']++; }
            } elseif (preg_match('/javascript:|vbscript:|data:/i', $v)) { $drop = true; $report['removed']['attr']++; }
            elseif (preg_match('/url\(\s*[\'"]?(?!#)/i', $v)) { $drop = true; $report['removed']['externalHref']++; }
            elseif ($a->namespaceURI && !in_array($a->namespaceURI, [self::XLINK_NS, 'http://www.w3.org/XML/1998/namespace'], true)) { $drop = true; $report['removed']['aipgf']++; }
            elseif ($ln === 'style') {
                $c = self::cleanCss($v, $report);
                if ($c !== $v) $a->value = $c;
            }
            if ($drop) $el->removeAttributeNode($a);
        }
    }

    public static function cleanCss(string $css, array &$report): string
    {
        $out = preg_replace_callback('/@import[^;]*;?|expression\s*\(|behavior\s*:|-moz-binding|javascript:|url\(\s*[\'"]?(?!#)[^)]*\)/i', function () use (&$report) {
            $report['removed']['styleRules']++;
            return '';
        }, $css);
        return (string)$out;
    }
}
