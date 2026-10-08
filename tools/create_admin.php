<?php
/**
 * create_admin.php — buat superadmin pertama (§2.1).
 *   php tools/create_admin.php email "Nama" [--role superadmin] [--password <pw>] [--out file]
 * Tanpa --password: dibuat password acak kuat (24 char) dan dicetak sekali (atau ditulis ke --out, chmod 600).
 */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$a = $argv ?? [];
$opt = function (string $k) use ($a) { $i = array_search($k, $a, true); return $i === false ? null : ($a[$i + 1] ?? null); };
$pos = array_values(array_filter(array_slice($a, 1), function ($x) use ($a) {
    static $skip = false; if ($skip) { $skip = false; return false; } if (str_starts_with($x, '--')) { $skip = true; return false; } return true; }));
[$email, $name] = [$pos[0] ?? null, $pos[1] ?? null];
if (!$email || !$name || !filter_var($email, FILTER_VALIDATE_EMAIL)) { fwrite(STDERR, "Pakai: php tools/create_admin.php email \"Nama\" [--role superadmin] [--password pw] [--out file]\n"); exit(2); }
$role = $opt('--role') ?? 'superadmin';
if (!isset(Permissions::ROLES[$role])) { fwrite(STDERR, "role tidak dikenal: $role\n"); exit(2); }
$pw = $opt('--password');
if ($pw === null) {
    $alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
    do { $pw = ''; for ($i = 0; $i < 24; $i++) $pw .= $alpha[random_int(0, strlen($alpha) - 1)]; }
    while (!preg_match('/[A-Z]/', $pw) || !preg_match('/[a-z]/', $pw) || !preg_match('/\d/', $pw) || !preg_match('/[^A-Za-z0-9]/', $pw));
}
if ($e = Auth::checkPolicy($pw, $email)) { fwrite(STDERR, "password ditolak: $e\n"); exit(2); }
$email = strtolower($email);
$exists = Db::one('SELECT id FROM users WHERE email=?', [$email]);
if ($exists) {
    Db::update('users', ['password_hash' => Auth::hash($pw), 'role' => $role, 'is_active' => 1, 'failed_count' => 0, 'locked_until' => null, 'password_changed_at' => Util::now()], ['id' => $exists['id']]);
    $id = (int)$exists['id'];
    Audit::log('password_reset', 'user', (string)$id, 'reset via CLI create_admin', null, null, null);
} else {
    $id = Db::insert('users', ['email' => $email, 'name' => $name, 'role' => $role, 'password_hash' => Auth::hash($pw), 'is_active' => 1,
        'must_change_password' => 0, 'password_changed_at' => Util::now()]);
    Audit::log('create', 'user', (string)$id, "user $role dibuat via CLI", null, ['email' => $email, 'role' => $role], null);
}
$txt = "BSB Directory CMS — kredensial admin dev\nURL CMS : http://localhost/bsb-directory/cms/\nAPI     : http://localhost/bsb-directory/api/admin/auth/login\nEmail   : $email\nPassword: $pw\nRole    : $role\nDibuat  : " . date('c') . "\n";
if ($out = $opt('--out')) { file_put_contents($out, $txt); chmod($out, 0600); echo "user #$id ($role) siap; kredensial ditulis ke $out\n"; }
else echo $txt;
