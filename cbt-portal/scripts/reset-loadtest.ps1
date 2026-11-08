# Hapus sesi ujian + jawaban + store sesi login agar timer ujian (30 menit) mulai dari awal
# dan stress test dapat diulang kembali.
docker compose exec -T mysql mysql -uroot -prootpass123 cbt_portal -e "DELETE FROM answers; DELETE FROM exam_sessions; DELETE FROM sessions;"
Write-Host "Sesi, jawaban, dan store sesi login berhasil dihapus."

