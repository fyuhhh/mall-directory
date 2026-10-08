#!/bin/sh
# backup.sh — backup DB + media + arsip rilis (§8.6), Linux/macOS.
#   BSB_BACKUP_DIR=/srv/bsb-backup sh tools/backup.sh
# Retensi: 14 harian + 8 mingguan (Minggu) + 12 bulanan (tgl 1). Off-site: rclone/Drive (lihat README CMS).
set -eu
APP="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BSB_BACKUP_DIR:-$HOME/bsb-backup}"
PHP="${PHP_BIN:-}"
[ -z "$PHP" ] && for p in /Applications/XAMPP/xamppfiles/bin/php /opt/lampp/bin/php "$(command -v php || true)"; do [ -n "$p" ] && [ -x "$p" ] && PHP="$p" && break; done
cfg() { "$PHP" -r 'require $argv[1]."/lib/bootstrap.php"; $v=Config::get($argv[2]); echo is_scalar($v)?$v:"";' "$APP" "$1"; }
DB_NAME="$(cfg db.name)"; DB_USER="$(cfg db.user)"; DB_PASS="$(cfg db.pass)"; DB_HOST="$(cfg db.host)"; DB_SOCK="$(cfg db.socket)"
DUMP="$(cfg mysqldump)"; [ -x "$DUMP" ] || DUMP="$(command -v mysqldump)"
TS="$(date +%Y%m%d_%H%M)"
mkdir -p "$DEST/db/daily" "$DEST/db/weekly" "$DEST/db/monthly" "$DEST/media" "$DEST/releases"
OUT="$DEST/db/daily/bsb_${TS}.sql.gz"
CONN="-u$DB_USER"
[ -n "$DB_PASS" ] && CONN="$CONN -p$DB_PASS"
if [ -n "$DB_SOCK" ]; then CONN="$CONN --socket=$DB_SOCK"; else CONN="$CONN -h$DB_HOST"; fi
SQL="$DEST/db/daily/bsb_${TS}.sql"
# shellcheck disable=SC2086
if ! "$DUMP" $CONN --single-transaction --routines --default-character-set=utf8mb4 --result-file="$SQL" "$DB_NAME" 2>"$SQL.err"; then
  # mis. XAMPP dengan tabel mysql.proc lama (error 1558) → ulangi tanpa --routines (skema bsb_directory tidak memakai routine)
  echo "peringatan: $(head -c 300 "$SQL.err") — ulang tanpa --routines" >&2
  # shellcheck disable=SC2086
  "$DUMP" $CONN --single-transaction --default-character-set=utf8mb4 --result-file="$SQL" "$DB_NAME"
fi
rm -f "$SQL.err"
tail -c 200 "$SQL" | grep -q "Dump completed" || { echo "dump tidak lengkap" >&2; exit 1; }
gzip -9 -c "$SQL" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT" && rm -f "$SQL"
[ "$(date +%u)" = "7" ] && cp "$OUT" "$DEST/db/weekly/"
[ "$(date +%d)" = "01" ] && cp "$OUT" "$DEST/db/monthly/"
# mirror inkremental media & arsip rilis
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude 'tmp/' "$APP/media/" "$DEST/media/"
  rsync -a "$APP/data/releases/" "$DEST/releases/"
else
  cp -R "$APP/media/." "$DEST/media/"; cp -R "$APP/data/releases/." "$DEST/releases/"
fi
# retensi
prune() { ls -1t "$1"/bsb_*.sql.gz 2>/dev/null | tail -n +"$(( $2 + 1 ))" | while read -r f; do rm -f "$f"; done; }
prune "$DEST/db/daily" 14; prune "$DEST/db/weekly" 8; prune "$DEST/db/monthly" 12
echo "backup OK: $OUT ($(du -h "$OUT" | cut -f1)) → $DEST"
