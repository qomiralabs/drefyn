#!/bin/sh
# Healthy means a client could do its job: TCP is open, the server reads the mounted login
# rules, the bootstrap created every role, and each role logs in with the password this
# container was given. The last part catches a password changed in deploy/.env but not in the
# database. TCP only opens once the init scripts have finished; a socket check alone would
# pass during init.
#
# Docker reserves exit code 2, which psql uses for a lost connection, so every failure here
# exits 1 with one line that says what failed. Nothing is written to disk, since docker kills
# a check that times out and no cleanup would run.
set -eu

if ! pg_isready --quiet --host 127.0.0.1 --username drefyn_app --dbname drefyn; then
  echo "postgres is not accepting TCP connections yet"
  exit 1
fi

# One query: the login rules file, whether the bootstrap ran (it creates schema app in the same
# transaction as the roles), and any role that is missing. Warnings at connect time, such as a
# collation version mismatch after a base image change, stay out of the result.
query="select current_setting('hba_file') || '|'
  || (exists (select from pg_namespace where nspname = 'app'))::text || '|'
  || coalesce((select string_agg(r, ',' order by r)
    from unnest(array['drefyn_owner', 'drefyn_app', 'drefyn_public_reader']) as r
    where r not in (select rolname from pg_roles)), '')"
run_query() {
  PGOPTIONS='-c client_min_messages=error' psql --no-psqlrc -qtA --username postgres \
    --dbname drefyn -c "$query"
}
if ! result="$(run_query 2>/dev/null)"; then
  # Run it again for the reason only, so stderr never needs a file.
  reason="$(run_query 2>&1 >/dev/null | tail -n 1 || true)"
  case "$reason" in
    *'database "drefyn" does not exist'*)
      echo "database drefyn does not exist, so the first start was interrupted before it was created: run scripts/selfhost.sh reset --yes and up again"
      ;;
    *) echo "could not query the server over the socket: $reason" ;;
  esac
  exit 1
fi
hba="${result%%|*}"
rest="${result#*|}"
bootstrapped="${rest%%|*}"
missing="${rest#*|}"

# A compose override that replaces the command drops hba_file, and the server falls back to the
# data directory's rules, which let the superuser in over TCP with its password.
if [ "$hba" != /etc/drefyn/pg_hba.conf ]; then
  echo "the server reads its login rules from $hba, not /etc/drefyn/pg_hba.conf: keep -c hba_file=/etc/drefyn/pg_hba.conf in the compose command"
  exit 1
fi

for role in $(printf '%s' "$missing" | tr ',' ' '); do
  case "$role" in
    drefyn_owner | drefyn_app | drefyn_public_reader) ;;
    *)
      echo "the role query returned something unexpected: $result"
      exit 1
      ;;
  esac
done
if [ -n "$missing" ]; then
  # Schema app comes from the same transaction as the roles, so if it exists the bootstrap
  # ran and the data is real: someone renamed or dropped the role since.
  if [ "$bootstrapped" = true ]; then
    echo "role $missing is missing although the bootstrap ran, so it was renamed or dropped since: put it back as the superuser; the data is still there"
    exit 1
  fi
  # Otherwise the first start failed or was interrupted, and the volume holds nothing.
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
