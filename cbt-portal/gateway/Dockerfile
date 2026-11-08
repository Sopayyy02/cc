# Build dari root proyek:  docker build -f gateway/Dockerfile --build-arg MODE=gateway|static .
FROM nginx:1.27-alpine
ARG MODE=gateway
COPY gateway/limits.conf /etc/nginx/conf.d/00-limits.conf
COPY gateway/${MODE}.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
