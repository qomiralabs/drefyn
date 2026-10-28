#!/usr/bin/env bash
# Start, stop and reset the self host compose stack.
#   up       create deploy/.env with random passwords if it is missing, then start and wait
#   down     stop and remove the containers, keep the data volume
#   restart  recreate the containers from deploy/.env and wait until healthy again
#   upgrade  add what an older volume lacks (today the drefyn_auth role), then wait
#   reset    remove the containers and the data volume (needs --yes)
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
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD|DREFYN_STACK_ID)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      # A failure inside a command substitution used as an argument would go unnoticed and
      # leave the value empty, so generate it on its own and check it.
      value="$(random_secret)"
      if [ "${#value}" -ne 48 ]; then
        say <<<"selfhost: could not generate a random value for $key; nothing was written."
        exit 1
      fi
      printf '%s=%s\n' "$key" "$value" >>"$env_tmp"
    else
      printf '%s\n' "$line" >>"$env_tmp"
    fi
  done <"$example"
  if ! grep -q '^DREFYN_STACK_ID=.' "$env_tmp" ||
    [ "$(grep -c '^DREFYN_[A-Z_]*_PASSWORD=.' "$env_tmp" || true)" -ne 5 ]; then
    say <<<"selfhost: $example does not list the stack ID and the five passwords; nothing was written."
    exit 1
  fi
  # A hard link never replaces an existing file, so when two first ups race, the first one's
  # file wins and the other uses it, rather than each starting with passwords the file lost.
  if ln "$env_tmp" "$env_file" 2>/dev/null; then
    echo "selfhost: wrote $env_file with generated passwords and a stack ID"
  elif [ -f "$env_file" ]; then
    say <<<"selfhost: $env_file appeared while this up was generating one; using the one already there"
  else
    say <<<"selfhost: could not create $env_file; nothing was written."
    exit 1
  fi
}

# A deploy/.env written before a role existed has no password for it. Append a generated one
# for each password the example lists and the file does not name at all; an empty value is
# left alone, since that is a choice the first start refuses anyway. Appending keeps the mode.
add_missing_passwords() {
  local line key value added=""
  if [ ! -f "$env_file" ] || [ ! -r "$deploy/.env.example" ]; then return; fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      if grep -q "^$key=" "$env_file"; then continue; fi
      value="$(random_secret)"
      if [ "${#value}" -ne 48 ]; then
        say <<<"selfhost: could not generate a random value for $key; deploy/.env was not changed."
        exit 1
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
  if ! "${compose[@]}" up --detach ${recreate[@]+"${recreate[@]}"} --wait --wait-timeout "$wait_seconds"; then
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
    echo "selfhost: healthy in $((end - start))s"
    return
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
    # Pull first so the healthy time measures startup, not the network.
    "${compose[@]}" pull --quiet
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
    "${compose[@]}" pull --quiet
    # Recreating copies the new secrets into the container. It cannot be healthy yet, because
    # the healthcheck logs in as the role the upgrade adds, so this waits for TCP only.
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
