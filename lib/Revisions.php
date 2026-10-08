<?php
declare(strict_types=1);

/** Revisi per scope (content|map|promos) untuk optimistic lock & "belum dipublish". */
final class Revisions
{
    public static function bump(string $scope): int
    {
        Db::exec('UPDATE revisions SET rev = rev + 1 WHERE scope = ?', [$scope]);
        return self::get($scope);
    }
    public static function get(string $scope): int { return (int)Db::val('SELECT rev FROM revisions WHERE scope=?', [$scope]); }
    public static function all(): array
    {
        $o = ['content' => 0, 'map' => 0, 'promos' => 0];
        foreach (Db::all('SELECT scope, rev FROM revisions') as $r) $o[$r['scope']] = (int)$r['rev'];
        return $o;
    }
}
