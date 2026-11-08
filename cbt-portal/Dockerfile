# Satu Dockerfile untuk semua microservice. Pilih service lewat build arg:
#   docker build --build-arg SERVICE=auth|exam|session -t cbt-<service> .
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependency dulu supaya layer ini ter-cache selama package.json tidak berubah
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY db ./db

ARG SERVICE=auth
ENV SERVICE=${SERVICE}

# Jalankan sebagai user non-root
USER node

EXPOSE 3000

# Healthcheck memanggil GET /health (mengecek koneksi ke MySQL)
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Pembuatan tabel + data dummy TIDAK lagi di sini (agar tidak balapan antar replika):
# dijalankan sekali lewat service `db-init` (compose) / ECS task `migrate` (AWS).
CMD ["sh", "-c", "exec node src/services/$SERVICE/server.js"]
