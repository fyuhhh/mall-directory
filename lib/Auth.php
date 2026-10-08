<?php
declare(strict_types=1);

/** Auth admin berbasis session PHP (§2.1, §4.2, §8.1). */
final class Auth
{
    public const IDLE_SEC = 1800;        // 30 menit
    public const ABS_SEC = 43200;        // 12 jam
    public const ACCOUNT_MAX = 5;        // gagal / 15 menit per akun
    public const IP_MAX = 20;            // gagal / 15 menit per IP
    public const WINDOW = 900;
    public const COMMON = ['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345',
        'iloveyou12', 'admin12345', 'administrator', 'welcome123', 'passw0rd123', 'abc1234567', '1q2w3e4r5t', 'letmein123',
        'balikpapan', 'pentacity1', 'superblock', 'ewalk12345', 'changeme123'];

    private static ?array $user = null;
    private static bool $started = false;

    public static function startSession(): void
    {
        if (self::$started || PHP_SAPI === 'cli' && empty($GLOBALS['__BSB_TEST_SESSION'])) { self::$started = true; return; }
        if (session_status() === PHP_SESSION_ACTIVE) { self::$started = true; return; }
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' && Config::get('trustProxy'));
        $secure = Config::get('cookieSecure');
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.gc_maxlifetime', (string)self::ABS_SEC);
        session_name('BSBSESSID');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => (Util::appBasePath() ?: '') . '/',
            'secure' => $secure === null ? $https : (bool)$secure,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
        self::$started = true;
    }

    /** User aktif dari session (dengan cek idle/absolut). */
    public static function user(): ?array
    {
        if (self::$user !== null) return self::$user;
        self::startSession();
        $uid = $_SESSION['uid'] ?? null;
        if (!$uid) return null;
        $now = time();
        if ($now - (int)($_SESSION['last'] ?? 0) > self::IDLE_SEC || $now - (int)($_SESSION['started'] ?? 0) > self::ABS_SEC) {
            self::destroy();
            return null;
        }
        $_SESSION['last'] = $now;
        $u = Db::one('SELECT id,email,name,role,is_active,must_change_password FROM users WHERE id=?', [(int)$uid]);
        if (!$u || !(int)$u['is_active']) { self::destroy(); return null; }
        return self::$user = $u;
    }

    public static function setUserForCli(?array $u): void { self::$user = $u; }

    public static function id(): ?int { $u = self::user(); return $u ? (int)$u['id'] : null; }

    public static function require(): array
    {
        $u = self::user();
        if (!$u) throw new ApiError('unauthenticated', 'Silakan login');
        return $u;
    }

    public static function can(string $perm): bool
    {
        $u = self::user();
        return $u !== null && Permissions::has($u['role'], $perm);
    }

    /** @param string|string[] $perm any-of */
    public static function requirePerm($perm): array
    {
        $u = self::require();
        foreach ((array)$perm as $p) if (Permissions::has($u['role'], $p)) return $u;
        throw ApiError::forbidden('Butuh izin ' . implode(' / ', (array)$perm));
    }

    public static function login(string $email, string $password): array
    {
        self::startSession();
        $ip = Http::clientIp();
        $email = strtolower(trim($email));
        $since = date('Y-m-d H:i:s', time() - self::WINDOW);
        $ipFails = (int)Db::val('SELECT COUNT(*) FROM login_attempts WHERE ip=? AND success=0 AND created_at>=?', [$ip, $since]);
        if ($ipFails >= self::IP_MAX) {
            throw new ApiError('rate_limited', 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.');
        }
        $u = Db::one('SELECT * FROM users WHERE email=?', [$email]);
        $generic = new ApiError('unauthenticated', 'Email atau password salah');
        $now = Util::now();
        if ($u && $u['locked_until'] !== null && $u['locked_until'] > $now) {
            Db::insert('login_attempts', ['email' => $email, 'ip' => $ip, 'success' => 0]);
            Audit::log('login_fail', 'user', (string)$u['id'], 'akun terkunci', null, null, null);
            throw new ApiError('rate_limited', 'Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi dalam 15 menit.');
        }
        $ok = $u && (int)$u['is_active'] && password_verify($password, $u['password_hash']);
        Db::insert('login_attempts', ['email' => $email, 'ip' => $ip, 'success' => $ok ? 1 : 0]);
        if (!$ok) {
            if ($u) {
                $fails = (int)Db::val('SELECT COUNT(*) FROM login_attempts WHERE email=? AND success=0 AND created_at>=?', [$email, $since]);
                $upd = ['failed_count' => (int)$u['failed_count'] + 1];
                if ($fails >= self::ACCOUNT_MAX) $upd['locked_until'] = date('Y-m-d H:i:s', time() + self::WINDOW);
                Db::update('users', $upd, ['id' => $u['id']]);
                Audit::log('login_fail', 'user', (string)$u['id'], 'password salah' . (isset($upd['locked_until']) ? ' → dikunci' : ''), null, null, null);
            } else {
                Audit::log('login_fail', 'user', null, 'email tidak dikenal: ' . mb_substr($email, 0, 120), null, null, null);
            }
            throw $generic;
        }
        $upd = ['failed_count' => 0, 'locked_until' => null, 'last_login_at' => $now];
        if (password_needs_rehash($u['password_hash'], self::algo(), self::algoOpts())) $upd['password_hash'] = self::hash($password);
        Db::update('users', $upd, ['id' => $u['id']]);
        if (session_status() === PHP_SESSION_ACTIVE) session_regenerate_id(true);
        $_SESSION = ['uid' => (int)$u['id'], 'started' => time(), 'last' => time(), 'csrf' => Util::b64url(random_bytes(32))];
        self::$user = null;
        $user = self::user() ?? $u;
        Audit::log('login', 'user', (string)$u['id'], 'login sukses', null, null, (int)$u['id']);
        return $user;
    }

    public static function destroy(): void
    {
        self::$user = null;
        if (session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION = [];
            if (!headers_sent() && PHP_SAPI !== 'cli') {
                $p = session_get_cookie_params();
                setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $p['path'], 'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Strict']);
            }
            session_destroy();
        }
    }

    public static function algo() { return defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT; }
    public static function algoOpts(): array { return defined('PASSWORD_ARGON2ID') ? [] : ['cost' => 11]; }
    public static function hash(string $pw): string { return password_hash($pw, self::algo(), self::algoOpts()); }

    /** Kebijakan password §2.1: min 10, tolak 20 password umum. */
    public static function checkPolicy(string $pw, string $email = ''): ?string
    {
        if (mb_strlen($pw) < 10) return 'min_10_chars';
        if (in_array(strtolower($pw), self::COMMON, true)) return 'too_common';
        if ($email !== '' && stripos($pw, explode('@', $email)[0]) !== false && mb_strlen(explode('@', $email)[0]) >= 4) return 'contains_email';
        return null;
    }

    public static function dto(array $u): array
    {
        return ['id' => (int)$u['id'], 'email' => $u['email'], 'name' => $u['name'], 'role' => $u['role'],
            'mustChangePassword' => (bool)(int)$u['must_change_password']];
    }
}
