<?php
declare(strict_types=1);

/** PDO singleton + helper kecil. Semua query memakai prepared statement (emulasi mati). */
final class Db
{
    private static ?PDO $pdo = null;
    private static int $txDepth = 0;

    public static function pdo(): PDO
    {
        if (self::$pdo) return self::$pdo;
        $c = Config::get('db');
        $dsn = 'mysql:' . (!empty($c['socket']) ? 'unix_socket=' . $c['socket'] : 'host=' . $c['host'] . ';port=' . (int)$c['port'])
            . ';dbname=' . $c['name'] . ';charset=utf8mb4';
        self::$pdo = new PDO($dsn, $c['user'], $c['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        self::$pdo->exec("SET time_zone = '+08:00'");
        return self::$pdo;
    }

    public static function reset(): void { self::$pdo = null; self::$txDepth = 0; }

    public static function q(string $sql, array $p = []): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        foreach (array_values(array_keys($p)) as $i => $k) {
            $v = $p[$k];
            $name = is_int($k) ? $k + 1 : (str_starts_with((string)$k, ':') ? $k : ':' . $k);
            if (is_bool($v)) $st->bindValue($name, $v ? 1 : 0, PDO::PARAM_INT);
            elseif (is_int($v)) $st->bindValue($name, $v, PDO::PARAM_INT);
            elseif ($v === null) $st->bindValue($name, null, PDO::PARAM_NULL);
            else $st->bindValue($name, is_float($v) ? (string)$v : $v, PDO::PARAM_STR);
        }
        $st->execute();
        return $st;
    }
    public static function all(string $sql, array $p = []): array { return self::q($sql, $p)->fetchAll(); }
    public static function one(string $sql, array $p = []): ?array { $r = self::q($sql, $p)->fetch(); return $r === false ? null : $r; }
    public static function val(string $sql, array $p = []) { $r = self::q($sql, $p)->fetchColumn(); return $r === false ? null : $r; }
    public static function col(string $sql, array $p = []): array { return self::q($sql, $p)->fetchAll(PDO::FETCH_COLUMN); }
    public static function exec(string $sql, array $p = []): int { return self::q($sql, $p)->rowCount(); }
    public static function lastId(): int { return (int)self::pdo()->lastInsertId(); }

    /** INSERT; nama tabel/kolom berasal dari kode (whitelist), nilai lewat parameter. */
    public static function insert(string $table, array $row): int
    {
        $cols = array_keys($row);
        $sql = 'INSERT INTO `' . $table . '` (`' . implode('`,`', $cols) . '`) VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')';
        self::q($sql, array_values($row));
        return self::lastId();
    }
    public static function update(string $table, array $row, array $where): int
    {
        if (!$row) return 0;
        $set = []; $p = [];
        foreach ($row as $k => $v) { $set[] = '`' . $k . '`=?'; $p[] = $v; }
        $w = [];
        foreach ($where as $k => $v) { $w[] = '`' . $k . '`=?'; $p[] = $v; }
        return self::exec('UPDATE `' . $table . '` SET ' . implode(',', $set) . ' WHERE ' . implode(' AND ', $w), $p);
    }

    /** Transaksi bersarang (savepoint-less: hanya level terluar yang commit). */
    public static function tx(callable $fn)
    {
        $pdo = self::pdo();
        if (self::$txDepth === 0) $pdo->beginTransaction();
        self::$txDepth++;
        try {
            $r = $fn();
            self::$txDepth--;
            if (self::$txDepth === 0 && $pdo->inTransaction()) $pdo->commit();
            return $r;
        } catch (Throwable $e) {
            self::$txDepth--;
            if (self::$txDepth === 0 && $pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }
}
