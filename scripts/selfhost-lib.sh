# shellcheck shell=bash
# Shared by the self host scripts; sourced, not run.

selfhost_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$selfhost_root/deploy/compose.yaml"
compose=(docker compose -f "$compose_file")
selfhost_project=""

# Messages go out in one write by an external cat. Under load bash 3.2's printf and echo give
# up on an interrupted write, and a refusal cut short hides its reason.
say() { cat >&2; }

# is_ours <config_files label>: true when one of the files is this compose file. Compose joins
# the paths with commas without escaping them, so every run of neighbouring pieces is tried
# as a path. -ef compares the files themselves, so symlinks and path case do not matter.
is_ours() {
  local pieces i j candidate
  [ -n "$1" ] || return 1
  IFS=',' read -r -a pieces <<<"$1"
  for ((i = 0; i < ${#pieces[@]}; i++)); do
    candidate="${pieces[i]}"
    if [ "$candidate" -ef "$compose_file" ]; then return 0; fi
    for ((j = i + 1; j < ${#pieces[@]}; j++)); do
      candidate="$candidate,${pieces[j]}"
      if [ "$candidate" -ef "$compose_file" ]; then return 0; fi
    done
  done
  return 1
}

# The project name decides which containers and volumes compose treats as its own. If another
# checkout or an older stack already used the same name, up would recreate its containers or
# mount its volume, and reset would delete it. Refuse unless everything in the project came
# from this checkout. Any docker failure refuses too: an empty answer must not read as all
# clear. Every step checks its own status, because a caller in an if or && context would turn
# set -e off for the whole function.
# guard_project <command>: only down and reset may touch a volume from an earlier build.
guard_project() {
  local command="$1" errors config stack_id listing names inspected classified
  local id name files kind volume detail containers=0 foreign="" mismatch="" earlier=""
  if ! command -v jq >/dev/null 2>&1; then
    say <<<"selfhost: jq is required; install it and run this again. Nothing was changed."
    exit 1
  fi
  if ! errors="$(mktemp)"; then
    say <<<"selfhost: could not create a temporary file; nothing was changed."
    exit 1
  fi
  # Warnings on stderr must not end up inside the JSON.
  if ! config="$("${compose[@]}" config --format json 2>"$errors")"; then
    say <<EOF
selfhost: could not read the compose configuration in $compose_file; nothing was changed.
$(cat "$errors")
EOF
    rm -f "$errors"
    exit 1
  fi
  rm -f "$errors"
  if ! selfhost_project="$(jq -er '.name' <<<"$config")"; then
    say <<<"selfhost: could not read the project name from $compose_file; nothing was changed."
    exit 1
  fi
  # The data volume carries the stack ID from deploy/.env, because volumes record no compose
  # file of their own. Set it there and only there: a value exported in one shell would make
  # plain docker compose from another shell label the volume differently.
  if ! stack_id="$(jq -er '.volumes.pgdata.labels["com.drefyn.selfhost.stack-id"] // empty' \
    <<<"$config")"; then
    say <<<"selfhost: no DREFYN_STACK_ID for the data volume; add one to deploy/.env. Nothing was changed."
    exit 1
  fi

  if ! listing="$(docker ps -a --no-trunc --filter "label=com.docker.compose.project=$selfhost_project" \
    --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project.config_files"}}')"; then
    say <<<"selfhost: could not list containers in project '$selfhost_project'; nothing was changed."
    exit 1
  fi
  while read -r id name files; do
    [ -n "$id" ] || continue
    containers=$((containers + 1))
    if ! is_ours "$files"; then
      foreign+="  container $name (from ${files:-an unknown compose file})"$'\n'
    fi
  done <<<"$listing"

  if ! names="$(docker volume ls -q --filter "label=com.docker.compose.project=$selfhost_project")"; then
    say <<<"selfhost: could not list volumes in project '$selfhost_project'; nothing was changed."
    exit 1
  fi
  if [ -n "$names" ]; then
    # One volume name per line; splitting is the point. JSON keeps label values whole, so no
    # character in an ID or a path can split a field.
    # shellcheck disable=SC2086
    if ! inspected="$(docker volume inspect $names)" ||
      ! classified="$(jq -r --arg id "$stack_id" '.[] | (.Labels // {}) as $l
        | ($l["com.drefyn.selfhost.stack-id"] // "") as $label
        | if $label == $id then empty
          elif $label != "" then "mismatch\t\(.Name)\t\($label)"
          elif ($l["com.drefyn.selfhost.compose-file"] // "") != "" then
            "earlier\t\(.Name)\t\($l["com.drefyn.selfhost.compose-file"])"
          else "foreign\t\(.Name)\t" end' <<<"$inspected")"; then
      say <<<"selfhost: could not inspect volumes in project '$selfhost_project'; nothing was changed."
      exit 1
    fi
    while IFS=$'\t' read -r kind volume detail; do
      [ -n "$kind" ] || continue
      case "$kind" in
        mismatch) mismatch+="  volume $volume has stack ID $detail"$'\n' ;;
        # Earlier builds labelled the volume with the compose file path instead. Compose would
        # want to recreate it, so only stopping and removing it are safe.
        earlier)
          if [ "$detail" -ef "$compose_file" ]; then
            case "$command" in
              down | reset) ;;
              *) earlier+="  volume $volume"$'\n' ;;
            esac
          else
            foreign+="  volume $volume (from $detail)"$'\n'
          fi
          ;;
        *) foreign+="  volume $volume (no stack ID)"$'\n' ;;
      esac
    done <<<"$classified"
  fi

  if [ -n "$foreign" ]; then
    say <<EOF
selfhost: project '$selfhost_project' already has containers or volumes from another compose file:
${foreign}Nothing was changed. Set COMPOSE_PROJECT_NAME to another name, in the shell or in
deploy/.env, to run this stack beside them.
EOF
    exit 1
  fi
  if [ -n "$mismatch" ]; then
    say <<EOF
selfhost: the data volume's stack ID does not match DREFYN_STACK_ID ($stack_id):
${mismatch}Nothing was changed. The stack ID must never change after the first start: if
deploy/.env was edited, put the old value back. If the volume belongs to another checkout,
set COMPOSE_PROJECT_NAME to another name, in the shell or in deploy/.env.
EOF
    exit 1
  fi
  if [ -n "$earlier" ]; then
    say <<EOF
selfhost: project '$selfhost_project' has a data volume from an earlier build of this stack,
labelled in a way newer Compose would want to recreate:
${earlier}Nothing was changed. If it holds nothing you need, delete it with
'bash scripts/selfhost.sh reset --yes' and run up again. Otherwise set COMPOSE_PROJECT_NAME
to another name, in the shell or in deploy/.env.
EOF
    exit 1
  fi
}

# The newest healthcheck output, which names the check that failed. When the healthcheck has
# not run, as while the container restarts, fall back to the container's own state.
health_output() {
  local output state
  output="$(docker inspect --format \
    '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' "$1" 2>/dev/null |
    sed '/^$/d' | tail -n 1 || true)"
  if [ -n "$output" ]; then
    printf '%s' "$output"
    return
  fi
  state="$(docker inspect --format '{{.State.Status}}, last exit code {{.State.ExitCode}}' \
    "$1" 2>/dev/null || true)"
  printf 'no healthcheck result yet; the container is %s' "${state:-gone}"
}
