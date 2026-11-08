# Arsitektur - Portal Ujian Online CBT (Kelompok 2)

Dokumen ini merangkum arsitektur **yang diimplementasikan** dan pemetaannya ke
Dokumen Spesifikasi Arsitektur (Word, Pertemuan 1).

## 1. Dari monolit (Pertemuan 1) ke microservices (Pertemuan 3+)

| Spesifikasi Word | Implementasi sekarang |
|---|---|
| Satu `Backend API` (Node.js + Express) | Tiga service dari satu basis kode: `auth`, `exam`, `session` (`src/services/*`), kode bersama di `src/shared/common.js` |
| Browser -> backend port 3000 | Browser -> `gateway` (Nginx: API Gateway + Load Balancer lokal), port `APP_PORT` (3000) |
| Frontend disajikan folder `public/` | `public/` disajikan gateway (lokal) / service `web` (AWS) |
| MySQL + tabel `sessions` | Sama. Tabel `sessions` dipakai bersama oleh ketiga service (secret sama) |
| Backup mysqldump + cron | `scripts/backup.sh` + cron, hasil di `backups/` (lihat `docs/drp.md`) |

Seluruh kebutuhan FR-01..FR-09 dan NFR-01..NFR-06 tetap dipenuhi. Skema database tidak berubah.

## 2. Pembagian tugas service

| Service | Endpoint publik | Catatan |
|---|---|---|
| auth | `POST /api/login`, `GET /api/me`, `POST /api/logout`, `GET /health` | pemilik pembersihan sesi kedaluwarsa |
| exam | `GET /api/exams`, `GET /api/exams/:id/questions`, `GET /health` | kunci jawaban tidak pernah keluar |
| session | `POST /api/sessions/start`, `GET /api/sessions/:id`, `PUT /api/sessions/:id/answers`, `POST /api/sessions/:id/finish`, `GET /health` | memanggil exam-service secara internal |

Tambahan di luar tabel API Word: `GET /healthz` (gateway), `/internal/*` antar-service
(dijaga `INTERNAL_TOKEN`, diblokir dari luar), rate limit di gateway.

## 3. Prinsip ketahanan (Word bagian 3.4) dan implementasinya

1. **Stateless**: tidak ada data ujian/sesi di memori proses; session login di MySQL.
   Satu-satunya data di memori adalah cache id soal 60 detik di session-service
   (`qCache`) - bisa dibangun ulang, hilang saat restart tanpa dampak.
2. **Autosave per klik**: `PUT /api/sessions/:id/answers`.
3. **Idempotent write**: `INSERT ... ON DUPLICATE KEY UPDATE` + `UNIQUE (session_id, question_id)`; `finish` juga aman diulang.
4. **Timer server**: sisa waktu dihitung SQL dari `started_at`.
5. **Retry klien**: antrean di `localStorage`, kirim ulang tiap 2 detik.
6. **Persisten**: volume `cbt_mysqldata`; `innodb-flush-log-at-trx-commit=1`.

## 4. Keamanan (NFR-04)

- Password siswa: bcrypt.
- Kredensial (`DB_USER`, `DB_PASSWORD`, `SESSION_SECRET`, `INTERNAL_TOKEN`) hanya dari environment
  (`.env` lokal, Secrets Manager di AWS). Kode **tidak punya nilai bawaan**: service berhenti bila belum diisi.
- `.env`, `terraform.tfvars`, dan `*.tfstate` masuk `.gitignore`; `.env.example` hanya berisi placeholder.
- MySQL tidak dipublish ke host; hanya gateway yang membuka port.

## 5. Struktur repositori

```
cbt-portal/
  src/shared/common.js          kode bersama (DB, session, health, panggilan antar-service)
  src/services/{auth,exam,session}/server.js
  public/index.html             frontend
  db/schema.sql, db/setup.js
  gateway/                      Nginx (mode gateway lokal / static AWS)
  scripts/                      backup.sh, restore.sh, test-recovery.sh, reset-loadtest.sh
  backups/                      hasil mysqldump (tidak di-commit)
  docs/                         arsitektur.md, drp.md, prompt-ai.md
  infra/aws/                    Terraform (cloud + auto scaling)
  loadtest/                     k6-stress.js (1-1000 VU), k6-autoscale.js, plot_results.py
  docker-compose.yml, Dockerfile, package.json, .env.example, .gitignore, README.md
```
