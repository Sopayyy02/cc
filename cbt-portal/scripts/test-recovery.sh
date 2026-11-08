#!/usr/bin/env bash
# Uji NFR-03 (pemulihan backend <= 2 menit) dan NFR-02 (jawaban tidak hilang).
# Prasyarat: docker compose up -d --build  (semua service healthy), curl terpasang.
# Pemakaian:  ./scripts/test-recovery.sh [service]   (default: session-service)
set -euo pipefail
cd "$(dirname "$0")/.."
SVC="${1:-session-service}"
BASE="http://localhost:${APP_PORT:-3000}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
LIMIT=120

j() { curl -s -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }

echo "1) Login + mulai ujian + simpan 1 jawaban"
j -X POST "$BASE/api/login" -d '{"nim":"2024001","password":"password123"}' >/dev/null
SID=$(j -X POST "$BASE/api/sessions/start" -d '{"exam_id":1}' | sed -E 's/.*"session_id":([0-9]+).*/\1/')
j -X PUT "$BASE/api/sessions/$SID/answers" -d '{"question_id":1,"pilihan":"C"}' | grep -q saved
echo "   sesi $SID, jawaban soal 1 = C tersimpan"

echo "2) Matikan paksa $SVC (simulasi crash)"
CID=$(docker compose ps -q "$SVC" | head -n1)
START=$(date +%s)
docker kill "$CID" >/dev/null

echo "3) Menunggu pulih (restart: always)..."
until [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/sessions/$SID")" = "200" ]; do
  [ $(( $(date +%s) - START )) -gt $LIMIT ] && { echo "GAGAL: belum pulih dalam ${LIMIT} dtk"; exit 1; }
  sleep 1
done
TOOK=$(( $(date +%s) - START ))

echo "4) Cek jawaban dan login setelah pulih"
RES=$(j "$BASE/api/sessions/$SID")
echo "$RES" | grep -q '"1":"C"' || { echo "GAGAL: jawaban hilang -> $RES"; exit 1; }
echo "$RES" | grep -q 'sisa_detik' || { echo "GAGAL: sisa waktu tidak ada"; exit 1; }
echo "HASIL: LULUS. Pulih dalam ${TOOK} dtk (batas ${LIMIT} dtk), jawaban + session login tetap ada."
