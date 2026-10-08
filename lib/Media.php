<?php
declare(strict_types=1);

/** Upload & re-encode media (§8.2). Rantai encoder: GD imagewebp → cwebp CLI → PNG (logo) / JPEG q82 (foto). */
final class Media
{
    public const LIMITS = ['logo' => 5 << 20, 'image' => 10 << 20, 'video' => 30 << 20, 'svg' => 8 << 20];
    public const FOLDERS = ['logo' => 'media/logos', 'image' => 'media/promos', 'video' => 'media/promos', 'svg' => 'media/floors'];

    public static function url(?array $m): ?array
    {
        if (!$m || empty($m['path'])) return null;
        return ['id' => (int)$m['id'], 'url' => $m['path'], 'url2x' => $m['path_2x'] ?? null];
    }

    public static function dto(array $m): array
    {
        $meta = Util::jsonDecode($m['meta'] ?? null, []) ?: [];
        return ['id' => (int)$m['id'], 'kind' => $m['kind'], 'url' => $m['path'], 'url2x' => $m['path_2x'], 'mime' => $m['mime'],
            'width' => $m['width'] === null ? null : (int)$m['width'], 'height' => $m['height'] === null ? null : (int)$m['height'],
            'bytes' => (int)$m['bytes'], 'durationSec' => $m['duration_sec'] === null ? null : (float)$m['duration_sec'],
            'sha256' => $m['sha256'], 'createdBy' => $m['created_by'] === null ? null : (int)$m['created_by'], 'originalName' => $m['original_name'], 'altText' => $m['alt_text'],
            'encoder' => $meta['encoder'] ?? null, 'warnings' => $meta['warnings'] ?? [], 'createdAt' => Util::iso($m['created_at'])];
    }

    public static function magic(string $path): ?string
    {
        $h = (string)file_get_contents($path, false, null, 0, 64);
        if (str_starts_with($h, "\x89PNG\r\n\x1a\n")) return 'image/png';
        if (str_starts_with($h, "\xFF\xD8\xFF")) return 'image/jpeg';
        if (substr($h, 0, 4) === 'RIFF' && substr($h, 8, 4) === 'WEBP') return 'image/webp';
        if (substr($h, 4, 4) === 'ftyp') return 'video/mp4';
        $t = ltrim($h, "\xEF\xBB\xBF \t\r\n");
        if (str_starts_with($t, '<?xml') || str_starts_with($t, '<svg') || str_starts_with($t, '<!--')) return 'image/svg+xml';
        return null;
    }

    /**
     * @param array $file elemen $_FILES
     * @param string $kind logo|image|video|svg
     */
    public static function upload(array $file, string $kind, array $opts = []): array
    {
        if (!isset(self::LIMITS[$kind])) throw ApiError::validation(['kind' => 'one_of:logo|image|video|svg']);
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            $code = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
            throw ApiError::validation(['file' => in_array($code, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) ? 'too_large' : 'upload_error_' . $code]);
        }
        $tmp = (string)$file['tmp_name'];
        if (!is_file($tmp) || (!is_uploaded_file($tmp) && empty($opts['trustedTmp']))) throw ApiError::validation(['file' => 'missing']);
        $size = filesize($tmp);
        if ($size > self::LIMITS[$kind]) throw ApiError::validation(['file' => 'too_large_max_' . (self::LIMITS[$kind] >> 20) . 'MB']);
        $magic = self::magic($tmp);
        $finfo = (new finfo(FILEINFO_MIME_TYPE))->file($tmp) ?: '';
        $sha = hash_file('sha256', $tmp);
        $orig = mb_substr(basename((string)($file['name'] ?? 'upload')), 0, 190);
        $exist = Db::one('SELECT * FROM media WHERE sha256=? AND kind=?', [$sha, $kind]);
        if ($exist) return self::dto($exist) + ['deduped' => true];

        $warnings = [];
        switch ($kind) {
            case 'logo':
            case 'image':
                if ($magic === 'image/svg+xml') throw ApiError::validation(['file' => 'svg_not_allowed_for_logo'], 'Logo SVG tidak diterima — unggah PNG transparan (≥ 600 px)');
                if (!in_array($magic, ['image/png', 'image/jpeg', 'image/webp'], true) || !in_array($finfo, ['image/png', 'image/jpeg', 'image/webp'], true))
                    throw ApiError::validation(['file' => 'type_png_jpg_webp'], 'Format harus PNG/JPG/WebP');
                $r = self::raster($tmp, $magic, $kind, $sha, $warnings);
                break;
            case 'video':
                if ($magic !== 'video/mp4') throw ApiError::validation(['file' => 'type_mp4'], 'Video harus MP4 (H.264)');
                $info = self::mp4Info($tmp);
                if (!$info['brandOk']) throw ApiError::validation(['file' => 'mp4_brand'], 'MP4 tidak dikenali (ftyp)');
                if ($info['duration'] === null) throw ApiError::validation(['file' => 'mp4_no_duration']);
                if ($info['duration'] > 30.5) throw ApiError::validation(['file' => 'max_30s'], 'Durasi video maksimal 30 detik');
                $rel = self::FOLDERS['video'] . '/' . substr($sha, 0, 16) . '.mp4';
                Util::ensureDir(APP_ROOT . '/' . dirname($rel));
                if (!copy($tmp, APP_ROOT . '/' . $rel)) throw new ApiError('server', 'Gagal menyimpan video');
                @chmod(APP_ROOT . '/' . $rel, 0644);
                $r = ['path' => $rel, 'path2x' => null, 'mime' => 'video/mp4', 'bytes' => $size, 'w' => null, 'h' => null, 'duration' => round($info['duration'], 2), 'encoder' => 'none'];
                $warnings[] = 'Video tidak di-transcode (v1); pastikan H.264 tanpa audio. Wajib poster untuk mode lite.';
                break;
            case 'svg':
                if ($magic !== 'image/svg+xml') throw ApiError::validation(['file' => 'type_svg']);
                [$clean, $rep] = SvgSanitizer::sanitize((string)file_get_contents($tmp));
                $rel = self::FOLDERS['svg'] . '/' . substr(hash('sha256', $clean), 0, 16) . '.svg';
                Util::atomicWrite(APP_ROOT . '/' . $rel, $clean);
                $r = ['path' => $rel, 'path2x' => null, 'mime' => 'image/svg+xml', 'bytes' => strlen($clean), 'w' => null, 'h' => null, 'duration' => null, 'encoder' => 'sanitizer', 'report' => $rep];
                break;
        }
        $meta = ['encoder' => $r['encoder'], 'warnings' => $warnings, 'originalMime' => $finfo, 'originalBytes' => $size];
        if (isset($r['report'])) { $rep = $r['report']; unset($rep['ids']); $meta['sanitize'] = $rep; }
        $id = Db::insert('media', ['kind' => $kind, 'path' => $r['path'], 'path_2x' => $r['path2x'], 'mime' => $r['mime'], 'bytes' => $r['bytes'],
            'width' => $r['w'], 'height' => $r['h'], 'duration_sec' => $r['duration'], 'sha256' => $sha, 'original_name' => $orig,
            'alt_text' => isset($opts['alt']) ? mb_substr((string)$opts['alt'], 0, 190) : null, 'meta' => Util::jsonEncode($meta), 'created_by' => Auth::id()]);
        $m = Db::one('SELECT * FROM media WHERE id=?', [$id]);
        Audit::log('upload', 'media', (string)$id, "$kind $orig → {$r['path']} ({$r['encoder']})", null, ['path' => $r['path'], 'encoder' => $r['encoder'], 'bytes' => $r['bytes']]);
        return self::dto($m);
    }

    // ---------------------------------------------------------------- raster
    private static function cwebp(): ?string
    {
        $p = (string)(Settings::get('media.cwebpPath') ?: Config::get('cwebp'));
        return ($p !== '' && is_file($p) && is_executable($p)) ? $p : null;
    }

    private static function decode(string $path, string $mime, array &$warnings)
    {
        if ($mime === 'image/png') return @imagecreatefrompng($path);
        if ($mime === 'image/jpeg') {
            $im = @imagecreatefromjpeg($path);
            if ($im && function_exists('exif_read_data')) {
                $ex = @exif_read_data($path);
                $o = (int)($ex['Orientation'] ?? 1);
                if ($o === 3) $im = imagerotate($im, 180, 0); elseif ($o === 6) $im = imagerotate($im, -90, 0); elseif ($o === 8) $im = imagerotate($im, 90, 0);
            }
            return $im;
        }
        if ($mime === 'image/webp') {
            if (function_exists('imagecreatefromwebp')) return @imagecreatefromwebp($path);
            $dw = self::cwebp() ? dirname(self::cwebp()) . '/dwebp' : null;
            if ($dw && is_executable($dw)) {
                $png = Util::tmpFile('.png');
                exec(escapeshellarg($dw) . ' ' . escapeshellarg($path) . ' -o ' . escapeshellarg($png) . ' 2>&1', $o, $rc);
                $im = $rc === 0 ? @imagecreatefrompng($png) : false;
                @unlink($png);
                if ($im) { $warnings[] = 'WebP didekode lewat dwebp (GD tanpa WebP)'; return $im; }
            }
            throw ApiError::validation(['file' => 'webp_decode_unavailable'], 'Server tidak bisa membaca WebP — unggah PNG/JPG');
        }
        return false;
    }

    private static function resize($im, int $maxSide)
    {
        $w = imagesx($im); $h = imagesy($im);
        $s = min(1.0, $maxSide / max($w, $h));
        $nw = max(1, (int)round($w * $s)); $nh = max(1, (int)round($h * $s));
        $out = imagecreatetruecolor($nw, $nh);
        imagealphablending($out, false); imagesavealpha($out, true);
        imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
        imagecopyresampled($out, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);
        return $out;
    }

    private static function hasAlpha($im): bool
    {
        $w = imagesx($im); $h = imagesy($im);
        $step = max(1, (int)floor(min($w, $h) / 40));
        for ($y = 0; $y < $h; $y += $step) for ($x = 0; $x < $w; $x += $step) if (((imagecolorat($im, $x, $y) >> 24) & 0x7F) > 0) return true;
        return false;
    }

    /** Encode satu ukuran. @return array{0:string,1:string,2:string} [bytes, ext, encoder] */
    private static function encode($im, bool $photo, int $quality, array &$warnings): array
    {
        if (function_exists('imagewebp')) {
            ob_start(); imagewebp($im, null, $quality); $b = (string)ob_get_clean();
            if ($b !== '') return [$b, 'webp', 'gd'];
        }
        if ($cw = self::cwebp()) {
            $png = Util::tmpFile('.png');
            $outp = $png . '.webp';
            imagepng($im, $png, 1);
            $cmd = escapeshellarg($cw) . ' -quiet -q ' . (int)$quality . ' -alpha_q 100 -metadata none ' . escapeshellarg($png) . ' -o ' . escapeshellarg($outp) . ' 2>&1';
            exec($cmd, $o, $rc);
            $b = ($rc === 0 && is_file($outp)) ? (string)file_get_contents($outp) : '';
            @unlink($png); @unlink($outp);
            if ($b !== '') return [$b, 'webp', 'cwebp'];
            $warnings[] = 'cwebp gagal (rc=' . $rc . ')';
        }
        if ($photo && !self::hasAlpha($im)) {
            $warnings[] = 'WebP tidak tersedia → fallback JPEG q82';
            ob_start(); imagejpeg($im, null, 82); return [(string)ob_get_clean(), 'jpg', 'jpeg-fallback'];
        }
        $warnings[] = 'WebP tidak tersedia → fallback PNG';
        ob_start(); imagepng($im, null, 9); return [(string)ob_get_clean(), 'png', 'png-fallback'];
    }

    private static function raster(string $tmp, string $mime, string $kind, string $sha, array &$warnings): array
    {
        $im = self::decode($tmp, $mime, $warnings);
        if (!$im) throw ApiError::validation(['file' => 'decode_failed'], 'Gambar rusak / tidak bisa dibaca');
        if (!imageistruecolor($im)) { $tc = imagecreatetruecolor(imagesx($im), imagesy($im)); imagealphablending($tc, false); imagesavealpha($tc, true);
            imagefill($tc, 0, 0, imagecolorallocatealpha($tc, 0, 0, 0, 127)); imagecopy($tc, $im, 0, 0, 0, 0, imagesx($im), imagesy($im)); $im = $tc; }
        imagealphablending($im, false); imagesavealpha($im, true);
        $W = imagesx($im); $H = imagesy($im);
        if ($W < 8 || $H < 8) throw ApiError::validation(['file' => 'too_small']);
        if ($W * $H > 40_000_000) throw ApiError::validation(['file' => 'too_many_pixels']);
        $folder = APP_ROOT . '/' . self::FOLDERS[$kind];
        Util::ensureDir($folder);
        $base = substr($sha, 0, 16);
        if ($kind === 'logo') {
            if (max($W, $H) < 600) $warnings[] = "Resolusi kecil ({$W}×{$H}); disarankan ≥ 600 px";
            $one = self::resize($im, 320);
            [$b1, $ext, $enc] = self::encode($one, false, 85, $warnings);
            $two = self::resize($im, 640);
            [$b2, $ext2] = self::encode($two, false, 85, $warnings);
            $p1 = self::FOLDERS[$kind] . "/$base.$ext"; $p2 = self::FOLDERS[$kind] . "/$base@2x.$ext2";
            Util::atomicWrite(APP_ROOT . '/' . $p1, $b1); Util::atomicWrite(APP_ROOT . '/' . $p2, $b2);
            return ['path' => $p1, 'path2x' => $p2, 'mime' => self::extMime($ext), 'bytes' => strlen($b1), 'w' => imagesx($one), 'h' => imagesy($one), 'duration' => null, 'encoder' => $enc];
        }
        $one = self::resize($im, 1920);
        [$b1, $ext, $enc] = self::encode($one, true, 82, $warnings);
        $p1 = self::FOLDERS[$kind] . "/$base.$ext";
        Util::atomicWrite(APP_ROOT . '/' . $p1, $b1);
        return ['path' => $p1, 'path2x' => null, 'mime' => self::extMime($ext), 'bytes' => strlen($b1), 'w' => imagesx($one), 'h' => imagesy($one), 'duration' => null, 'encoder' => $enc];
    }

    private static function extMime(string $ext): string { return ['webp' => 'image/webp', 'png' => 'image/png', 'jpg' => 'image/jpeg'][$ext]; }

    // ---------------------------------------------------------------- MP4
    /** Parser kecil: brand ftyp + durasi dari mvhd. */
    public static function mp4Info(string $path): array
    {
        $fh = fopen($path, 'rb');
        $size = filesize($path);
        $brandOk = false; $dur = null;
        $readBoxes = function (int $start, int $end) use (&$readBoxes, $fh, &$brandOk, &$dur) {
            $pos = $start;
            while ($pos + 8 <= $end) {
                fseek($fh, $pos);
                $hdr = fread($fh, 8);
                if (strlen($hdr) < 8) break;
                $len = unpack('N', substr($hdr, 0, 4))[1]; $type = substr($hdr, 4, 4); $hl = 8;
                if ($len === 1) { $ext = fread($fh, 8); $len = (unpack('N', substr($ext, 0, 4))[1] << 32) | unpack('N', substr($ext, 4, 4))[1]; $hl = 16; }
                elseif ($len === 0) $len = $end - $pos;
                if ($len < $hl) break;
                if ($type === 'ftyp') {
                    $d = fread($fh, min(64, $len - $hl));
                    foreach (str_split($d, 4) as $i => $b) if ($i !== 1 && in_array($b, ['isom', 'mp42', 'avc1', 'mp41', 'iso2', 'iso4', 'iso5', 'iso6', 'M4V ', 'dash'], true)) $brandOk = true;
                } elseif ($type === 'moov') {
                    $readBoxes($pos + $hl, $pos + $len);
                } elseif ($type === 'mvhd') {
                    $d = fread($fh, 32);
                    $ver = ord($d[0]);
                    if ($ver === 1) { $ts = unpack('N', substr($d, 20, 4))[1]; $du = (unpack('N', substr($d, 24, 4))[1] << 32) | unpack('N', substr($d, 28, 4))[1]; }
                    else { $ts = unpack('N', substr($d, 12, 4))[1]; $du = unpack('N', substr($d, 16, 4))[1]; }
                    if ($ts > 0) $dur = $du / $ts;
                }
                $pos += $len;
            }
        };
        $readBoxes(0, $size);
        fclose($fh);
        return ['brandOk' => $brandOk, 'duration' => $dur];
    }

    // ---------------------------------------------------------------- pemakaian
    /** Reverse reference: daftar pemakai media. */
    public static function usedBy(int $id): array
    {
        $u = [];
        foreach (Db::all('SELECT id, slug, name FROM brands WHERE logo_media_id=?', [$id]) as $r) $u[] = ['type' => 'brand', 'id' => $r['slug'], 'brandId' => (int)$r['id'], 'label' => $r['name']];
        foreach (Db::all('SELECT id FROM tenants WHERE logo_override_media_id=?', [$id]) as $r) $u[] = ['type' => 'tenant', 'id' => $r['id'], 'label' => $r['id']];
        foreach (Db::all('SELECT id, name_id FROM floors WHERE svg_media_id=?', [$id]) as $r) $u[] = ['type' => 'floor', 'id' => $r['id'], 'label' => $r['name_id']];
        foreach (Db::all('SELECT id, title_id FROM promos WHERE media_id=? OR poster_media_id=?', [$id, $id]) as $r) $u[] = ['type' => 'promo', 'id' => (string)$r['id'], 'label' => $r['title_id']];
        foreach (Db::all('SELECT id, title_id FROM events WHERE media_id=?', [$id]) as $r) $u[] = ['type' => 'event', 'id' => (string)$r['id'], 'label' => $r['title_id']];
        return $u;
    }
}
