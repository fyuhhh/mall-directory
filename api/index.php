<?php
/* Front controller API (§4.1). Base path dihitung dari SCRIPT_NAME; fallback ?r=/admin/... bila mod_rewrite mati. */
declare(strict_types=1);
require __DIR__ . '/../lib/bootstrap.php';

ini_set('display_errors', '0');
$router = new Router();
foreach ([PublicApi::class, AuthApi::class, TenantsApi::class, CatalogApi::class, KiosksApi::class, GraphApi::class, ConnectorsApi::class,
          StatusApi::class, PublishApi::class, MediaApi::class, AnalyticsApi::class, Map3dApi::class] as $cls) $cls::register($router);

try {
    $path = Router::currentPath();
    if (str_starts_with($path, '/admin')) Http::$isAdmin = true;
    $router->dispatch(Http::method(), $path);
} catch (ApiError $e) {
    Http::error($e);
} catch (Throwable $e) {
    error_log('[bsb-api] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::error(new ApiError('server', 'Kesalahan server'));
}
