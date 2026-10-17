#!/usr/bin/env bash
# Proves the self host scripts refuse to touch containers that another compose file created
# under the same project name. It plants a stopped container that looks like it came from
# some other checkout, runs every command against that project, and checks each one stops
# without changing the planted container or starting anything.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(sed -n 's/^ *image: *//p' "$root/deploy/compose.yaml" | head -n 1)"
project="drefyn-guard-test-$$"
export COMPOSE_PROJECT_NAME="$project"
# Keep clear of any stack already on the default port in case the guard fails open.
export DREFYN_POSTGRES_PORT=55439

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

cleanup() {
  # Only this test's own project is ever removed.
  docker compose -f "$root/deploy/compose.yaml" down --volumes --timeout 5 >/dev/null 2>&1 || true
  docker rm -f "$project-postgres-1" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
planted="$(docker create --name "$project-postgres-1" \
  --label "com.docker.compose.project=$project" \
  --label "com.docker.compose.service=postgres" \
  --label "com.docker.compose.container-number=1" \
  --label "com.docker.compose.oneoff=False" \
  --label "com.docker.compose.project.config_files=/elsewhere/docker-compose.yml" \
  "$image")"
state() { docker inspect --format '{{.Id}} {{.State.Status}} {{.Created}}' "$planted"; }
before="$(state)"

for cmd in "selfhost.sh up" "selfhost.sh restart" "selfhost.sh down" "selfhost.sh reset --yes" \
  "selfhost-smoke.sh" "selfhost-smoke.sh --teardown"; do
  read -r -a argv <<<"$cmd"
  if out="$(bash "$root/scripts/${argv[0]}" "${argv[@]:1}" 2>&1)"; then
    fail "$cmd refuses a project created elsewhere" "it exited 0: $out"
  elif [[ "$out" != *"COMPOSE_PROJECT_NAME"* ]]; then
    fail "$cmd refuses a project created elsewhere" "no hint to set COMPOSE_PROJECT_NAME: $out"
  else
    pass "$cmd refuses a project created elsewhere"
  fi
  after="$(state 2>&1 || true)"
  if [ "$after" != "$before" ]; then
    fail "$cmd leaves the planted container alone" "before [$before], after [$after]"
  fi
  others="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | grep -v "^${planted:0:12}" || true)"
  if [ -n "$others" ]; then
    fail "$cmd starts nothing" "new containers: $others"
    # One ID per line; splitting is the point.
    # shellcheck disable=SC2086
    docker rm -f $others >/dev/null 2>&1 || true
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "guard test: $failures check(s) failed" >&2
  exit 1
fi
echo "guard test: passed"
