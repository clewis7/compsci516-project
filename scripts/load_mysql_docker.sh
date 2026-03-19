#!/usr/bin/env bash
set -euo pipefail

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
  docker start "${CONTAINER_NAME}" >/dev/null || true
else
  docker run --name "${CONTAINER_NAME}" \
    -e MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD}" \
    -e MYSQL_DATABASE="${DB_NAME}" \
    -p "${HOST_PORT}:3306" \
    -d mysql:8 >/dev/null
fi

echo "Waiting for MySQL..."
READY=0
for i in {1..60}; do
  if docker exec "${CONTAINER_NAME}" \
    mysqladmin ping -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "${READY}" -ne 1 ]]; then
  echo "MySQL did not become ready in time."
  echo "This can happen if an existing container uses a different root password."
  echo "Try resetting it with:"
  echo "  docker rm -f ${CONTAINER_NAME}"
  exit 1
fi

echo "Checking MySQL login..."
LOGGED_IN=0
for i in {1..60}; do
  if docker exec "${CONTAINER_NAME}" \
    mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "SELECT 1;" >/dev/null 2>&1; then
    LOGGED_IN=1
    break
  fi
  sleep 1
done

if [[ "${LOGGED_IN}" -ne 1 ]]; then
  echo "Could not log into MySQL as root."
  echo "MySQL may still be initializing, or the container may have a different password."
  echo "Try resetting it with:"
  echo "  docker rm -f ${CONTAINER_NAME}"
  exit 1
fi

echo "Ensuring database exists..."
docker exec -i "${CONTAINER_NAME}" mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" \
  -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;"

echo "Checking whether database is empty..."
TABLE_COUNT=$(docker exec -i "${CONTAINER_NAME}" mysql -N -B -uroot -p"${MYSQL_ROOT_PASSWORD}" \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';")

if [[ "${TABLE_COUNT}" -eq 0 ]]; then
  echo "Database is empty. Loading ${SQL_FILE}..."
  docker exec -i "${CONTAINER_NAME}" mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${DB_NAME}" < "${SQL_FILE}"
  echo "Import complete."
else
  echo "Database already has tables. Skipping SQL import."
fi

echo "Done."
echo "App database is ready."
echo "Connect with:"
echo "mysql -h 127.0.0.1 -P ${HOST_PORT} -u root -p${MYSQL_ROOT_PASSWORD} ${DB_NAME}"
