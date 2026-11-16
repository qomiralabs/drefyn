#!/bin/sh
# Runs every upgrade script, in order, as the superuser over the container's local socket.
# scripts/selfhost.sh upgrade calls it; by hand:
#   docker compose -f deploy/compose.yaml exec -T postgres sh /etc/drefyn/upgrade/run.sh
# The password goes to psql through the environment, never on a command line, and each
# script is safe to run again.
set -eu

# read_secret <name> <key>: the secret's value, or a stop that names the deploy/.env key.
read_secret() {
  if [ ! -s "/run/secrets/$1" ]; then
    echo "upgrade: secret $1 is missing or empty: set $2 in deploy/.env to at least 16 random characters, then run bash scripts/selfhost.sh upgrade, which also fills in the key when it is absent" >&2
    exit 1
  fi
  cat "/run/secrets/$1"
}
DREFYN_AUTH_PASSWORD="$(read_secret drefyn_auth_password DREFYN_AUTH_PASSWORD)"
DREFYN_PROTECTED_READER_PASSWORD="$(read_secret drefyn_protected_reader_password \
  DREFYN_PROTECTED_READER_PASSWORD)"
export DREFYN_AUTH_PASSWORD DREFYN_PROTECTED_READER_PASSWORD

for file in /etc/drefyn/upgrade/[0-9]*.sql; do
  psql --no-psqlrc --quiet --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-drefyn}" \
    --file "$file"
done
