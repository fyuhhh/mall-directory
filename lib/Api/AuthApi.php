<?php
declare(strict_types=1);

final class AuthApi
{
    public static function register(Router $r): void
    {
        $r->post('/admin/auth/login', [self::class, 'login'], ['admin' => true, 'auth' => false]);
        $r->post('/admin/auth/logout', [self::class, 'logout'], ['admin' => true]);
        $r->get('/admin/auth/me', [self::class, 'me'], ['admin' => true]);
        $r->get('/admin/auth/csrf', [self::class, 'csrf'], ['admin' => true, 'auth' => false]);
        $r->post('/admin/auth/password', [self::class, 'password'], ['admin' => true]);
    }

    public static function login(): void
    {
        $b = Http::body(8192);
        $email = (string)($b['email'] ?? ''); $pw = (string)($b['password'] ?? '');
        $f = [];
        if ($email === '') $f['email'] = 'required';
        if ($pw === '') $f['password'] = 'required';
        if ($f) throw ApiError::validation($f);
        $u = Auth::login($email, $pw);
        Http::ok(['user' => Auth::dto($u), 'permissions' => Permissions::forRole($u['role']), 'csrfToken' => Csrf::token()]);
    }

    public static function logout(): void
    {
        $id = Auth::id();
        Audit::log('logout', 'user', (string)$id, 'logout');
        Auth::destroy();
        Http::ok(['loggedOut' => true]);
    }

    public static function csrf(): void { Http::ok(['csrfToken' => Csrf::token(), 'authenticated' => Auth::user() !== null]); }

    public static function me(): void
    {
        $u = Auth::require();
        $revs = Revisions::all();
        $live = []; $unpub = ['content' => false, 'map' => false, 'promos' => false];
        foreach (array_keys(Publisher::CHANNELS) as $ch) {
            $l = Publisher::live($ch);
            $live[$ch] = $l ? ['version' => $l['version'], 'publishedAt' => Util::iso($l['created_at']), 'rolledBack' => $l['rolled_back_from'] !== null] : null;
            if ($ch !== 'status') {
                $lr = $l ? (Util::jsonDecode($l['revs'], []) ?: []) : [];
                foreach ($ch === 'directory' ? ['content', 'map'] : ['promos'] as $s) $unpub[$s] = $revs[$s] > (int)($lr[$s] ?? -1);
            }
        }
        Http::ok(['user' => Auth::dto($u), 'permissions' => Permissions::forRole($u['role']), 'csrfToken' => Csrf::token(),
            'live' => $live, 'unpublished' => $unpub, 'revisions' => $revs, 'serverTime' => Util::nowIso()]);
    }

    public static function password(): void
    {
        $u = Auth::require();
        $b = Http::body(8192);
        $row = Db::one('SELECT * FROM users WHERE id=?', [$u['id']]);
        if (!password_verify((string)($b['current'] ?? ''), $row['password_hash'])) throw ApiError::validation(['current' => 'wrong_password'], 'Password lama salah');
        $new = (string)($b['new'] ?? '');
        if ($e = Auth::checkPolicy($new, $row['email'])) throw ApiError::validation(['new' => $e]);
        if (password_verify($new, $row['password_hash'])) throw ApiError::validation(['new' => 'same_as_current']);
        Db::update('users', ['password_hash' => Auth::hash($new), 'must_change_password' => 0, 'password_changed_at' => Util::now()], ['id' => $u['id']]);
        if (session_status() === PHP_SESSION_ACTIVE) session_regenerate_id(true);
        Audit::log('password_change', 'user', (string)$u['id'], 'password diganti');
        Http::ok(['changed' => true]);
    }
}
