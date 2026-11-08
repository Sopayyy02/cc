# Portal Ujian Online CBT (Kelompok 2) - Arsitektur Microservices

Stack: Node.js + Express, MySQL 8, HTML + vanilla JS, Docker Compose (lokal), AWS (cloud).

## Arsitektur

```
Browser
  |
  v   LOKAL: gateway (Nginx)                | AWS: API Gateway (HTTP API) -> VPC Link -> ALB (internal)
  +-- /                     frontend statis        -> service "web" (Nginx statis)
  +-- /api/login|me|logout  -> auth-service        (CPU/memori/request-count autoscaling)
  +-- /api/exams*           -> exam-service  <-----+
  +-- /api/sessions*        -> session-service ----+ HTTP internal (timeout 2 dtk, retry 2x, backoff)
                                   semua service -> MySQL (lokal: container, AWS: RDS)
```

| Service               | Tugas                                    | Catatan                                                                           |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `auth-service`      | login, logout, profil                    | pemilik session store (tabel `sessions`)                                        |
| `exam-service`      | daftar ujian & soal, **penilaian** | endpoint `/internal/*` (token antar-service), kunci jawaban tidak pernah keluar |
| `session-service`   | mulai ujian, autosave, selesai           | memanggil `exam-service` untuk validasi soal + penilaian; cache id soal 60 dtk  |
| `gateway` / `web` | routing, rate limit, frontend            | lokal: Nginx; AWS: API Gateway + ALB                                              |

Stabilitas antar-service: semua instance stateless (sesi di MySQL), health check `/health`, retry + timeout pada pemanggilan internal, `proxy_next_upstream` di gateway, `finish` bersifat idempoten (aman diulang), cache id soal saat exam-service sempat down, graceful shutdown (SIGTERM), `keepAliveTimeout` > idle timeout ALB.

## A. Menjalankan lokal (Docker Compose)

1. `cp .env.example .env` (Windows CMD: `copy .env.example .env`), ubah password/secret.
2. `docker compose up -d --build` (service `db-init` membuat tabel + data dummy sekali, lalu selesai).
3. `docker compose ps` -> semua `healthy`. Buka http://localhost:3000. Login NIM `2024001`-`2024005`, password `password123`.
4. Scale-out manual: `docker compose up -d --scale session-service=3 --scale exam-service=2` (gateway otomatis membagi beban lewat DNS Docker).

| Tujuan               | Perintah                                                      |
| -------------------- | ------------------------------------------------------------- |
| Log satu service     | `docker compose logs -f session-service`                    |
| Cek health gateway   | `curl http://localhost:3000/healthz`                        |
| Masuk MySQL          | `docker compose exec mysql mysql -u cbt_user -p cbt_portal` |
| Matikan (data aman)  | `docker compose down`                                       |
| Matikan + HAPUS data | `docker compose down -v`                                    |

### Backup, pemulihan, dan uji ketahanan (sesuai spesifikasi Word)

| Tujuan                                          | Perintah                                                     |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Backup mysqldump ke `backups/`                | `./scripts/backup.sh` (jadwal cron: lihat `docs/drp.md`) |
| Restore dari backup                             | `./scripts/restore.sh backups/<berkas>.sql.gz`             |
| Uji pemulihan <= 2 menit + jawaban tidak hilang | `./scripts/test-recovery.sh session-service`               |

### Stress test 10-100-500-1000 VU (Pertemuan 3)

Panduan lengkap: `docs/stress-test.md`. Ringkas:

```bash
docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build   # rate limit gateway dilonggarkan
k6 run --out json=loadtest/results/raw.json.gz --summary-export=loadtest/results/summary.json loadtest/k6-stress.js
python3 loadtest/plot_results.py loadtest/results/raw.json.gz                      # grafik + tabel per level
```

Dokumentasi: `docs/stress-test.md`, `docs/arsitektur.md`, `docs/drp.md`, `docs/prompt-ai.md`.
Semua kredensial wajib diisi lewat `.env` (tidak ada nilai bawaan di kode); service berhenti dengan pesan jelas bila ada yang kosong.

## B. Deployment Cloud (AWS) + Load Balancer + API Gateway + Auto Scaling

Folder `infra/aws` (Terraform). Komponen:

- **VPC** 2 AZ, subnet publik + privat, NAT Gateway; Security Group berlapis (API GW -> ALB -> service -> RDS).
- **ECR** (4 repo) + **ECS Fargate** (4 service: web, auth, exam, session), rolling deploy + circuit breaker (auto-rollback).
- **Application Load Balancer** (internal) dengan routing berbasis path; `/internal/*` diblokir.
- **API Gateway (HTTP API)** sebagai pintu masuk publik via **VPC Link** ke ALB, dengan throttling.
- **Service discovery** (Cloud Map): `session-service` memanggil `http://exam.cbt.local:3000`.
- **RDS MySQL 8** (terenkripsi, backup 7 hari, opsi Multi-AZ), kredensial di **Secrets Manager**.
- **Auto Scaling** per service (min 2, max 6): target tracking CPU 60%, memori 75%, dan ALB request/target (service API).

Langkah deploy:

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # isi password & secret
export AWS_REGION=ap-southeast-1               # dan `aws configure`
./deploy.sh                                    # ECR -> build/push -> terraform -> migrasi DB
```

Outputnya `app_url` (https://xxxx.execute-api...amazonaws.com). Hapus semua agar tidak kena biaya: `terraform destroy`.

Uji auto scaling: `k6 run -e BASE_URL=<app_url> loadtest/k6-autoscale.js`, lalu pantau
`aws ecs describe-services --cluster cbt-cluster --services session exam auth --query "services[].[serviceName,desiredCount,runningCount]"`.

Catatan: NAT Gateway, ALB, VPC Link dan RDS berbayar per jam; untuk demo cukup `terraform destroy` setelah screenshot. Batas koneksi DB: 3 service x max_tasks x `DB_POOL`(4) harus < `max_connections` (150).

## C. Tanpa Docker

`npm install`, `npm run setup`, lalu jalankan `npm run start:auth`, `start:exam`, `start:session` (3 terminal; isi `EXAM_SERVICE_URL=http://localhost:3002`). Frontend & routing butuh gateway, jadi cara ini hanya untuk uji API.


### Grafana/k6: burst 1,000 jawaban dan verifikasi MySQL

Gunakan [panduan Grafana burst 1.000](docs/grafana-1000.md) untuk menyiapkan
1.000 akun dummy dan mengukur 1.000 autosave PUT pada detik yang sama.
Skrip memeriksa jawaban melalui GET setelah ACK, bukan hanya HTTP 200.
Mode classroom dengan NAT sekolah bersifat opt-in; produksi tetap rate-limited.
