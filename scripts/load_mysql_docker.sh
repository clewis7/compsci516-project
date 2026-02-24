#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/load_mysql_docker.sh path/to/book_data.sql
#
# Optional env vars:
#   DB_NAME=books
#   MYSQL_ROOT_PASSWORD=root
#   CONTAINER_NAME=books-mysql
#   HOST_PORT=3306

SQL_FILE="${1:-}"
if [[ -z "${SQL_FILE}" ]]; then
  echo "Missing SQL file path."
  echo "Usage: $0 path/to/book_data.sql"
  exit 1
fi

if [[ ! -f "${SQL_FILE}" ]]; then
  echo "File not found: ${SQL_FILE}"
  exit 1
fi

DB_NAME="${DB_NAME:-books}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root}"
CONTAINER_NAME="${CONTAINER_NAME:-books-mysql}"
HOST_PORT="${HOST_PORT:-3306}"

echo "Starting MySQL container..."

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker start "${CONTAINER_NAME}" >/dev/null
else
  docker run --name "${CONTAINER_NAME}" \
    -e MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD}" \
    -e MYSQL_DATABASE="${DB_NAME}" \
    -p "${HOST_PORT}:3306" \
    -d mysql:8 >/dev/null
fi

echo "Waiting for MySQL..."
for i in {1..60}; do
  if docker exec "${CONTAINER_NAME}" mysqladmin ping -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Ensuring database exists..."
docker exec -i "${CONTAINER_NAME}" mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" \
  -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;"

echo "Loading ${SQL_FILE}..."
docker exec -i "${CONTAINER_NAME}" mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${DB_NAME}" < "${SQL_FILE}"

echo "Done."
echo "Connect with:"
echo "mysql -h 127.0.0.1 -P ${HOST_PORT} -u root -p${MYSQL_ROOT_PASSWORD} ${DB_NAME}"
