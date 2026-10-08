<?php
declare(strict_types=1);

/**
 * Router mini (D1). Pola: '/admin/tenants/{id}'. Handler: callable(array $params): void.
 * Opsi per rute: 'admin' (session+CSRF), 'perm' (permission key | list any-of), 'auth' => false (admin tanpa login).
 */
final class Router
{
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler, array $opts = []): void
    {
        $rx = '#^' . preg_replace('#\\\{(\w+)\\\}#', '(?P<$1>[^/]+)', preg_quote($pattern, '#')) . '$#';
        $this->routes[] = [$method, $rx, $handler, $opts, $pattern];
    }
    public function get(string $p, callable $h, array $o = []): void { $this->add('GET', $p, $h, $o); }
    public function post(string $p, callable $h, array $o = []): void { $this->add('POST', $p, $h, $o); }
    public function put(string $p, callable $h, array $o = []): void { $this->add('PUT', $p, $h, $o); }
    public function delete(string $p, callable $h, array $o = []): void { $this->add('DELETE', $p, $h, $o); }

    /** Path relatif terhadap /api (mis. '/admin/tenants'). */
    public static function currentPath(): string
    {
        if (isset($_GET['r']) && is_string($_GET['r'])) return '/' . ltrim($_GET['r'], '/');
        $uri = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        $base = Util::appBasePath() . '/api';
        if ($base !== '' && str_starts_with($uri, $base)) $uri = substr($uri, strlen($base));
        if (str_starts_with($uri, '/index.php')) $uri = substr($uri, 10);
        $uri = '/' . trim($uri, '/');
        return rawurldecode($uri);
    }

    public function dispatch(string $method, string $path): void
    {
        $allowed = [];
        foreach ($this->routes as [$m, $rx, $h, $opts]) {
            if (!preg_match($rx, $path, $mm)) continue;
            if ($m !== $method && !($method === 'HEAD' && $m === 'GET')) { $allowed[] = $m; continue; }
            $params = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
            if (!empty($opts['admin'])) Middleware::admin($method, $opts);
            $h($params);
            return;
        }
        if ($allowed) throw new ApiError('method', 'Method tidak diizinkan', [], ['allow' => array_values(array_unique($allowed))]);
        throw ApiError::notFound('Endpoint');
    }
}
