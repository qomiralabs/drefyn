#!/usr/bin/env bash
# Start, stop and reset the self host compose stack.
#   up       create deploy/.env with random passwords if it is missing, then start and wait
#   down     stop and remove the containers, keep the data volume
#   restart  recreate the containers from deploy/.env and wait until healthy again
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
  echo "usage: $0 up | down | restart | reset --yes" >&2
  exit 64
}

random_secret() {
  # 24 random bytes as hex: no characters that need quoting in .env or a connection URL.
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_env() {
  if [ -f "$env_file" ]; then return; fi
  local line key
  env_tmp="$(mktemp "$deploy/.env.XXXXXX")"
  chmod 600 "$env_tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD|DREFYN_STACK_ID)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      printf '%s=%s\n' "$key" "$(random_secret)" >>"$env_tmp"
    else
      printf '%s\n' "$line" >>"$env_tmp"
    fi
  done <"$deploy/.env.example"
  mv "$env_tmp" "$env_file"
  env_tmp=""
  echo "selfhost: wrote $env_file with generated passwords and a stack ID"
}

# A hand written .env gets the umask default, which is usually readable by everyone.
warn_env_mode() {
  if [ -f "$env_file" ] && [ -n "$(find "$env_file" -prune \
    \( -perm -040 -o -perm -004 -o -perm -020 -o -perm -002 \) -print)" ]; then
    say <<<"selfhost: warning: $env_file can be read or written by other users; run chmod 600 on it"
  fi
}

# Recreating, not just restarting, is what makes compose copy the passwords from deploy/.env
# into the container again. The healthcheck then logs in as every role, so a password that
# changed in deploy/.env but not in the database fails here instead of looking healthy.
wait_healthy() {
  local start end container health
  start="$(date +%s)"
  if ! "${compose[@]}" up --detach --force-recreate --wait --wait-timeout "$wait_seconds"; then
    end="$(date +%s)"
    container="$("${compose[@]}" ps -aq postgres 2>/dev/null || true)"
    health=""
    if [ -n "$container" ]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$container" 2>/dev/null || true)"
    fi
    # A port clash or a name conflict fails at once, before the healthcheck ever ran, so say
    # so rather than blame health.
    if [ "$health" = starting ] || [ "$health" = unhealthy ]; then
      say <<<"selfhost: postgres is not healthy after $((end - start))s: $(health_output "$container")"
    else
      say <<<"selfhost: compose could not start postgres ($((end - start))s); its error is above."
    fi
    say <<<"The server log may say more: docker compose -p $selfhost_project -f $compose_file logs postgres"
    exit 1
  fi
  end="$(date +%s)"
  echo "selfhost: healthy in $((end - start))s"
}

case "${1:-}" in
  # up writes deploy/.env first, because the stack ID the guard compares lives there.
  up) ensure_env && guard_project up ;;
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
  reset)
    if [ "${2:-}" != "--yes" ]; then
      echo "selfhost: reset deletes the database volume; run '$0 reset --yes' to confirm" >&2
      exit 1
    fi
    "${compose[@]}" down --volumes
    ;;
esac
