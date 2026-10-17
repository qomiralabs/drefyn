#!/usr/bin/env bash
# Start, stop and reset the self host compose stack.
#   up       create deploy/.env with random passwords if it is missing, then start and wait
#   down     stop and remove the containers, keep the data volume
#   restart  restart the containers and wait until healthy again
#   reset    remove the containers and the data volume (needs --yes)
set -euo pipefail

# shellcheck source=scripts/selfhost-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-lib.sh"
deploy="$selfhost_root/deploy"
# Generous enough for a cold first init on a slow laptop; a clean CI runner is far faster.
wait_seconds="${DREFYN_SELFHOST_WAIT_SECONDS:-90}"

usage() {
  echo "usage: $0 up | down | restart | reset --yes" >&2
  exit 64
}

random_secret() {
  # 24 random bytes as hex: no characters that need quoting in .env or a connection URL.
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_env() {
  local env_file="$deploy/.env"
  if [ -f "$env_file" ]; then return; fi
  local tmp line key
  tmp="$(mktemp "$deploy/.env.XXXXXX")"
  chmod 600 "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^(DREFYN_[A-Z_]+_PASSWORD)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      printf '%s=%s\n' "$key" "$(random_secret)" >>"$tmp"
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$deploy/.env.example"
  mv "$tmp" "$env_file"
  echo "selfhost: wrote $env_file with generated passwords"
}

wait_healthy() {
  local start end
  start="$(date +%s)"
  "${compose[@]}" up --detach --wait --wait-timeout "$wait_seconds"
  end="$(date +%s)"
  echo "selfhost: healthy in $((end - start))s"
}

case "${1:-}" in
  up | down | restart | reset) guard_project ;;
  *) usage ;;
esac

case "$1" in
  up)
    ensure_env
    # Pull first so the healthy time measures startup, not the network.
    "${compose[@]}" pull --quiet
    wait_healthy
    ;;
  down)
    "${compose[@]}" down
    ;;
  restart)
    "${compose[@]}" restart
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
