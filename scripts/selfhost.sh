#!/usr/bin/env bash
# Start, stop and reset the self host compose stack.
#   up       create deploy/.env with random passwords if it is missing, then start and wait
#   down     stop and remove the containers, keep the data volume
#   restart  recreate the containers from deploy/.env and wait until healthy again
#   upgrade  add what an older volume lacks (roles added since it was made), then wait
#   reset    remove the containers and the data volume (needs --yes)
# COMPOSE_PROFILES=parse, in the shell or in deploy/.env, adds the parse host to every command.
set -euo pipefail

# shellcheck source=scripts/selfhost-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-lib.sh"
deploy="$selfhost_root/deploy"
env_file="$deploy/.env"
# Generous enough for a cold first init on a slow laptop; a clean CI runner is far faster.
wait_seconds="${DREFYN_SELFHOST_WAIT_SECONDS:-90}"

env_tmp=""
trap 'if [ -n "$env_tmp" ]; then rm -f "$env_tmp"; fi' EXIT

usage() {
  echo "usage: $0 up | down | restart | upgrade | reset --yes" >&2
  exit 64
}

random_secret() {
  # 24 random bytes as hex: no characters that need quoting in .env or a connection URL.
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

# The auth keys: exactly 32 random bytes in unpadded base64url, the one spelling the
# dashboard accepts. 43 characters, none that need quoting.
random_key() {
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

# The keys the installer generates once. The invitation block key is never rotated with
# DREFYN_AUTH_SECRET: blocks are stored as an HMAC under it, so a new one lifts them all.
# The second factor keyring is a list of <id>:<key>, so it starts as one entry. Its id only
# has to differ from the ids an operator adds later, and random hex does.
# The search admin key is Typesense's own and has the same shape as the auth keys.
KEY_NAMES='DREFYN_AUTH_SECRET|DREFYN_AUTH_INVITATION_BLOCK_KEY|DREFYN_API_RATE_LIMIT_KEY|DREFYN_AUTH_TOTP_KEYS|DREFYN_SEARCH_ADMIN_KEY'

# The app tier sends the token and the parse host keeps only its hash, so a taken host holds
# nothing a stranger could use. Both go in deploy/.env; compose hands the host the hash alone.
PARSE_TOKEN=DREFYN_PARSE_HOST_TOKEN
PARSE_HASH=DREFYN_PARSE_TOKEN_SHA256

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

# parse_hash_line <file>: the hash line for the token the file holds, or nothing when it holds
# none. A failed hash must not write an empty value that reads as set.
parse_hash_line() {
  local token hash
  token="$(sed -n "s/^$PARSE_TOKEN=//p" "$1" | tail -n 1)"
  if [ -z "$token" ]; then return 0; fi
  hash="$(printf '%s' "$token" | sha256_hex)"
  if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then return 1; fi
  printf '%s=%s\n' "$PARSE_HASH" "$hash"
}

# generated_value <key>: a fresh value of the right shape for that key, checked, on stdout.
generated_value() {
  local value want=48
  if [ "$1" = DREFYN_AUTH_TOTP_KEYS ]; then
    value="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'):$(random_key)"
    want=52
  elif [ "$1" = "$PARSE_TOKEN" ]; then
    value="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    want=64
  elif [[ "$1" =~ ^($KEY_NAMES)$ ]]; then
    value="$(random_key)"
    want=43
  else
    value="$(random_secret)"
  fi
  if [ "${#value}" -ne "$want" ]; then return 1; fi
  printf '%s' "$value"
}

# Called on its own line, never on the left of && or ||, so set -e stays on inside it and any
# failure here stops the script before the guard and before compose.
ensure_env() {
  if [ -f "$env_file" ]; then return; fi
  local line key value example="$deploy/.env.example"
  # bash 3.2 carries on past a while loop whose input file is missing, which would write an
  # empty deploy/.env and claim it holds passwords.
  if [ ! -r "$example" ] || [ ! -s "$example" ]; then
    say <<<"selfhost: $example is missing, unreadable or empty, so deploy/.env cannot be generated; nothing was written."
    exit 1
  fi
  env_tmp="$(mktemp "$deploy/.env.XXXXXX")"
  chmod 600 "$env_tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD|DREFYN_STACK_ID|$KEY_NAMES|$PARSE_TOKEN)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      # A failure inside a command substitution used as an argument would go unnoticed and
      # leave the value empty, so generate it on its own and check it.
      if ! value="$(generated_value "$key")"; then
        say <<<"selfhost: could not generate a random value for $key; nothing was written."
        exit 1
      fi
      printf '%s=%s\n' "$key" "$value" >>"$env_tmp"
    elif [ "$line" = "$PARSE_HASH=" ]; then
      # The example lists the token first, so its value is already in the file.
      if ! value="$(parse_hash_line "$env_tmp")" || [ -z "$value" ]; then
        say <<<"selfhost: could not hash the parse host token; nothing was written."
        exit 1
      fi
      printf '%s\n' "$value" >>"$env_tmp"
    else
      printf '%s\n' "$line" >>"$env_tmp"
    fi
  done <"$example"
  if ! grep -q '^DREFYN_STACK_ID=.' "$env_tmp" ||
    [ "$(grep -c '^DREFYN_[A-Z_]*_PASSWORD=.' "$env_tmp" || true)" -ne 6 ] ||
    [ "$(grep -cE "^($KEY_NAMES)=." "$env_tmp" || true)" -ne 5 ] ||
    ! grep -q "^$PARSE_TOKEN=." "$env_tmp" || ! grep -q "^$PARSE_HASH=." "$env_tmp"; then
    say <<<"selfhost: $example does not list the stack ID, the six passwords, the five generated keys and the parse host token and hash; nothing was written."
    exit 1
  fi
  # A hard link never replaces an existing file, so when two first ups race, the first one's
  # file wins and the other uses it, rather than each starting with passwords the file lost.
  if ln "$env_tmp" "$env_file" 2>/dev/null; then
    echo "selfhost: wrote $env_file with generated passwords, auth keys, a parse host token and a stack ID"
  elif [ -f "$env_file" ]; then
    say <<<"selfhost: $env_file appeared while this up was generating one; using the one already there"
  else
    say <<<"selfhost: could not create $env_file; nothing was written."
    exit 1
  fi
}

# A deploy/.env written before a role or key existed has no value for it. Append a generated
# one for each password or auth key the example lists and the file does not name at all; an
# empty value is left alone, since that is a choice the first start refuses anyway. A key
# already there is never replaced. Appending keeps the mode.
add_missing_passwords() {
  local line key value added=""
  if [ ! -f "$env_file" ] || [ ! -r "$deploy/.env.example" ]; then return; fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD|$KEY_NAMES|$PARSE_TOKEN|$PARSE_HASH)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      if grep -q "^$key=" "$env_file"; then continue; fi
      # A new token beside an existing hash would never match it.
      if [ "$key" = "$PARSE_TOKEN" ] && grep -q "^$PARSE_HASH=" "$env_file"; then continue; fi
      if [ "$key" = "$PARSE_HASH" ]; then
        # Only ever the hash of the token in the file. An operator who removed the token and
        # set the hash alone keeps that choice.
        if ! value="$(parse_hash_line "$env_file")"; then
          say <<<"selfhost: could not hash the parse host token; deploy/.env was not changed."
          exit 1
        fi
        if [ -z "$value" ]; then continue; fi
        value="${value#*=}"
      elif ! value="$(generated_value "$key")"; then
        say <<<"selfhost: could not generate a random value for $key; deploy/.env was not changed."
        exit 1
      fi
      # A hand written file may end without a newline; the key must not join its last value.
      if [ -z "$added" ] && [ -s "$env_file" ] && [ -n "$(tail -c1 "$env_file")" ]; then
        printf '\n' >>"$env_file"
      fi
      printf '%s=%s\n' "$key" "$value" >>"$env_file"
      added+=" $key"
    fi
  done <"$deploy/.env.example"
  if [ -n "$added" ]; then echo "selfhost: added a generated${added} to $env_file"; fi
}

# A hand written .env gets the umask default, which is usually readable by everyone.
warn_env_mode() {
  local open
  if [ ! -f "$env_file" ]; then return; fi
  open="$(find "$env_file" -prune \( -perm -040 -o -perm -004 -o -perm -020 -o -perm -002 \) -print)"
  if [ -n "$open" ]; then
    say <<<"selfhost: warning: $env_file can be read or written by other users; run chmod 600 on it"
  fi
}

# Recreating, not just restarting, is what makes compose copy the passwords from deploy/.env
# into the container again. The healthcheck then logs in as every role, so a password that
# changed in deploy/.env but not in the database fails here instead of looking healthy.
# wait_healthy [keep]: keep waits on the running container instead of recreating it.
wait_healthy() {
  local start end compose_ok=true ids count state health status restarting problem="" first
  local recreate=(--force-recreate)
  if [ "${1:-}" = keep ]; then recreate=(); fi
  start="$(date +%s)"
  # --build only touches the parse host, the one image built here, so a pulled checkout never
  # runs an older build of it. Without its profile there is nothing to build.
  if ! "${compose[@]}" up --detach --build ${recreate[@]+"${recreate[@]}"} --wait --wait-timeout "$wait_seconds"; then
    compose_ok=false
  fi
  end="$(date +%s)"
  # Compose has returned success from up --wait at the timeout while the container was still
  # restarting after a failed init, so its exit code is not proof. Only docker's own health
  # status for exactly one running postgres container is.
  ids="$("${compose[@]}" ps -aq postgres 2>/dev/null || true)"
  count="$(grep -c . <<<"$ids" || true)"
  health=""
  status=""
  restarting=""
  if [ "$count" != 1 ]; then
    problem="found $count postgres containers in project '$selfhost_project', expected one"
  elif ! state="$(docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Status}} {{.State.Restarting}}' \
    "$ids" 2>&1)"; then
    problem="could not inspect container $ids: $(tail -n 1 <<<"$state")"
  else
    read -r health status restarting <<<"$state"
  fi
  if [ "$compose_ok" = true ] && [ -z "$problem" ] &&
    [ "$health $status $restarting" = "healthy running false" ]; then
    wait_parse_healthy
    echo "selfhost: healthy in $((end - start))s"
    return
  fi

  # Postgres is fine, so compose more likely gave up on the parse host; say so if it did.
  if [ -z "$problem" ] && [ "$health $status $restarting" = "healthy running false" ]; then
    wait_parse_healthy
  fi

  # A port clash or a name conflict fails at once and leaves no started container, so say
  # compose failed rather than blame health. Its own error is then the last thing it printed.
  if [ "$compose_ok" = false ] && { [ "$count" = 0 ] || [ "$status" = created ]; }; then
    say <<<"selfhost: compose could not start postgres ($((end - start))s); its error is above."
  elif [ -n "$problem" ]; then
    say <<<"selfhost: postgres is not healthy after $((end - start))s: $problem"
  else
    say <<<"selfhost: postgres is not healthy after $((end - start))s: $(health_output "$ids")"
    first="$(first_start_failure "$ids")"
    if [ -n "$first" ]; then say <<<"selfhost: $first"; fi
  fi
  say <<<"The server log may say more: docker compose -p $selfhost_project -f $compose_file logs postgres"
  exit 1
}

# With its profile on, the parse host must be healthy too, by the same standard as postgres.
wait_parse_healthy() {
  local ids count state
  if ! "${compose[@]}" config --services 2>/dev/null | grep -qx parse-host; then return; fi
  ids="$("${compose[@]}" ps -aq parse-host 2>/dev/null || true)"
  count="$(grep -c . <<<"$ids" || true)"
  if [ "$count" = 1 ] &&
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}} {{.State.Status}}' "$ids" 2>/dev/null)" &&
    [ "$state" = "healthy running" ]; then
    return
  fi
  say <<<"selfhost: the parse host is not healthy (${state:-found $count containers}). Its log says why: docker compose -p $selfhost_project -f $compose_file logs parse-host"
  exit 1
}

# The upgrade scripts run as the superuser over the local socket, so they need the server out of
# its first start init, which only ever listens on the socket. TCP opens after init.
wait_tcp() {
  local deadline
  deadline=$(($(date +%s) + wait_seconds))
  until "${compose[@]}" exec -T postgres pg_isready --quiet --host 127.0.0.1 \
    --username drefyn_owner --dbname drefyn >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      say <<<"selfhost: postgres did not accept TCP connections within ${wait_seconds}s; nothing was upgraded. The server log may say more: docker compose -p $selfhost_project -f $compose_file logs postgres"
      exit 1
    fi
    sleep 1
  done
}

case "${1:-}" in
  # up writes deploy/.env first, because the stack ID the guard compares lives there. Two
  # statements, not &&, so a failure in ensure_env stops the script instead of skipping the guard.
  up | upgrade)
    ensure_env
    add_missing_passwords
    guard_project "$1"
    ;;
  down | restart | reset) guard_project "$1" ;;
  *) usage ;;
esac

case "$1" in
  up)
    warn_env_mode
    # Pull first so the healthy time measures startup, not the network. Images this checkout
    # builds, the API and the parse host under their profiles, are built by up instead.
    "${compose[@]}" pull --quiet --ignore-buildable
    wait_healthy
    ;;
  down)
    "${compose[@]}" down
    ;;
  restart)
    warn_env_mode
    wait_healthy
    ;;
  upgrade)
    warn_env_mode
    "${compose[@]}" pull --quiet --ignore-buildable
    # Recreating copies the new secrets into the container. It cannot be healthy yet, because
    # the healthcheck logs in as the roles the upgrade adds, so this waits for TCP only.
    "${compose[@]}" up --detach --force-recreate
    wait_tcp
    if ! "${compose[@]}" exec -T postgres sh /etc/drefyn/upgrade/run.sh; then
      say <<<"selfhost: the upgrade stopped; its reason is above. Nothing after the failed step ran."
      exit 1
    fi
    # The same container, so its log still shows the upgrade.
    wait_healthy keep
    ;;
  reset)
    if [ "${2:-}" != "--yes" ]; then
      echo "selfhost: reset deletes the database volume; run '$0 reset --yes' to confirm" >&2
      exit 1
    fi
    "${compose[@]}" down --volumes
    ;;
esac
