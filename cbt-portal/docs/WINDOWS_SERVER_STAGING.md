# Windows Server: Instalasi CBT Portal untuk Staging

Repo: https://github.com/Sopayyy02/cc — gunakan hanya akun dan data dummy sebelum produksi.

**Docker Desktop tidak didukung di Windows Server**. Jalankan Ubuntu Server 24.04 LTS di Hyper-V dengan Docker Engine. Jika Windows Server ini sendiri VPS/VM, pastikan nested virtualization tersedia dari provider. Alternatif WSL2 di Windows Server 2022/2025 memerlukan pengaturan autostart/routing sendiri.

## 1. Host Windows Server (PowerShell Administrator)

Periksa OS dan adaptornya:

~~~powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsArchitecture
Get-NetAdapter | Where-Object Status -eq "Up"
~~~

Aktifkan Hyper-V; perintah berikut **me-restart** Windows Server, jadi pastikan tidak mengganggu layanan/RDP:

~~~powershell
Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart
~~~

Di Hyper-V Manager, buat **External Virtual Switch** dari NIC LAN aktif (dapat mengganggu RDP; gunakan akses konsol bila memungkinkan). Buat VM Generation 2: Ubuntu Server 24.04 LTS, 4–8 vCPU, RAM 8–16 GiB, VHDX dinamis 80+ GiB, jaringan External Switch. Pada Generation 2, pilih Secure Boot template **Microsoft UEFI Certificate Authority** jika diperlukan oleh Ubuntu. Aktifkan SSH saat instalasi Ubuntu. ISO: https://ubuntu.com/download/server.

## 2. Terminal Ubuntu VM: Docker Engine + Compose

~~~bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git openssl nano nodejs npm
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
~~~

Gunakan perintah Docker dengan sudo; grup docker mempunyai kewenangan setara root. Petunjuk resmi: https://docs.docker.com/engine/install/ubuntu/

## 3. Clone repository + konfigurasi dummy

~~~bash
git clone https://github.com/Sopayyy02/cc.git
cd cc/cbt-portal
cp .env.example .env
chmod 600 .env
nano .env
~~~

Ubah/isi semua variabel yang masih bertanda GANTI_. Nilai minimum penting:

~~~dotenv
APP_PORT=3000
APP_BIND_IP=0.0.0.0
SESSION_SECRET=PAKAI_OPENSSL_RAND_HEX_32
INTERNAL_TOKEN=PAKAI_OPENSSL_RAND_HEX_32_YANG_LAIN
DB_NAME=cbt_portal
DB_USER=cbt_user
DB_PASSWORD=PASSWORD_DB_ACAK
MYSQL_DATABASE=cbt_portal
MYSQL_USER=cbt_user
MYSQL_PASSWORD=PASSWORD_DB_ACAK
MYSQL_ROOT_PASSWORD=PASSWORD_ROOT_ACAK_BERBEDA
LOADTEST_STUDENTS=1000
GRAFANA_ADMIN_PASSWORD=PASSWORD_GRAFANA_ACAK
~~~

Jalankan 'openssl rand -hex 32' untuk mendapatkan string rahasia, dan tempel nilainya di file .env. DB_PASSWORD dan MYSQL_PASSWORD harus **sama**; nilai ROOT harus berbeda. APP_BIND_IP=0.0.0.0 diperlukan untuk mengakses web dari LAN; **batasi ke jaringan privat**, jangan buka akses publik dengan kredensial dummy.

## 4. Web + MySQL + Grafana

~~~bash
sudo docker compose -f docker-compose.yml -f docker-compose.observability.yml config --quiet
sudo docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d --build
sudo docker compose -f docker-compose.yml -f docker-compose.observability.yml run --rm db-init
sudo docker compose -f docker-compose.yml -f docker-compose.observability.yml ps
curl -i http://127.0.0.1:3000/healthz
hostname -I
~~~

Dari browser Windows Server/PC LAN, buka **http://IP_VM_UBUNTU:3000**. Login dummy: NIM **2024001**, password **password123**.

Batasi firewall Ubuntu ke subnet yang Anda kontrol (contoh saja, sesuaikan subnet):

~~~bash
sudo ufw allow OpenSSH
sudo ufw allow from 192.168.10.0/24 to any port 3000 proto tcp
sudo ufw enable
sudo ufw status
~~~

**Grafana** (3001) dan **Prometheus** (9090) hanya bind ke loopback di Ubuntu VM, sesuai Compose. Agar bisa dibuka pada Windows Server, jalankan tunnel SSH ini di PowerShell Windows Server:

~~~powershell
ssh -N -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 USER_UBUNTU@IP_VM_UBUNTU
~~~

Selama SSH aktif, buka http://localhost:3001 di browser Windows dan login admin dengan GRAFANA_ADMIN_PASSWORD. Import dashboard k6 Grafana ID 19665.

## 5. Test autosave 1.000 jawaban

Di Ubuntu VM, mulai dari tes Node dengan 1.000 PUT dan readback (beban lebih kecil daripada 1.000 VU k6):

~~~bash
cd ~/cc/cbt-portal
node loadtest/node-burst-1000.js
cat loadtest/results/node-burst-summary.json
sudo docker stats --no-stream
~~~

Untuk mode stress, jalankan service dengan override yang disediakan repo:

~~~bash
sudo docker compose -f docker-compose.yml -f docker-compose.stress.yml -f docker-compose.observability.yml up -d --build --scale auth-service=2 --scale session-service=3 --scale exam-service=1
sudo docker compose -f docker-compose.yml -f docker-compose.stress.yml run --rm db-init
~~~

Instal Grafana k6 di Ubuntu:

~~~bash
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install -y k6
mkdir -p loadtest/results
BURST_AT="$(date -u -d '+7 minutes' '+%Y-%m-%dT%H:%M:%SZ')"
export K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:9090/api/v1/write
export K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),avg,max'
k6 run -o experimental-prometheus-rw -e USERS=1000 -e BURST_AT="$BURST_AT" -e BOOTSTRAP_SPREAD_SEC=90 --summary-export=loadtest/results/burst-summary.json loadtest/k6-burst-1000.js
~~~

Hasil yang dibutuhkan untuk lulus: **1000/1000 ACK** dan **1000/1000 readback** pada MySQL, p95/p99 masuk batas target, error rate terpantau. Menguji dari generator k6 di komputer berbeda akan menghasilkan data lebih representatif.

Jika mengulang pengujian pada data dummy terisolasi, reset sesi ujian hanya akun LT dengan:

~~~bash
sudo node scripts/reset-loadtest.js
~~~

Jangan gunakan docker compose down -v, yang akan **menghapus volume MySQL**. Stop tanpa menghapus volume:

~~~bash
sudo docker compose -f docker-compose.yml -f docker-compose.stress.yml -f docker-compose.observability.yml down
~~~

## 6. Alternatif WSL2

Windows Server 2022/2025 juga mendukung instalasi Ubuntu WSL2: jalankan 'wsl.exe --install' dari PowerShell Administrator, restart, lalu instal Docker Engine *di distro Ubuntu* (bukan Docker Desktop). Untuk web yang harus dijangkau LAN dan berjalan 24/7, lebih aman menggunakan Hyper-V VM.

Referensi resmi: https://learn.microsoft.com/windows/wsl/install-on-server

**Cloudflare Quick Tunnel hanya untuk preview interaktif**, bukan uji 1.000 pengiriman simultan. Jangan mempublikasikan data dummy lewat tunnel tanpa pengamanan tambahan.
