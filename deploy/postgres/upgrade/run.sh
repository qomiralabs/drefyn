#!/bin/sh
# Runs every upgrade script, in order, as the superuser over the container's local socket.
# scripts/selfhost.sh upgrade calls it; by hand:
#   docker compose -f deploy/compose.yaml exec -T postgres sh /etc/drefyn/upgrade/run.sh
# The password goes to psql through the environment, never on a command line, and each
# script is safe to run again.
set -eu

secret=/run/secrets/drefyn_auth_password
if [ ! -s "$secret" ]; then
  echo "upgrade: secret drefyn_auth_password is missing or empty: set DREFYN_AUTH_PASSWORD in deploy/.env to at least 16 random characters, then run bash scripts/selfhost.sh upgrade, which also fills in the key when it is absent" >&2
  exit 1
fi
DREFYN_AUTH_PASSWORD="$(cat "$secret")"
export DREFYN_AUTH_PASSWORD

for file in /etc/drefyn/upgrade/[0-9]*.sql; do
  psql --no-psqlrc --quiet --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-drefyn}" \
    --file "$file"
done
