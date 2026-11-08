#!/usr/bin/env bash
# Backup logis MySQL (mysqldump) ke folder backups/ di host, terpisah dari volume mysqldata.
# Jalankan manual:   ./scripts/backup.sh
# Jadwal (cron):     lihat docs/drp.md  (contoh: setiap 15 menit)
# Kredensial dibaca dari environment di dalam container mysql (tidak ada password di skrip).
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-7}"
OUT="backups/cbt_portal_$(date +%Y%m%d_%H%M%S).sql.gz"
TMP="$OUT.partial"

docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces "$MYSQL_DATABASE"' \
  | gzip > "$TMP"

# Berkas harus berisi dump yang lengkap sebelum dianggap valid
gzip -t "$TMP"
zcat "$TMP" | tail -n 1 | grep -q "Dump completed" || { rm -f "$TMP"; echo "Backup tidak lengkap, dibatalkan" >&2; exit 1; }
mv "$TMP" "$OUT"

find backups -name 'cbt_portal_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup selesai: $OUT ($(du -h "$OUT" | cut -f1))"
