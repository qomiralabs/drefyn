#!/usr/bin/env bash
# Proves the self host scripts refuse to touch a project that another compose file created
# under the same name. It plants containers and volumes that look like they came from some
# other checkout, runs every command against them, and checks each one stops without
# changing what was planted or starting anything. Nothing here starts a real stack.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(sed -n 's/^ *image: *//p' "$root/deploy/compose.yaml" | head -n 1)"
# A dedicated variable, so an exported COMPOSE_PROJECT_NAME can never point this at a real stack.
base="${DREFYN_GUARD_TEST_PROJECT:-drefyn-guard-test-$$}"
if [ "$base" = drefyn ]; then
  echo "guard test: refusing to plant containers in project drefyn" >&2
  exit 64
fi
# Keep clear of any stack already on the default port in case the guard fails open.
export DREFYN_POSTGRES_PORT=55439
real_docker="$(command -v docker)"
scratch="$(mktemp -d)"
commands=("selfhost.sh up" "selfhost.sh restart" "selfhost.sh down" "selfhost.sh reset --yes"
  "selfhost-smoke.sh" "selfhost-smoke.sh --teardown")

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

projects=()
cleanup() {
  local p ids vols
  # Only this test's own projects are ever removed.
  for p in ${projects[@]+"${projects[@]}"}; do
    ids="$("$real_docker" ps -aq --filter "label=com.docker.compose.project=$p" 2>/dev/null || true)"
    # One ID per line; splitting is the point.
    # shellcheck disable=SC2086
    if [ -n "$ids" ]; then "$real_docker" rm -f $ids >/dev/null 2>&1 || true; fi
    vols="$("$real_docker" volume ls -q --filter "label=com.docker.compose.project=$p" 2>/dev/null || true)"
    # shellcheck disable=SC2086
    if [ -n "$vols" ]; then "$real_docker" volume rm -f $vols >/dev/null 2>&1 || true; fi
    "$real_docker" network rm "${p}_default" >/dev/null 2>&1 || true
  done
  rm -rf "$scratch"
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null

# plant_container <project> [config_files label]: a stopped container that compose would
# treat as the postgres service of <project>. No label means no config_files label at all.
plant_container() {
  local labels=(--label "com.docker.compose.project=$1"
    --label "com.docker.compose.service=postgres"
    --label "com.docker.compose.container-number=1"
    --label "com.docker.compose.oneoff=False")
  if [ "$#" -gt 1 ]; then labels+=(--label "com.docker.compose.project.config_files=$2"); fi
  docker create --name "$1-postgres-1" "${labels[@]}" "$image"
}

# A volume as compose labels it, but with nothing that ties it to this checkout.
plant_volume() {
  docker volume create --label "com.docker.compose.project=$1" \
    --label "com.docker.compose.volume=pgdata" \
    --label "com.docker.compose.version=2.30.3" "$1_pgdata" >/dev/null
}

state() { docker inspect --format '{{.Id}} {{.State.Status}} {{.Created}}' "$1"; }
volume_state() { docker volume inspect --format '{{.Name}} {{.CreatedAt}}' "$1"; }

# expect_refusal <description> <expected output> <command line> [env assignments...]
# The command must exit non zero and say <expected output>.
expect_refusal() {
  local what="$1" expected="$2" cmd="$3" out argv
  shift 3
  read -r -a argv <<<"$cmd"
  if out="$(env "$@" bash "$root/scripts/${argv[0]}" "${argv[@]:1}" 2>&1)"; then
    fail "$cmd $what" "it exited 0: $out"
  elif [[ "$out" != *"$expected"* ]]; then
    fail "$cmd $what" "expected [$expected] in: $out"
  else
    pass "$cmd $what"
  fi
}

# nothing_started <project> <planted container id or empty>
nothing_started() {
  local others
  others="$(docker ps -aq --filter "label=com.docker.compose.project=$1" | grep -v "^${2:0:12}" || true)"
  if [ -n "$others" ]; then
    fail "$3 starts nothing" "new containers: $others"
    # shellcheck disable=SC2086
    docker rm -f $others >/dev/null 2>&1 || true
  fi
}

# A foreign container: every command refuses and leaves it alone.
project="$base"
projects+=("$project")
planted="$(plant_container "$project" /elsewhere/docker-compose.yml)"
before="$(state "$planted")"
for cmd in "${commands[@]}"; do
  expect_refusal "refuses a container created elsewhere" COMPOSE_PROJECT_NAME "$cmd" \
    COMPOSE_PROJECT_NAME="$project"
  after="$(state "$planted" 2>&1 || true)"
  if [ "$after" != "$before" ]; then
    fail "$cmd leaves the planted container alone" "before [$before], after [$after]"
  fi
  nothing_started "$project" "$planted" "$cmd"
done

# When docker cannot list containers or volumes (ENFILE on a loaded machine looks like
# this), the guard has to stop rather than see an empty project.
mkdir -p "$scratch/shim"
cat >"$scratch/shim/docker" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "\$GUARD_SHIM_FAIL" ] || [ "\$1 \${2:-}" = "\$GUARD_SHIM_FAIL" ]; then
  echo "shim: \$GUARD_SHIM_FAIL failed" >&2
  exit 1
fi
exec "$real_docker" "\$@"
EOF
chmod +x "$scratch/shim/docker"
for failing in ps "volume ls"; do
  for cmd in "selfhost.sh down" "selfhost.sh reset --yes" "selfhost-smoke.sh --teardown"; do
    expect_refusal "stops when docker $failing fails" "nothing was changed" "$cmd" \
      COMPOSE_PROJECT_NAME="$project" PATH="$scratch/shim:$PATH" GUARD_SHIM_FAIL="$failing"
    after="$(state "$planted" 2>&1 || true)"
    if [ "$after" != "$before" ]; then
      fail "$cmd leaves the planted container alone when docker $failing fails" \
        "before [$before], after [$after]"
    fi
  done
done

# A compose file that does not parse must say so, not exit silently.
expect_refusal "explains a compose config error" "could not read the project name" \
  "selfhost.sh down" COMPOSE_PROJECT_NAME="$project" DREFYN_POSTGRES_PORT=notaport

# A container with the project label but no config_files label, as docker run makes.
project="$base-nolabel"
projects+=("$project")
planted="$(plant_container "$project")"
expect_refusal "refuses a container with no config_files label" COMPOSE_PROJECT_NAME \
  "selfhost.sh down" COMPOSE_PROJECT_NAME="$project"
if [ -z "$(docker ps -aq --filter "id=$planted")" ]; then
  fail "selfhost.sh down leaves the unlabelled container alone" "it was removed"
fi

# Only a volume left, as a plain down leaves an older stack. up would mount it and reset
# would delete it.
project="$base-volume"
projects+=("$project")
plant_volume "$project"
vbefore="$(volume_state "${project}_pgdata")"
for cmd in "${commands[@]}"; do
  expect_refusal "refuses a volume created elsewhere" COMPOSE_PROJECT_NAME "$cmd" \
    COMPOSE_PROJECT_NAME="$project"
  vafter="$(volume_state "${project}_pgdata" 2>&1 || true)"
  if [ "$vafter" != "$vbefore" ]; then
    fail "$cmd leaves the planted volume alone" "before [$vbefore], after [$vafter]"
  fi
  nothing_started "$project" "" "$cmd"
done

# Compose joins config_files with commas, so a path that has one must still match.
project="$base-comma"
projects+=("$project")
copy="$scratch/with,comma"
mkdir -p "$copy"
cp -R "$root/scripts" "$root/deploy" "$copy/"
rm -f "$copy/deploy/.env"
plant_container "$project" "$copy/deploy/compose.yaml,/elsewhere/override.yml" >/dev/null
if out="$(COMPOSE_PROJECT_NAME="$project" bash "$copy/scripts/selfhost.sh" down 2>&1)"; then
  pass "selfhost.sh down accepts its own compose file under a path with a comma"
else
  fail "selfhost.sh down accepts its own compose file under a path with a comma" "$out"
fi

if [ "$failures" -gt 0 ]; then
  echo "guard test: $failures check(s) failed" >&2
  exit 1
fi
echo "guard test: passed"
