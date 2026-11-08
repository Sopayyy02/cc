#!/usr/bin/env bash
# Pulihkan database dari berkas backup.   Pemakaian: ./scripts/restore.sh backups/<berkas>.sql.gz
# PERINGATAN: isi database saat ini akan ditimpa oleh isi backup.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Pemakaian: $0 backups/<berkas>.sql.gz}"
[ -f "$FILE" ] || { echo "Berkas tidak ditemukan: $FILE" >&2; exit 1; }

read -r -p "Database akan ditimpa dari $FILE. Lanjut? (ketik 'ya') " ans
[ "$ans" = "ya" ] || { echo "Dibatalkan."; exit 1; }

docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4;"'
zcat "$FILE" | docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE"'
echo "Pemulihan selesai. Jalankan: docker compose restart auth-service exam-service session-service"
