#!/bin/sh
# Healthy means a client could do its job: TCP is open, the bootstrap created every role, and
# each role logs in with the password this container was given. The last part catches a
# password changed in deploy/.env but not in the database. TCP only opens once the init
# scripts have finished; a socket check alone would pass during init.
set -eu

if ! pg_isready --quiet --host 127.0.0.1 --username drefyn_app --dbname drefyn; then
  echo "postgres is not accepting TCP connections yet"
  exit 1
fi

# Docker reserves exit code 2, which psql uses for a lost connection, so every failure here
# exits 1 with a line that says what failed.
if ! missing="$(psql --no-psqlrc -qtA --username postgres --dbname drefyn -c "
  select coalesce(string_agg(r, ', '), '')
  from unnest(array['drefyn_owner', 'drefyn_app', 'drefyn_public_reader']) as r
  where r not in (select rolname from pg_roles)" 2>&1)"; then
  echo "could not query the roles over the socket: $(printf '%s\n' "$missing" | tail -n 1)"
  exit 1
fi
# An interrupted first start leaves no reason in the log, so point at the way out instead.
if [ -n "$missing" ]; then
  echo "the bootstrap did not create $missing; the first start failed or was interrupted, so run scripts/selfhost.sh reset --yes and start again"
  exit 1
fi

for role in drefyn_owner drefyn_app drefyn_public_reader; do
  secret="/run/secrets/${role}_password"
  if ! error="$(PGPASSWORD="$(cat "$secret")" psql --no-psqlrc --no-password -qtA \
    --host 127.0.0.1 --username "$role" --dbname drefyn -c 'select 1' 2>&1 >/dev/null)"; then
    # One line: docker keeps it as the health output and selfhost.sh shows the last line.
    reason="$(printf '%s\n' "$error" | tail -n 1)"
    echo "$role cannot log in with the password in $secret; changed in deploy/.env only? $reason"
    exit 1
  fi
done
