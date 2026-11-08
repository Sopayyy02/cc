#!/usr/bin/env bash
# Hapus sesi ujian + jawaban hasil uji beban agar timer ujian (30 menit) mulai dari awal
# dan stress test dapat diulang. Data siswa/soal tidak disentuh.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE" -e "DELETE FROM answers; DELETE FROM exam_sessions; DELETE FROM sessions;"'
echo "Sesi, jawaban, dan store sesi berhasil dihapus."
