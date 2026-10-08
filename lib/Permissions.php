<?php
declare(strict_types=1);

/** Matriks izin §1.3 (hardcode, bukan di DB). */
final class Permissions
{
    public const ALL = ['tenants.edit', 'tenants.place', 'categories.edit', 'floors.edit', 'graph.edit', 'connectors.edit',
        'amenities.edit', 'kiosks.edit', 'kiosks.provision', 'kiosks.command', 'promos.edit', 'events.edit', 'featured.edit',
        'i18n.edit', 'media.upload', 'media.delete', 'status.closures', 'status.notice', 'publish.content', 'publish.map',
        'publish.promos', 'releases.rollback', 'analytics.view', 'audit.view', 'users.manage', 'settings.edit', 'backup.run'];

    public const ROLES = [
        'superadmin' => '*',
        'map_editor' => ['tenants.edit', 'tenants.place', 'floors.edit', 'graph.edit', 'connectors.edit', 'amenities.edit',
            'kiosks.edit', 'kiosks.command', 'media.upload', 'status.closures', 'publish.content', 'publish.map',
            'releases.rollback', 'analytics.view'],
        'leasing' => ['tenants.edit', 'tenants.place', 'categories.edit', 'media.upload', 'publish.content', 'analytics.view'],
        'marketing' => ['promos.edit', 'events.edit', 'featured.edit', 'i18n.edit', 'media.upload', 'publish.promos', 'analytics.view'],
        'operations' => ['kiosks.command', 'status.closures', 'status.notice', 'analytics.view'],
        'security' => ['status.notice'],
        'viewer' => ['analytics.view'],
    ];

    public static function forRole(string $role): array
    {
        $p = self::ROLES[$role] ?? [];
        return $p === '*' ? self::ALL : $p;
    }
    public static function has(string $role, string $perm): bool { return in_array($perm, self::forRole($role), true); }
}
