#!/bin/sh
# Builds the connection URLs and the failure limiter key from compose secrets, so no password
# shows up in docker inspect. A value already in the environment wins, so a plain docker run
# with its own URLs still works.
set -eu

secret() {
  if [ -r "/run/secrets/$1" ]; then cat "/run/secrets/$1"; fi
}

# The URL carries the password as it is, so only characters that need no escaping are taken.
# The installer generates hex.
url_safe() {
  case "$1" in
    *[!A-Za-z0-9._~-]*)
      echo "api: $2 holds characters a connection URL would need escaped; use letters, digits and . _ ~ - only" >&2
      exit 1
      ;;
  esac
}

host="${DREFYN_DATABASE_HOST:-postgres}"
database="${DREFYN_DATABASE_NAME:-drefyn}"

if [ -z "${DREFYN_DATABASE_URL:-}" ]; then
  password="$(secret drefyn_app_password)"
  if [ -n "$password" ]; then
    url_safe "$password" DREFYN_APP_PASSWORD
    DREFYN_DATABASE_URL="postgres://drefyn_app:${password}@${host}:5432/${database}"
    export DREFYN_DATABASE_URL
  fi
fi

if [ -z "${DREFYN_PUBLIC_READER_DATABASE_URL:-}" ]; then
  password="$(secret drefyn_public_reader_password)"
  if [ -n "$password" ]; then
    url_safe "$password" DREFYN_PUBLIC_READER_PASSWORD
    DREFYN_PUBLIC_READER_DATABASE_URL="postgres://drefyn_public_reader:${password}@${host}:5432/${database}"
    export DREFYN_PUBLIC_READER_DATABASE_URL
  fi
fi

if [ -z "${DREFYN_API_RATE_LIMIT_KEY:-}" ]; then
  key="$(secret drefyn_api_rate_limit_key)"
  if [ -n "$key" ]; then
    DREFYN_API_RATE_LIMIT_KEY="$key"
    export DREFYN_API_RATE_LIMIT_KEY
  fi
fi

unset password key
exec node /app/apps/api/server.ts
