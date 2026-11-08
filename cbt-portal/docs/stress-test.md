# Stress Test 1 - 1000 Virtual Users (Pertemuan 3)

Sesuai petunjuk dosen: uji bertahap **10, 100, 500, 1000 VU**, tiap level **ditahan 1-3 menit**
(default 120 detik), catat titik mulai gagal (error 500/timeout), lalu buat grafik
Throughput, Response Time, Error Rate dan analisis bottleneck.

## Endpoint yang diuji (krusial untuk studi kasus CBT)
| Endpoint | Peran | Frekuensi di skrip |
|---|---|---|
| `POST /api/login` | login (bcrypt, berat di CPU) | sekali per VU |
| `POST /api/sessions/start`, `GET /api/exams/:id/questions` | mulai ujian, ambil soal | sekali per VU |
| `PUT /api/sessions/:id/answers` | **autosave** (tulis ke MySQL) | tiap iterasi (jeda 1-3 dtk) |
| `GET /api/sessions/:id` | resume/heartbeat + sisa waktu | tiap 5 iterasi |

Jeda 1-3 detik jauh lebih agresif daripada siswa sungguhan (itulah tujuan stress test).
Ubah dengan `-e THINK_MIN=.. -e THINK_MAX=..`.

## Langkah
1. Di `.env` isi `LOADTEST_STUDENTS=1000` (membuat siswa dummy LT0001-LT1000 agar tiap VU punya sesi sendiri).
2. Jalankan dengan rate limit gateway dilonggarkan (k6 mengirim semua VU dari satu IP; tanpa ini yang
   tercatat adalah rate limit, bukan batas infrastruktur):
   `docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build`
3. Pastikan `docker compose ps` semua `healthy`. Opsional untuk membandingkan: `--scale session-service=3`.
4. Jalankan uji (sekitar 11 menit):
   ```
   k6 run --out json=loadtest/results/raw.json.gz --summary-export=loadtest/results/summary.json loadtest/k6-stress.js
   ```
5. Selama uji, di terminal lain pantau beban container (screenshot untuk laporan):
   `docker stats` dan `docker compose logs -f gateway session-service`
6. Buat grafik dan tabel: `python3 loadtest/plot_results.py loadtest/results/raw.json.gz`
   (butuh `pip install matplotlib`). Hasil: `loadtest/results/stress_graph.png`, `stage_summary.csv`.
7. Ulangi uji: `./scripts/reset-loadtest.sh` (timer ujian 30 menit akan kedaluwarsa bila sesi lama dipakai).
8. Setelah selesai, kembali ke konfigurasi normal: `docker compose up -d` (tanpa file override).

Parameter: `-e HOLD_SEC=60..180`, `-e RAMP_SEC=30`, `-e BASE_URL=http://<host>:3000`, `-e USER_MODE=dummy` (5 siswa bawaan).
Catatan: k6 dan Docker di laptop yang sama saling berebut CPU; sebutkan spesifikasi mesin di laporan.

## Definisi "titik gagal"
Level pertama (saat ditahan) yang error rate-nya >= 1% atau p95 response time >= 1000 ms
(ambang yang sama dipasang sebagai threshold k6 per level). Diubah di `plot_results.py` dan `k6-stress.js` bila dosen menetapkan lain.

## Batas sumber daya awal (konfigurasi saat ini, bukan hasil)
Tiap container service dibatasi 0.5 CPU / 256 MB, pool DB 5 koneksi per replika,
MySQL `max_connections=300`. Angka ini perlu dicatat sebagai kondisi awal pengujian.

## Hipotesis bottleneck (harus dibuktikan dengan data, bukan disalin ke laporan sebagai fakta)
- CPU `auth-service`: bcrypt saat ratusan VU login hampir bersamaan (lonjakan di awal tiap level).
- CPU/antrean `session-service`: jalur autosave paling padat (tiap request = 1 query kepemilikan + 1 UPSERT).
- Pool koneksi (5 per replika) penuh -> response time naik sebelum CPU penuh.
- Disk/commit MySQL: `innodb-flush-log-at-trx-commit=1` (demi RPO ketat) membuat tiap commit menunggu flush.
- Satu host dipakai bersama k6, gateway, semua service, dan MySQL.
Cara membedakan: bandingkan `docker stats` (CPU container mana yang mentok), log `session-service`,
dan `SHOW PROCESSLIST` / `SHOW STATUS LIKE 'Threads_connected'` di MySQL saat level 500 dan 1000.

## Template laporan (isi dari hasil nyata)
| Tahap | Request | Throughput (req/s) | Avg (ms) | p95 (ms) | p99 (ms) | Error (%) |
|---|---|---|---|---|---|---|
| 10 VU | | | | | | |
| 100 VU | | | | | | |
| 500 VU | | | | | | |
| 1000 VU | | | | | | |

Titik gagal: ...
Komponen yang pertama jenuh (bukti `docker stats`): ...
Rekomendasi perbaikan (replika, pool, indeks, tuning MySQL): ...
