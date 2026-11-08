# Disaster Recovery Plan - Portal Ujian Online CBT

## Target
| Parameter | Target | Cara dipenuhi |
|---|---|---|
| RPO (jawaban terkonfirmasi) | Target 0 untuk crash proses yang telah ACK | Autosave commit ke MySQL (`innodb-flush-log-at-trx-commit=1`); tetap perlu uji pemulihan dan replika/offsite untuk bencana host |
| RPO (bencana data/host hilang) | maks. 15 menit | `mysqldump` berkala ke `backups/` |
| RTO backend | Target maks. 2 menit | `restart: always` + healthcheck + tes recovery; belum terbukti untuk semua jenis kegagalan |

## Skenario dan penanganan
| Skenario | Dampak | Pemulihan |
|---|---|---|
| Container service mati/crash | Request gagal sebentar; frontend menampilkan "Menyambungkan ulang..." dan menyimpan jawaban di antrean lokal | Otomatis (`restart: always`). Uji: `./scripts/test-recovery.sh` |
| Container MySQL dihapus | Layanan berhenti sementara | `docker compose up -d`; data tetap di volume `cbt_mysqldata` |
| Volume hilang / data rusak | Data hilang | `./scripts/restore.sh backups/<berkas>.sql.gz` lalu `docker compose restart auth-service exam-service session-service` |
| Host mati | Semua layanan berhenti | Pulihkan host, `docker compose up -d --build`, restore backup bila volume hilang |
| AWS: task mati | ECS menjalankan task pengganti, ALB hanya mengarah ke target sehat | Otomatis |
| AWS: data RDS | - | Backup otomatis RDS 7 hari (point-in-time) |

## Backup terjadwal (cron)
Jalankan dari host (Linux/macOS), sesuaikan path:
```
*/15 * * * * cd /path/ke/cbt-portal && ./scripts/backup.sh >> backups/backup.log 2>&1
```
Windows: pakai Task Scheduler yang memanggil `bash scripts/backup.sh` (Git Bash/WSL).
Berkas lama > 7 hari dihapus otomatis (`KEEP_DAYS`). Salin `backups/` ke lokasi lain (flashdisk/cloud)
karena folder ini masih berada pada host yang sama.

## Pengujian pemulihan
1. `docker compose up -d --build`, tunggu semua `healthy`.
2. `./scripts/test-recovery.sh session-service` (atau `auth-service`, `exam-service`).
3. Catat waktu pulih yang dilaporkan (harus <= 120 detik) sebagai bukti NFR-03.
4. Uji restore: `./scripts/backup.sh`, ubah/hapus data uji, `./scripts/restore.sh <berkas>`, cek data kembali.

**Penting:** Restore sekarang memverifikasi integritas gzip dan footer mysqldump **sebelum** menghapus database aktif. Lakukan backup offsite dan tes restore berkala. Lihat [full audit](AUDIT_FULL_2026-11-08.md) untuk risiko DRP yang belum selesai.
