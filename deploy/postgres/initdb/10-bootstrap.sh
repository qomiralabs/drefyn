#!/usr/bin/env bash
# Runs once, when the data volume is empty. The image's entrypoint calls it as the
# superuser over the local socket while the server only listens there, so nothing outside
# the container can connect before the roles exist.
set -euo pipefail

# Nothing needs the superuser over TCP: the bootstrap and operators use the socket, where
# peer ties it to the postgres OS user. Nothing replicates either, and a replication session
# copies every tenant's data. This goes first, before any check that can fail: after a failed
# first start the container restarts into a server that skips init, and it must not come up
# with these open. The first matching line wins, so the rejects go on top. The init server
# only listens on the socket, and the server that starts next reads the file fresh.
umask 077
hba="$PGDATA/pg_hba.conf"
{
  echo "# The superuser logs in over the local socket only, and nothing replicates."
  echo "host all $POSTGRES_USER all reject"
  echo "host replication all all reject"
  cat "$hba"
} >"$hba.drefyn"
mv "$hba.drefyn" "$hba"

read_secret() {
  local file="/run/secrets/$1"
  if [ ! -s "$file" ]; then
    echo "bootstrap: secret $1 is missing or empty" >&2
    exit 1
  fi
  cat "$file"
}

# The superuser skips row level security, so its password gets the same floor as the roles.
# The image has already set it by now; stopping here leaves the stack unhealthy.
postgres_password="$(read_secret postgres_password)"
if [ "${#postgres_password}" -lt 16 ]; then
  echo "bootstrap: secret postgres_password must be at least 16 characters" >&2
  exit 1
fi
unset postgres_password

DREFYN_OWNER_PASSWORD="$(read_secret drefyn_owner_password)"
DREFYN_APP_PASSWORD="$(read_secret drefyn_app_password)"
DREFYN_PUBLIC_READER_PASSWORD="$(read_secret drefyn_public_reader_password)"
export DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD DREFYN_PUBLIC_READER_PASSWORD

psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --file /etc/drefyn/bootstrap.sql
