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

missing="$(psql --no-psqlrc -qtA --username postgres --dbname drefyn -c "
  select coalesce(string_agg(r, ', '), '')
  from unnest(array['drefyn_owner', 'drefyn_app', 'drefyn_public_reader']) as r
  where r not in (select rolname from pg_roles)")"
if [ -n "$missing" ]; then
  echo "the bootstrap did not create $missing; the server log says why"
  exit 1
fi

for role in drefyn_owner drefyn_app drefyn_public_reader; do
  secret="/run/secrets/${role}_password"
  if ! error="$(PGPASSWORD="$(cat "$secret")" psql --no-psqlrc -qtA --host 127.0.0.1 \
    --username "$role" --dbname drefyn -c 'select 1' 2>&1 >/dev/null)"; then
    # One line: docker keeps it as the health output and selfhost.sh shows the last line.
    reason="$(printf '%s\n' "$error" | tail -n 1)"
    echo "$role cannot log in with the password in $secret; changed in deploy/.env only? $reason"
    exit 1
  fi
done
