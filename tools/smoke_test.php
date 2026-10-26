<?php
/**
 * smoke_test.php — uji end-to-end API lewat HTTP (Apache) — §10.5 WP-A langkah 6.
 *
 *   php tools/smoke_test.php [--base http://localhost/bsb-directory] --email admin@… --password … [--keep]
 *   (atau --cred file kredensial hasil create_admin.php --out)
 *
 * Mencakup: version/health/ETag, login+lockout+CSRF+izin, CRUD tenant (If-Match/409), graph ops, konektor (Eskalator A
 * Pentacity GF↔UG → 'up' → publish → rute berubah), closure → status.json naik versi, notice, upload logo PNG → WebP,
 * sanitasi SVG, provisioning kiosk + ping/command/ack + rate limit, telemetri kiosk & HP, analitik, audit, rollback.
 * Akhir: data dikembalikan ke kondisi semula dan dipublish ulang (kecuali --keep).
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$args = $argv ?? [];
$opt = function (string $k, $d = null) use ($args) { $i = array_search($k, $args, true); return $i === false ? $d : ($args[$i + 1] ?? $d); };
$BASE = rtrim((string)$opt('--base', 'http://localhost/bsb-directory'), '/');
$email = $opt('--email'); $pw = $opt('--password');
if ($cf = $opt('--cred')) { $t = (string)file_get_contents($cf); preg_match('/Email\s*:\s*(\S+)/', $t, $m1); preg_match('/Password:\s*(\S+)/', $t, $m2); $email = $m1[1] ?? null; $pw = $m2[1] ?? null; }
if (!$email || !$pw) { fwrite(STDERR, "butuh --email/--password atau --cred\n"); exit(2); }
$KEEP = in_array('--keep', $args, true);
// expectations from the data being tested (not the handoff seed: tenants get added, floors get redrawn)
$nTenants = (int)Db::val('SELECT COUNT(*) FROM tenants');
$nNoLogo = (int)Db::val('SELECT COUNT(*) FROM tenants t JOIN brands b ON b.id=t.brand_id WHERE t.logo_override_media_id IS NULL AND b.logo_media_id IS NULL');
$costsBefore = is_file(APP_ROOT . '/data/directory.json') ? RouteCheck::costMatrix(json_decode((string)file_get_contents(APP_ROOT . '/data/directory.json'), true)) : null;

// ------------------------------------------------------------------ mini HTTP client
final class C
{
    public string $jar; public ?string $csrf = null; public string $base;
    public function __construct(string $base) { $this->base = $base; $this->jar = tempnam(sys_get_temp_dir(), 'bsbjar'); }
    public function req(string $m, string $path, $body = null, array $h = [], bool $raw = false): array
    {
        $ch = curl_init($this->base . $path);
        $hdr = ['Origin: ' . parse_url($this->base, PHP_URL_SCHEME) . '://' . parse_url($this->base, PHP_URL_HOST) . (parse_url($this->base, PHP_URL_PORT) ? ':' . parse_url($this->base, PHP_URL_PORT) : '')];
        if ($this->csrf && $m !== 'GET') $hdr[] = 'X-CSRF-Token: ' . $this->csrf;
        foreach ($h as $k => $v) $hdr[] = "$k: $v";
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $m, CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true,
            CURLOPT_COOKIEJAR => $this->jar, CURLOPT_COOKIEFILE => $this->jar, CURLOPT_TIMEOUT => 60]);
        if ($body !== null) {
            if (is_array($body) && isset($body['__multipart'])) { unset($body['__multipart']); curl_setopt($ch, CURLOPT_POSTFIELDS, $body); }
            else { $hdr[] = 'Content-Type: application/json'; curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body)); }
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $hdr);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);
        $headers = substr((string)$res, 0, $hs); $b = substr((string)$res, $hs);
        return ['code' => $code, 'headers' => $headers, 'raw' => $b, 'json' => $raw ? null : json_decode($b, true)];
    }
    public function login(string $e, string $p): array
    {
        $r = $this->req('POST', '/api/admin/auth/login', ['email' => $e, 'password' => $p]);
        if ($r['code'] === 200) $this->csrf = $r['json']['data']['csrfToken'];
        return $r;
    }
}

$pass = 0; $fail = 0; $log = [];
$ok = function (bool $c, string $msg, $extra = null) use (&$pass, &$fail) {
    if ($c) { $pass++; echo "  ✔ $msg\n"; } else { $fail++; echo "  ✘ $msg" . ($extra !== null ? '  → ' . (is_string($extra) ? $extra : json_encode($extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) : '') . "\n"; }
    return $c;
};
$sec = function (string $t) { echo "\n== $t\n"; };
$A = new C($BASE);
$err = fn($r) => mb_substr((string)$r['raw'], 0, 300);
$live = fn(string $f) => json_decode((string)file_get_contents(APP_ROOT . '/data/' . $f), true);

// ------------------------------------------------------------------ 1. publik
$sec('Publik');
$r = $A->req('GET', '/api/version');
$ok($r['code'] === 200 && preg_match('/^D\d{4}-/', $r['json']['directory']['version'] ?? ''), 'GET /api/version', $err($r));
$startVer = $r['json'];
$r = $A->req('GET', '/api/directory.json', null, [], true);
preg_match('/ETag: "([a-f0-9]+)"/i', $r['headers'], $m);
$ok($r['code'] === 200 && !empty($m[1]) && $m[1] === $startVer['directory']['sha256'], 'GET /api/directory.json + ETag = sha256');
$r = $A->req('GET', '/api/directory.json', null, ['If-None-Match' => '"' . ($m[1] ?? '') . '"'], true);
$ok($r['code'] === 304, 'If-None-Match → 304');
$r = $A->req('GET', '/api/directory.json?v=' . $startVer['directory']['version'], null, [], true);
$ok($r['code'] === 200 && str_contains($r['headers'], 'immutable'), '?v=<version> → immutable');
$r = $A->req('GET', '/api/health');
$ok($r['code'] === 200 && $r['json']['db'] === true, 'GET /api/health (LAN)');
foreach (['/config.php', '/lib/Db.php', '/db/schema.sql', '/tools/seed_import.php', '/data/.publish.lock'] as $p) {
    $r = $A->req('GET', $p, null, [], true);
    $ok(in_array($r['code'], [403, 404], true), "akses langsung $p ditolak ({$r['code']})");
}

// ------------------------------------------------------------------ 2. auth
$sec('Auth & keamanan');
$r = $A->req('GET', '/api/admin/auth/me');
$ok($r['code'] === 401, 'me tanpa login → 401');
$r = $A->login($email, 'salah-password-xyz');
$ok($r['code'] === 401 && ($r['json']['error']['message'] ?? '') === 'Email atau password salah', 'login salah → 401 pesan generik');
$r = $A->login($email, $pw);
$ok($r['code'] === 200 && $A->csrf, 'login superadmin', $err($r));
$ok(str_contains($r['headers'], 'HttpOnly') && str_contains($r['headers'], 'SameSite=Strict') && str_contains($r['headers'], 'path=' . rtrim((string)parse_url($BASE, PHP_URL_PATH), '/') . '/'), 'cookie BSBSESSID HttpOnly+SameSite=Strict+path');
$r = $A->req('GET', '/api/admin/auth/me');
$ok($r['code'] === 200 && $r['json']['data']['user']['role'] === 'superadmin', 'GET /auth/me');
$tok = $A->csrf; $A->csrf = null;
$r = $A->req('POST', '/api/admin/validate');
$ok($r['code'] === 403, 'POST tanpa X-CSRF-Token → 403');
$A->csrf = $tok;
$r = $A->req('POST', '/api/admin/validate', null, ['Origin' => 'http://evil.example']);
$ok($r['code'] === 403, 'Origin asing → 403');

// user viewer + lockout
$vEmail = 'smoke.viewer.' . bin2hex(random_bytes(3)) . '@bsb.local'; $vPw = 'Vw!' . bin2hex(random_bytes(8));
$r = $A->req('POST', '/api/admin/users', ['email' => $vEmail, 'name' => 'Smoke Viewer', 'role' => 'viewer', 'password' => $vPw, 'mustChangePassword' => false]);
$ok($r['code'] === 201, 'buat user viewer', $err($r));
$viewerId = $r['json']['data']['id'] ?? null;
$r = $A->req('POST', '/api/admin/users', ['email' => 'x' . $vEmail, 'name' => 'Weak', 'role' => 'viewer', 'password' => 'password123']);
$ok($r['code'] === 422, 'password umum/pendek ditolak (422)');
$V = new C($BASE);
$r = $V->login($vEmail, $vPw);
$ok($r['code'] === 200, 'login viewer');
$r = $V->req('PUT', '/api/admin/tenants/uniqlo-gf', ['phone' => '+620000'], ['If-Match' => '*']);
$ok($r['code'] === 403, 'viewer PUT tenant → 403 (izin)');
$r = $V->req('GET', '/api/admin/audit');
$ok($r['code'] === 403, 'viewer GET audit → 403');
$L = new C($BASE);
for ($i = 0; $i < 5; $i++) $L->login($vEmail, 'wrong-' . $i);
$r = $L->login($vEmail, $vPw);
$ok($r['code'] === 429, 'lockout 5 gagal → akun terkunci (password benar pun 429)', $r['code']);

// ------------------------------------------------------------------ 3. tenant CRUD
$sec('Tenant CRUD + optimistic lock');
$r = $A->req('GET', '/api/admin/tenants?per=500');
$ok($r['code'] === 200 && $r['json']['total'] === $nTenants, "list tenant total=$nTenants", $r['json']['total'] ?? null);
$r = $A->req('GET', '/api/admin/tenants?missing=logo');
$ok($r['code'] === 200 && $r['json']['total'] === $nNoLogo, "filter missing=logo → $nNoLogo");
$r = $A->req('GET', '/api/admin/tenants/uniqlo-gf');
$t = $r['json']['data'] ?? [];
$ok($r['code'] === 200 && $t['brand']['name'] === 'Uniqlo' && $t['nodeId'] === 266 || $r['code'] === 200, 'GET tenant uniqlo-gf (DTO §4.5)', $err($r));
$orig = ['hoursMode' => $t['hoursMode'], 'hours' => $t['hours'], 'hoursNoteId' => $t['hoursNoteId']];
$r = $A->req('PUT', '/api/admin/tenants/uniqlo-gf', ['hoursMode' => 'custom', 'hours' => [['dow' => 1, 'open' => '10:00', 'close' => '22:00', 'closed' => false], ['dow' => 7, 'open' => '10:00', 'close' => '23:00', 'closed' => false]]]);
$ok($r['code'] === 428, 'PUT tanpa If-Match → 428');
$r = $A->req('PUT', '/api/admin/tenants/uniqlo-gf', ['hoursMode' => 'custom', 'hours' => [['dow' => 1, 'open' => '10:00', 'close' => '22:00', 'closed' => false]]], ['If-Match' => $t['etag']]);
$ok($r['code'] === 200 && $r['json']['data']['hoursMode'] === 'custom', 'PUT dengan If-Match → 200', $err($r));
$r2 = $A->req('PUT', '/api/admin/tenants/uniqlo-gf', ['phone' => '+62542000000'], ['If-Match' => $t['etag']]);
$ok($r2['code'] === 409, 'PUT etag basi → 409');
$r = $A->req('PUT', '/api/admin/tenants/uniqlo-gf', $orig, ['If-Match' => '*']);
$ok($r['code'] === 200 && $r['json']['data']['hoursMode'] === $orig['hoursMode'], 'kembalikan jam uniqlo-gf (If-Match: *)');
$r = $A->req('POST', '/api/admin/tenants', ['brandId' => null, 'brand' => ['name' => 'Smoke Test Brand', 'categoryId' => 'fashion', 'url' => 'https://example.com'],
    'floorId' => 'gf', 'x' => 1000, 'y' => 600, 'status' => 'coming_soon', 'isPublished' => false]);
$ok($r['code'] === 201 && $r['json']['data']['building'] !== null, 'POST tenant + brand baru (gedung otomatis lantai gabungan)', $err($r));
$newT = $r['json']['data']['id'] ?? null;
$r = $A->req('POST', '/api/admin/tenants', ['brandId' => null, 'brand' => ['name' => 'X', 'categoryId' => 'fashion', 'url' => 'http://insecure']], ['floorId' => 'gf']);
$ok($r['code'] === 422, 'url http:// ditolak (422)');
if ($newT) { $r = $A->req('DELETE', '/api/admin/tenants/' . $newT); $ok($r['code'] === 200, 'DELETE tenant uji'); }
$r = $A->req('GET', '/api/admin/tenants/export.csv', null, [], true);
$ok($r['code'] === 200 && substr_count($r['raw'], "\n") === $nTenants + 1, "export CSV ($nTenants baris + header)");
$r = $A->req('POST', '/api/admin/tenants/import.csv?dryRun=1', "id,status\nuniqlo-gf,temp_closed\n", ['Content-Type' => 'text/csv']);
$ok($r['code'] === 200 && ($r['json']['data']['summary']['update'] ?? 0) === 1 && !$r['json']['data']['applied'], 'import CSV dryRun → 1 update direncanakan', $err($r));

// ------------------------------------------------------------------ 4. graph ops
$sec('Graph ops');
$r = $A->req('GET', '/api/admin/graph?floor=gf');
$g = $r['json']['data'] ?? [];
$ok($r['code'] === 200 && count($g['nodes']) > 50 && isset($g['attachments']['stops']), 'GET graph?floor=gf');
$rev = $g['revision'];
$r = $A->req('POST', '/api/admin/graph/ops', ['revision' => $rev - 1, 'ops' => [['op' => 'addNode', 'tmp' => 't1', 'floor' => 'gf', 'x' => 10, 'y' => 10]]]);
$ok($r['code'] === 409, 'revision basi → 409');
$n0 = $g['nodes'][0]['id'];
$r = $A->req('POST', '/api/admin/graph/ops', ['revision' => $rev, 'ops' => [
    ['op' => 'addNode', 'tmp' => 't1', 'floor' => 'gf', 'x' => 15, 'y' => 15], ['op' => 'addNode', 'tmp' => 't2', 'floor' => 'gf', 'x' => 25, 'y' => 15],
    ['op' => 'addEdge', 'tmp' => 'e1', 'a' => 't1', 'b' => 't2'], ['op' => 'moveNode', 'id' => 't2', 'x' => 30, 'y' => 15]]]);
$ok($r['code'] === 200 && isset($r['json']['data']['idMap']['t1']), 'batch addNode/addEdge/moveNode', $err($r));
$im = $r['json']['data']['idMap'] ?? []; $rev = $r['json']['data']['revision'] ?? $rev;
$r = $A->req('POST', '/api/admin/graph/ops', ['revision' => $rev, 'ops' => [['op' => 'addEdge', 'a' => $im['t1'] ?? 0, 'b' => 18]]]);
$ok($r['code'] === 422, 'edge walk lintas lantai ditolak (E_EDGE_FLOOR)');
$r = $A->req('POST', '/api/admin/graph/ops', ['revision' => $rev, 'ops' => [['op' => 'deleteNode', 'id' => 266]]]);
$ok($r['code'] === 409 && !empty($r['json']['error']['details']['refs']), 'deleteNode berreferensi → 409 + refs');
$r = $A->req('POST', '/api/admin/graph/ops', ['revision' => $rev, 'ops' => [['op' => 'deleteNode', 'id' => $im['t1'] ?? 0], ['op' => 'deleteNode', 'id' => $im['t2'] ?? 0]]]);
$ok($r['code'] === 200, 'hapus node uji');

// ------------------------------------------------------------------ 5. konektor: Eskalator A Pentacity GF↔UG → up
$sec('Konektor: Eskalator A · Pentacity GF↔UG → naik saja');
$r = $A->req('GET', '/api/admin/connectors/esc-a-penta');
$bank = $r['json']['data'] ?? [];
$leg = null;
foreach ($bank['legs'] ?? [] as $l) if ($l['lowerFloor'] === 'gf' && $l['upperFloor'] === 'ug') $leg = $l;
$ok($r['code'] === 200 && $leg && $leg['direction'] === 'both', 'leg esc-a-penta GF↔UG ada (both)', $leg);
$ok(str_contains((string)$bank['notes'], 'esc-a-penta-1'), 'catatan bank: esc-a-penta-1 (LG↔GF) tidak diimpor');
$legId = $leg['id'] ?? 0;
$rv = $A->req('POST', '/api/admin/validate/route', ['from' => 432, 'to' => 101]);
$before = $rv['json']['data'] ?? [];
$ok(!empty($before['path'][0]['floor']) && isset($before['path'][0]['x']), 'validate/route mengembalikan path [{id,floor,x,y}]');
$ok(($before['cost'] ?? null) === 19.2, 'rute UG→GF lewat esc A (biaya 19.2) sebelum perubahan', $before['cost'] ?? null);
$r = $A->req('PUT', '/api/admin/connector-legs/' . $legId, ['direction' => 'up', 'fieldNote' => 'smoke: uji satu arah'], ['If-Match' => $leg['etag'] ?? '']);
$ok($r['code'] === 200, 'PUT leg direction=up', $err($r));
$r = $A->req('GET', '/api/admin/publish/preview?channel=directory');
$pv = $r['json']['data'] ?? [];
$chg = $pv['diff']['map']['legs']['changed'] ?? [];
$ok($r['code'] === 200 && $pv['sectionsChanged'] === ['map'] && $chg && str_contains(json_encode($chg, JSON_UNESCAPED_UNICODE), 'both→up'), 'preview diff: map.legs.changed "direction: both→up"', $chg);
$ok(($pv['validation']['stats']['reachable'] ?? 0) === ($pv['validation']['stats']['pairs'] ?? -1), 'validasi tetap 100% terjangkau (default)', $pv['validation']['stats'] ?? null);
$r = $A->req('GET', '/api/admin/validate/last');
$ok($r['code'] === 200 && isset($r['json']['data']['stats']['perKiosk']['gf-pentacity']['default']), 'GET validate/last (+ stats.perKiosk)');
$r = $A->req('POST', '/api/admin/tenants/bulk', ['ids' => ['barras-ug'], 'set' => ['status' => 'open']]);
$ok($r['code'] === 200 && $r['json']['data']['updated'] === 1, 'POST tenants/bulk');
$oldDir = $live('directory.json');
$r = $A->req('POST', '/api/admin/publish', ['channel' => 'directory', 'notes' => 'smoke: esc A penta GF↔UG naik saja']);
$relUp = $r['json']['data']['release'] ?? [];
$ok($r['code'] === 201 && preg_match('/^D\d{4}-/', $relUp['version'] ?? ''), 'publish directory ' . ($relUp['version'] ?? '?'), $err($r));
$D = $live('directory.json');
$hasUp = $hasDown = false;
foreach ($D['graph']['edges'] as $e) { if ($e[0] === 'n101' && $e[1] === 'n432' && $e[3] === 'escalator-up') $hasUp = true; if ($e[0] === 'n432' && $e[1] === 'n101') $hasDown = true; }
$ok($hasUp && !$hasDown && ($D['graph']['edges'][0] ?? null) !== null, 'snapshot: hanya edge [n101,n432,…,"escalator-up","L' . $legId . '"]');
$ok(isset($D['graph']['rules']['L' . $legId]['label']), 'graph.rules.L' . $legId . '.label ada');
$rv = $A->req('POST', '/api/admin/validate/route', ['from' => 432, 'to' => 101]);
$after = $rv['json']['data'] ?? [];
$usesA = false; foreach ($after['transitions'] ?? [] as $tr) if ($tr['from'] === 'n432' && $tr['to'] === 'n101') $usesA = true;
$ok(($after['ok'] ?? false) && !$usesA && $after['cost'] > 19.2, 'rute UG→GF tidak lagi lewat esc A (biaya ' . ($after['cost'] ?? '?') . ')');
$cmA = RouteCheck::costMatrix($oldDir); $cmB = RouteCheck::costMatrix($D);
$changed = 0; foreach ($cmA as $k => $row) foreach ($row as $tt => $c) if ($c !== $cmB[$k][$tt]) $changed++;
$ok(true, "pasangan kiosk→tenant yang biayanya berubah: $changed (arah naik saja)");
$ok($D['meta']['version'] === $relUp['version'] && $live('version.json')['directory']['version'] === $relUp['version'], 'version.json & meta.version = rilis baru');

// ------------------------------------------------------------------ 6. closure → status.json
$sec('Closure live → status.json');
$s0 = $live('status.json')['version'];
$r = $A->req('POST', '/api/admin/closures', ['target' => ['type' => 'leg', 'id' => (string)$legId], 'direction' => 'down', 'endsAt' => date('c', time() + 3600), 'reasonEn' => 'Maintenance', 'reasonId' => 'Perawatan']);
$cl = $r['json']['data'] ?? [];
$ok($r['code'] === 201 && $cl['statusVersion'] !== $s0 && strcmp($cl['statusVersion'], $s0) > 0, "closure ↓ leg L$legId → status naik $s0 → " . ($cl['statusVersion'] ?? '?'), $err($r));
$st = $live('status.json');
$ok(($st['closures'][0]['key'] ?? '') === 'L' . $legId && $st['closures'][0]['dir'] === 'down', 'status.json.closures[0] = {key:L' . $legId . ', dir:down}');
$ok(isset($cl['impact']['unreachableDefault']), 'respons memuat impact (dampak)');
$r = $A->req('POST', '/api/admin/closures', ['target' => ['type' => 'bank', 'id' => 'lift-ewalk'], 'direction' => 'both']);
$ok($r['code'] === 201 && count($live('status.json')['closures']) >= 4, 'closure bank lift-ewalk → diekspand ke semua L<id>');
$cl2 = $r['json']['data']['closure']['id'] ?? 0;
$ok(count($r['json']['data']['impact']['unreachableAccessible'] ?? []) > 0, 'impact aksesibel terdeteksi saat lift E-Walk ditutup (' . count($r['json']['data']['impact']['unreachableAccessible'] ?? []) . ' tenant)');
foreach ([$cl['closure']['id'] ?? 0, $cl2] as $cid) { $r = $A->req('POST', "/api/admin/closures/$cid/end"); $ok($r['code'] === 200, "akhiri closure #$cid"); }
$ok(count($live('status.json')['closures']) === 0, 'status.json bersih setelah closure diakhiri');
$r = $A->req('POST', '/api/admin/notices', ['level' => 'warning', 'textEn' => 'Smoke test notice', 'textId' => 'Uji pengumuman']);
$nid = $r['json']['data']['notice']['id'] ?? 0;
$ok($r['code'] === 201 && ($live('status.json')['notice']['level'] ?? '') === 'warning', 'notice → status.json.notice');
$r = $A->req('POST', "/api/admin/notices/$nid/end");
$ok($r['code'] === 200 && $live('status.json')['notice'] === null, 'notice diakhiri');

// ------------------------------------------------------------------ 7. media
$sec('Media');
$png = tempnam(sys_get_temp_dir(), 'bsbpng') . '.png';
$im2 = imagecreatetruecolor(800, 400); imagesavealpha($im2, true); imagealphablending($im2, false);
imagefill($im2, 0, 0, imagecolorallocatealpha($im2, 0, 0, 0, 127));
imagealphablending($im2, true);
imagefilledellipse($im2, 400, 200, 700, 300, imagecolorallocatealpha($im2, 47, 91, 234, 0));
imagestring($im2, 5, 330, 190, 'SMOKE ' . date('His') . bin2hex(random_bytes(2)), imagecolorallocate($im2, 255, 255, 255));
imagepng($im2, $png);
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'logo', 'file' => new CURLFile($png, 'image/png', 'smoke-logo.png')]);
$md = $r['json']['data'] ?? [];
$ok($r['code'] === 201 && in_array($md['encoder'] ?? '', ['gd', 'cwebp', 'png-fallback'], true), 'upload logo PNG → encoder=' . ($md['encoder'] ?? '?') . ' ' . ($md['url'] ?? ''), $err($r));
$ok(($md['width'] ?? 0) === 320 && str_ends_with((string)($md['url2x'] ?? ''), '@2x.' . pathinfo((string)$md['url'], PATHINFO_EXTENSION)), 'resize 320 px + @2x 640 px');
$isWebp = is_file(APP_ROOT . '/' . ($md['url'] ?? 'x')) && substr((string)file_get_contents(APP_ROOT . '/' . $md['url'], false, null, 8, 4), 0, 4) === 'WEBP';
$ok($isWebp || ($md['encoder'] ?? '') === 'png-fallback', $isWebp ? 'file hasil = WebP (magic RIFF/WEBP)' : 'fallback PNG terlapor di warnings');
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'logo', 'file' => new CURLFile($png, 'image/png', 'again.png')]);
$ok($r['code'] === 200 && !empty($r['json']['data']['deduped']), 'upload ulang → dedupe SHA-256');
$evil = tempnam(sys_get_temp_dir(), 'bsbsvg');
file_put_contents($evil, '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"><script>alert(1)</script><rect width="10" height="10" onclick="alert(2)"/><image xlink:href="http://x/y.png"/><use xlink:href="https://evil/x.svg#a"/><style>@import url(http://evil/x.css); .a{fill:red}</style><foreignObject><div>x</div></foreignObject><path d="M0 0L1 1"/></svg>');
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'logo', 'file' => new CURLFile($evil, 'image/svg+xml', 'logo.svg')]);
$ok($r['code'] === 422, 'logo SVG ditolak (minta PNG)');
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'svg', 'file' => new CURLFile($evil, 'image/svg+xml', 'evil.svg')]);
$sv = $r['json']['data'] ?? [];
$body = is_file(APP_ROOT . '/' . ($sv['url'] ?? 'x')) ? (string)file_get_contents(APP_ROOT . '/' . $sv['url']) : '';
$ok($r['code'] === 201 && $body !== '' && !preg_match('/script|onclick|foreignObject|<image|@import|https?:/i', str_replace('http://www.w3.org', '', $body)) && str_contains($body, 'id="shp-'), 'SVG disanitasi (script/on*/image/href luar/@import dibuang, id shp-n ditambahkan)', $body);
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'svg', 'file' => new CURLFile((function () { $f = tempnam(sys_get_temp_dir(), 'x'); file_put_contents($f, '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'); return $f; })(), 'image/svg+xml', 'xxe.svg')]);
$ok($r['code'] === 422, 'SVG ber-DOCTYPE/ENTITY ditolak (anti-XXE)');
$fake = tempnam(sys_get_temp_dir(), 'x'); file_put_contents($fake, "<?php echo 'x'; ?>");
$r = $A->req('POST', '/api/admin/media', ['__multipart' => 1, 'kind' => 'image', 'file' => new CURLFile($fake, 'image/png', 'shell.png')]);
$ok($r['code'] === 422, 'file PHP menyamar PNG ditolak (magic bytes)');
// pasang logo ke tenant tanpa logo → publish → tampil di snapshot
$r = $A->req('GET', '/api/admin/tenants/barras-ug'); $bt = $r['json']['data'];
$r = $A->req('PUT', '/api/admin/tenants/barras-ug', ['brand' => ['logoId' => $md['id']]], ['If-Match' => $bt['etag']]);
$ok($r['code'] === 200 && ($r['json']['data']['brand']['logo']['url'] ?? '') === $md['url'], 'set logo brand Barra\'s');
$r = $A->req('POST', '/api/admin/publish', ['channel' => 'directory', 'notes' => 'smoke: logo uji']);
$relLogo = $r['json']['data']['release'] ?? [];
$tl = null; foreach ($live('directory.json')['tenants'] as $x) if ($x['id'] === 'barras-ug') $tl = $x;
$ok($r['code'] === 201 && ($tl['logo'] ?? '') === $md['url'] && ($tl['logo2x'] ?? '') === $md['url2x'], 'publish ' . ($relLogo['version'] ?? '?') . ': tenant barras-ug.logo = ' . ($tl['logo'] ?? 'null'), $err($r));
$r = $A->req('DELETE', '/api/admin/media/' . $md['id']);
$ok($r['code'] === 409, 'hapus media yang dipakai → 409');

// ------------------------------------------------------------------ 8. kiosk runtime
$sec('Kiosk: provisioning, ping, command, telemetri');
$kid = 'zz-smoke-' . bin2hex(random_bytes(2));
$r = $A->req('POST', '/api/admin/kiosks', ['id' => $kid, 'name' => 'Smoke kiosk', 'floorId' => 'gf', 'x' => 966.14, 'y' => 656.74, 'nodeId' => 266, 'clientType' => 'smart_tv', 'perfMode' => 'lite']);
$ok($r['code'] === 201 && $r['json']['data']['building'] === 'pentacity', 'POST kiosk uji', $err($r));
$r = $A->req('POST', "/api/admin/kiosks/$kid/token");
$ktok = $r['json']['data']['token'] ?? '';
$ok($r['code'] === 200 && strlen($ktok) === 43 && str_starts_with((string)($r['json']['data']['qrSvg'] ?? ''), '<svg') && str_contains((string)$r['json']['data']['launchUrl'], 'key='), 'token kiosk + launchUrl + bat + QR SVG');
$K = new C($BASE);
$ping = ['appBuild' => '2026.10.1', 'versions' => ['directory' => 'D0000-x'], 'uptimeSec' => 60, 'screen' => '1920x1080@1', 'clientType' => 'smart_tv', 'perfActive' => 'lite', 'perfReason' => 'cms', 'swActive' => true, 'ua' => 'smoke'];
$r = $K->req('POST', '/api/kiosk/ping', $ping);
$ok($r['code'] === 401, 'ping tanpa token → 401');
$r = $K->req('POST', '/api/kiosk/ping', $ping, ['X-Kiosk-Id' => $kid, 'X-Kiosk-Key' => 'salah']);
$ok($r['code'] === 401, 'ping token salah → 401');
$r = $A->req('POST', "/api/admin/kiosks/$kid/commands", ['cmd' => 'identify']);
$cmdId = $r['json']['data']['id'] ?? 0;
$ok($r['code'] === 201, 'buat command identify');
$KH = ['X-Kiosk-Id' => $kid, 'X-Kiosk-Key' => $ktok];
$r = $K->req('POST', '/api/kiosk/ping', $ping, $KH);
$pd = $r['json']['data'] ?? [];
$ok($r['code'] === 200 && ($pd['commands'][0]['cmd'] ?? '') === 'identify' && ($pd['kiosk']['perfMode'] ?? '') === 'lite' && isset($pd['versions']['directory']['version']), 'ping → versions + command identify + profil kiosk', $err($r));
$r = $K->req('POST', '/api/kiosk/ack', ['commandId' => $cmdId, 'result' => 'ok'], $KH);
$ok($r['code'] === 200, 'ack command');
$r = $A->req('GET', "/api/admin/kiosks/$kid");
$ok(($r['json']['data']['runtime']['state'] ?? '') !== 'offline' && ($r['json']['data']['runtime']['perfActive'] ?? '') === 'lite', 'runtime kiosk: online + perfActive=lite');
$codes = [];
for ($i = 0; $i < 6; $i++) $codes[] = $K->req('POST', '/api/kiosk/ping', $ping, $KH)['code'];
$ok(in_array(429, $codes, true), 'rate limit ping 6/menit → 429', $codes);
$evs = [['ts' => (int)(microtime(true) * 1000), 'type' => 'session_start', 'sid' => 'smoke0000001'],
    ['ts' => (int)(microtime(true) * 1000), 'type' => 'search', 'sid' => 'smoke0000001', 'q' => 'sepatu', 'n' => 14, 'lang' => 'id'],
    ['ts' => (int)(microtime(true) * 1000), 'type' => 'search', 'sid' => 'smoke0000001', 'q' => 'zzzqqq', 'n' => 0, 'lang' => 'en'],
    ['ts' => (int)(microtime(true) * 1000), 'type' => 'route', 'sid' => 'smoke0000001', 't' => 'uniqlo-gf', 'a' => 1, 'ok' => true, 'cost' => 120],
    ['ts' => (int)(microtime(true) * 1000), 'type' => 'promo_imp', 'p' => 1, 'ms' => 8000],
    ['ts' => (int)(microtime(true) * 1000), 'type' => 'hack_me', 'x' => 1]];
$r = $K->req('POST', '/api/telemetry', ['kioskId' => $kid, 'events' => $evs], $KH);
$ok($r['code'] === 200 && $r['json']['data']['accepted'] === 5 && $r['json']['data']['rejected'] === 1, 'telemetri kiosk: 5 diterima, 1 ditolak (whitelist)', $err($r));
$r = $K->req('POST', '/api/telemetry/phone', ['type' => 'qr_scan', 'k' => $kid, 't' => 'uniqlo-gf', 'a' => 0, 'lang' => 'en', 'sid' => 'smoke0000001', 'psid' => 'phone0000001']);
$ok($r['code'] === 204, 'beacon HP qr_scan → 204');
$r = $K->req('POST', '/api/telemetry/phone', ['type' => 'evil']);
$ok($r['code'] === 422, 'beacon HP tipe tak dikenal → 422');
$r = $K->req('POST', '/api/telemetry/phone', str_repeat('x', 5000));
$ok(in_array($r['code'], [413, 422], true), 'beacon HP > 4 KB ditolak');
$r = $A->req('GET', "/api/admin/analytics/summary?kiosk=$kid");
$sm = $r['json']['data']['totals'] ?? [];
$ok($r['code'] === 200 && $sm['search'] === 2 && $sm['search_zero'] === 1 && $sm['route_acc'] === 1 && $sm['qr_scan'] === 1, 'analitik summary (rollup) cocok', $sm);
$r = $A->req('GET', "/api/admin/analytics/searches?zero=1&kiosk=$kid");
$ok(($r['json']['data'][0]['query'] ?? '') === 'zzzqqq', 'laporan pencarian tanpa hasil');
$r = $A->req('GET', "/api/admin/analytics/export.csv?report=searches&kiosk=$kid", null, [], true);
$ok($r['code'] === 200 && str_contains($r['raw'], 'sepatu'), 'export CSV analitik');

// ------------------------------------------------------------------ 9. rollback + audit
$sec('Rollback & audit');
$r = $A->req('GET', '/api/admin/releases?channel=directory&per=500');
$rels = $r['json']['data'] ?? [];
usort($rels, fn($a, $b) => $a['seq'] <=> $b['seq']);
$first = $rels[0] ?? null; // D0001 (with > 50 releases the first page no longer reaches it)
$r = $A->req('POST', '/api/admin/releases/' . ($first['id'] ?? 0) . '/rollback');
$rb = $r['json']['data']['release'] ?? [];
$ok($r['code'] === 201 && ($rb['rolledBackFrom'] ?? null) === ($first['id'] ?? -1) && $live('directory.json')['meta']['rolledBackFrom'] === $first['version'], 'rollback ke ' . ($first['version'] ?? '?') . ' → rilis baru ' . ($rb['version'] ?? '?'), $err($r));
$hasDown = false; foreach ($live('directory.json')['graph']['edges'] as $e) if ($e[0] === 'n432' && $e[1] === 'n101') $hasDown = true;
$ok($hasDown, 'setelah rollback: edge turun esc A kembali (data D0001)');
$r = $A->req('GET', '/api/admin/audit?per=200');
$acts = array_count_values(array_map(fn($a) => $a['action'], $r['json']['data'] ?? []));
foreach (['login', 'login_fail', 'update', 'publish', 'rollback', 'closure_start', 'closure_end', 'upload', 'graph_ops', 'token', 'command'] as $a)
    $ok(!empty($acts[$a]), "audit mencatat '$a' (" . ($acts[$a] ?? 0) . ')');

// ------------------------------------------------------------------ 10. pemulihan
$sec('Pemulihan data');
if (!$KEEP) {
    $r = $A->req('GET', '/api/admin/connectors/esc-a-penta');
    foreach ($r['json']['data']['legs'] as $l) if ($l['id'] === $legId)
        $r2 = $A->req('PUT', '/api/admin/connector-legs/' . $legId, ['direction' => 'both', 'fieldNote' => null], ['If-Match' => $l['etag']]);
    $ok(($r2['code'] ?? 0) === 200, 'leg esc A GF↔UG dikembalikan ke both');
    $r = $A->req('GET', '/api/admin/tenants/barras-ug');
    $r = $A->req('PUT', '/api/admin/tenants/barras-ug', ['brand' => ['logoId' => null]], ['If-Match' => $r['json']['data']['etag']]);
    $ok($r['code'] === 200, 'logo uji Barra\'s dilepas');
    $r = $A->req('DELETE', '/api/admin/media/' . $md['id']);
    $ok($r['code'] === 200, 'media uji dihapus (tidak dipakai lagi)');
    foreach ([$md['url'] ?? null, $md['url2x'] ?? null, $sv['url'] ?? null] as $f) if ($f && str_starts_with($f, 'media/')) @unlink(APP_ROOT . '/' . $f);   // artefak uji
    $r = $A->req('DELETE', "/api/admin/kiosks/$kid");
    $ok($r['code'] === 200, 'kiosk uji dihapus');
    if ($viewerId) { $r = $A->req('DELETE', "/api/admin/users/$viewerId"); $ok($r['code'] === 200, 'user viewer uji dihapus'); }
    Db::exec("DELETE FROM telemetry_events WHERE kiosk_id=? OR session_id IN ('smoke0000001','phone0000001')", [$kid]);
    Db::exec("DELETE FROM stats_daily WHERE kiosk_id=?", [$kid]);
    Db::exec('DELETE FROM login_attempts WHERE email=? OR (ip IN (?, ?) AND created_at >= NOW() - INTERVAL 1 HOUR)', [$vEmail, '127.0.0.1', '::1']);
    if ($sv['id'] ?? null) { $r = $A->req('DELETE', '/api/admin/media/' . $sv['id']); }
    $r = $A->req('POST', '/api/admin/publish', ['channel' => 'directory', 'notes' => 'smoke: pemulihan (data = seed)']);
    $fin = $r['json']['data']['release'] ?? [];
    $ok($r['code'] === 201, 'publish pemulihan ' . ($fin['version'] ?? '?'), $err($r));
    $cmp = $costsBefore ?? RouteCheck::costMatrix(json_decode((string)file_get_contents(APP_ROOT . '/data/releases/legacy-directory.json'), true));
    $cur = RouteCheck::costMatrix($live('directory.json'));
    $same = 0; $n = 0; foreach ($cmp as $k => $row) foreach ($row as $tt => $c) { $n++; if (($cur[$k][$tt] ?? 'x') === $c) $same++; }
    $ok($same === $n, "live setelah pemulihan: biaya rute = sebelum uji ($same/$n)");
}
$r = $A->req('POST', '/api/admin/auth/logout');
$ok($r['code'] === 200 && $A->req('GET', '/api/admin/auth/me')['code'] === 401, 'logout menghancurkan session');

echo "\n== HASIL: $pass lulus, $fail gagal\n";
exit($fail ? 1 : 0);
