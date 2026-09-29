#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "ОШИБКА: Docker CLI не найден. Установите Docker Desktop или Docker Engine." >&2
  exit 1
fi

if ! docker version >/dev/null 2>&1; then
  echo "ОШИБКА: Docker daemon недоступен. Запустите Docker Desktop или Docker Engine." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  echo "ОШИБКА: Docker Compose не найден." >&2
  exit 1
fi

node scripts/check-certificates.js

verify_env=${ENV_FILE:-.env.example}
ENV_FILE="$verify_env" dc config >/dev/null

started_at=$(date +%s)
ENV_FILE="$verify_env" dc build --no-cache app
finished_at=$(date +%s)
echo "Холодная сборка без учёта загрузки базового образа: $((finished_at - started_at)) с"

image_id=$(ENV_FILE="$verify_env" dc images -q app)
if [ -z "$image_id" ]; then
  echo "ОШИБКА: не удалось определить собранный образ." >&2
  exit 1
fi

container_user=$(docker image inspect --format '{{.Config.User}}' "$image_id")
if [ "$container_user" != "node" ]; then
  echo "ОШИБКА: контейнер запускается не от пользователя node: $container_user" >&2
  exit 1
fi

docker run --rm \
  -e NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_ca.pem \
  --entrypoint node "$image_id" \
  -e "fetch('https://platform-api2.max.ru/me').then(r=>{console.log('MAX TLS: HTTP '+r.status);process.exit([401,403].includes(r.status)?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"

if [ ! -f .env ] || ! grep -Eq '^BOT_TOKEN=.+$' .env; then
  echo "Образ, Compose, non-root и TLS проверены. Live healthcheck пропущен: в .env нет BOT_TOKEN."
  exit 0
fi

dc up -d app
attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(dc ps -q app)")
  if [ "$status" = "healthy" ]; then
    echo "Контейнер app здоров. Проверка завершена."
    exit 0
  fi
  if [ "$status" = "unhealthy" ]; then
    dc logs --tail=100 app
    echo "ОШИБКА: контейнер app перешёл в unhealthy." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done

dc logs --tail=100 app
echo "ОШИБКА: healthcheck не стал healthy за 60 секунд." >&2
exit 1
