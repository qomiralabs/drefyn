#!/usr/bin/env bash
# Runs once, when the data volume is empty. The image's entrypoint calls it as the
# superuser over the local socket while the server only listens there, so nothing outside
# the container can connect before the roles exist.
set -euo pipefail

read_secret() {
  local file="/run/secrets/$1"
  if [ ! -s "$file" ]; then
    echo "bootstrap: secret $1 is missing or empty" >&2
    exit 1
  fi
  cat "$file"
}

DREFYN_OWNER_PASSWORD="$(read_secret drefyn_owner_password)"
DREFYN_APP_PASSWORD="$(read_secret drefyn_app_password)"
DREFYN_PUBLIC_READER_PASSWORD="$(read_secret drefyn_public_reader_password)"
export DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD DREFYN_PUBLIC_READER_PASSWORD

psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --file /etc/drefyn/bootstrap.sql
