#!/usr/bin/env bash
# Proves the self host scripts refuse to touch a project that another compose file created
# under the same name. It plants containers and volumes that look like they came from some
# other checkout, runs every command against them, and checks each one stops without
# changing what was planted or starting anything. The last part starts real stacks to prove
# plain docker compose and the scripts describe the data volume the same way, since newer
# Compose offers to recreate a volume whose labels changed. Everything runs from a scratch copy
# of the checkout, so the real deploy/.env is never read or written.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(sed -n 's/^ *image: *//p' "$src/deploy/compose.yaml" | head -n 1)"
# A dedicated variable, so an exported COMPOSE_PROJECT_NAME can never point this at a real stack.
base="${DREFYN_GUARD_TEST_PROJECT:-drefyn-guard-test-$$}"
if [ "$base" = drefyn ]; then
  echo "guard test: refusing to plant containers in project drefyn" >&2
  exit 64
fi
# Keep clear of any stack already on the default port in case the guard fails open, and let
# two runs at once use different ports.
export DREFYN_POSTGRES_PORT="${DREFYN_GUARD_TEST_PORT:-55439}"
# Values in the shell win over deploy/.env, so the real file is never read or changed.
export DREFYN_STACK_ID DREFYN_POSTGRES_PASSWORD DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD \
  DREFYN_PUBLIC_READER_PASSWORD
for var in DREFYN_STACK_ID DREFYN_POSTGRES_PASSWORD DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD \
  DREFYN_PUBLIC_READER_PASSWORD; do
  value="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  printf -v "$var" '%s' "$value"
done
real_docker="$(command -v docker)"
scratch="$(mktemp -d)"
root="$scratch/checkout"
mkdir -p "$root"
cp -R "$src/scripts" "$src/deploy" "$root/"
rm -f "$root/deploy/.env"
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
  others="$(docker ps -aq --filter "label=com.docker.compose.project=$1")"
  # With no planted container every container counts; an empty pattern would match them all.
  if [ -n "$2" ]; then others="$(grep -v "^${2:0:12}" <<<"$others" || true)"; fi
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
expect_refusal "explains a compose config error" "could not read the compose configuration" \
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
cp -R "$src/scripts" "$src/deploy" "$copy/"
rm -f "$copy/deploy/.env"
plant_container "$project" "$copy/deploy/compose.yaml,/elsewhere/override.yml" >/dev/null
if out="$(COMPOSE_PROJECT_NAME="$project" bash "$copy/scripts/selfhost.sh" down 2>&1)"; then
  pass "selfhost.sh down accepts its own compose file under a path with a comma"
else
  fail "selfhost.sh down accepts its own compose file under a path with a comma" "$out"
fi

# A first up writes deploy/.env. If that step fails, as its closing echo does when stdout is
# closed, the script must stop rather than skip the guard and start the stack.
for kind in container volume; do
  project="$base-closed-$kind"
  projects+=("$project")
  rm -f "$root/deploy/.env"
  planted=""
  if [ "$kind" = container ]; then
    planted="$(plant_container "$project" /elsewhere/docker-compose.yml)"
    before="$(state "$planted")"
  else
    docker volume create --label "com.docker.compose.project=$project" \
      --label "com.docker.compose.volume=pgdata" \
      --label "com.drefyn.selfhost.stack-id=someone-else" "${project}_pgdata" >/dev/null
    before="$(volume_state "${project}_pgdata")"
  fi
  if COMPOSE_PROJECT_NAME="$project" bash "$root/scripts/selfhost.sh" up >&- 2>"$scratch/closed.err"; then
    fail "selfhost.sh up with stdout closed stops before a foreign $kind" "it exited 0"
  else
    pass "selfhost.sh up with stdout closed stops before a foreign $kind"
  fi
  nothing_started "$project" "$planted" "selfhost.sh up with stdout closed and a foreign $kind"
  if [ "$kind" = container ]; then
    after="$(state "$planted" 2>&1 || true)"
  else
    after="$(volume_state "${project}_pgdata" 2>&1 || true)"
  fi
  if [ "$after" != "$before" ]; then
    fail "selfhost.sh up with stdout closed leaves the foreign $kind alone" \
      "before [$before], after [$after]"
  fi
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  if [ "$kind" = container ] && [ -n "$volumes" ]; then
    fail "selfhost.sh up with stdout closed creates no volume" "$volumes"
  fi
done
rm -f "$root/deploy/.env"

# A volume labelled by an earlier build of this stack, with the compose file path and no stack
# ID. Only reset may touch it; anything that would mount it must refuse and say how to recover.
project="$base-oldlabel"
projects+=("$project")
docker volume create --label "com.docker.compose.project=$project" \
  --label "com.docker.compose.volume=pgdata" --label "com.docker.compose.version=2.30.3" \
  --label "com.drefyn.selfhost.compose-file=$root/deploy/compose.yaml" "${project}_pgdata" >/dev/null
for cmd in "selfhost.sh up" "selfhost.sh restart" "selfhost-smoke.sh"; do
  expect_refusal "refuses a volume from an earlier build" "earlier build" "$cmd" \
    COMPOSE_PROJECT_NAME="$project"
done
nothing_started "$project" "" "commands against an earlier build's volume"
if out="$(COMPOSE_PROJECT_NAME="$project" bash "$root/scripts/selfhost.sh" reset --yes 2>&1)" &&
  [ -z "$(docker volume ls -q --filter "name=^${project}_pgdata$")" ]; then
  pass "selfhost.sh reset --yes removes a volume from an earlier build"
else
  fail "selfhost.sh reset --yes removes a volume from an earlier build" "$out"
fi

# What each caller would label the volume with, from its own view of the config.
config_labels() {
  jq -cS '.volumes.pgdata.labels // {}' <<<"$1"
}
plain_config() {
  docker compose -f "$root/deploy/compose.yaml" config --format json
}
script_config() {
  # shellcheck disable=SC1091
  bash -c '. "$1/scripts/selfhost-lib.sh"; "${compose[@]}" config --format json' _ "$root"
}
volume_labels() {
  docker volume inspect --format '{{json .Labels}}' "$1" | jq -cS .
}
# expect_same_volume <project> <description>: both callers' labels are on the volume and agree.
expect_same_volume() {
  local labels plain script missing
  labels="$(volume_labels "$1_pgdata")"
  plain="$(config_labels "$(plain_config)")"
  script="$(config_labels "$(script_config)")"
  missing="$(jq -n --argjson v "$labels" --argjson p "$plain" --argjson s "$script" \
    '[($p, $s) | to_entries[] | select($v[.key] != .value) | .key] | unique | join(",")')"
  if [ "$plain" = "$script" ] && [ "$missing" = '""' ]; then
    pass "$2"
  else
    fail "$2" "plain $plain, scripts $script, volume $labels"
  fi
}

for order in scripts-first plain-first; do
  project="$base-$order"
  projects+=("$project")
  export COMPOSE_PROJECT_NAME="$project"
  if [ "$order" = scripts-first ]; then
    first=(bash "$root/scripts/selfhost.sh" up)
    second=(docker compose -p "$project" -f "$root/deploy/compose.yaml" up -d --wait)
  else
    first=(docker compose -p "$project" -f "$root/deploy/compose.yaml" up -d --wait)
    second=(bash "$root/scripts/selfhost.sh" up)
  fi
  if ! out="$("${first[@]}" 2>&1)"; then
    fail "$order: the first up succeeds" "$out"
  fi
  before="$(volume_labels "${project}_pgdata") $(volume_state "${project}_pgdata")"
  if ! out="$("${second[@]}" 2>&1)"; then
    fail "$order: the second up reuses the volume" "$out"
  fi
  after="$(volume_labels "${project}_pgdata") $(volume_state "${project}_pgdata")"
  if [ "$before" = "$after" ]; then
    pass "$order: the second up leaves the volume and its labels unchanged"
  else
    fail "$order: the second up leaves the volume and its labels unchanged" \
      "before [$before], after [$after]"
  fi
  expect_same_volume "$project" "$order: plain docker compose and the scripts label the volume alike"
  docker compose -p "$project" -f "$root/deploy/compose.yaml" down --volumes --timeout 5 \
    >/dev/null 2>&1 || true
  unset COMPOSE_PROJECT_NAME
done

if [ "$failures" -gt 0 ]; then
  echo "guard test: $failures check(s) failed" >&2
  exit 1
fi
echo "guard test: passed"
