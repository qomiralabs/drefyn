#!/bin/sh
# Healthy means a client could do its job: TCP is open, the bootstrap created every role, and
# each role logs in with the password this container was given. The last part catches a
# password changed in deploy/.env but not in the database. TCP only opens once the init
# scripts have finished; a socket check alone would pass during init.
#
# Docker reserves exit code 2, which psql uses for a lost connection, so every failure here
# exits 1 with one line that says what failed.
set -eu

if ! pg_isready --quiet --host 127.0.0.1 --username drefyn_app --dbname drefyn; then
  echo "postgres is not accepting TCP connections yet"
  exit 1
fi

# Warnings at connect time, such as a collation version mismatch after a base image change,
# are not a reason to be unhealthy. Keep them out of the result, and keep stderr apart so
# only a real role list can lead to the advice to reset.
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
if ! missing="$(PGOPTIONS='-c client_min_messages=error' psql --no-psqlrc -qtA \
  --username postgres --dbname drefyn -c "
  select coalesce(string_agg(r, ',' order by r), '')
  from unnest(array['drefyn_owner', 'drefyn_app', 'drefyn_public_reader']) as r
  where r not in (select rolname from pg_roles)" 2>"$errors")"; then
  echo "could not query the roles over the socket: $(tail -n 1 "$errors")"
  exit 1
fi
for role in $(printf '%s' "$missing" | tr ',' ' '); do
  case "$role" in
    drefyn_owner | drefyn_app | drefyn_public_reader) ;;
    *)
      echo "the role query returned something unexpected: $missing"
      exit 1
      ;;
  esac
done
# Only a failed or interrupted first start leaves roles missing, and the data volume then
# holds nothing worth keeping.
if [ -n "$missing" ]; then
  echo "the bootstrap did not create $missing, so the first start failed or was interrupted: fix deploy/.env if the server log shows a rejected password, then run scripts/selfhost.sh reset --yes and up again"
  exit 1
fi

for role in drefyn_owner drefyn_app drefyn_public_reader; do
  secret="/run/secrets/${role}_password"
  if ! error="$(PGOPTIONS='-c client_min_messages=error' PGPASSWORD="$(cat "$secret")" \
    psql --no-psqlrc --no-password -qtA \
    --host 127.0.0.1 --username "$role" --dbname drefyn -c 'select 1' 2>&1 >/dev/null)"; then
    # One line: docker keeps it as the health output and selfhost.sh shows the last line.
    reason="$(printf '%s\n' "$error" | tail -n 1)"
    echo "$role cannot log in with the password in $secret; changed in deploy/.env only? $reason"
    exit 1
  fi
done
