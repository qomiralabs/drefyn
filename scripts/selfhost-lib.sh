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
# from this file. Any docker failure refuses too: an empty answer must not read as all clear.
# guard_project <command>: only down and reset may touch a volume from an earlier build.
guard_project() {
  local command="$1" config stack_id listing volumes id name files volume label old_file
  local containers=0 foreign="" earlier=""
  if ! config="$("${compose[@]}" config 2>&1)"; then
    say <<EOF
selfhost: could not read the compose configuration in $compose_file; nothing was changed.
$config
EOF
    exit 1
  fi
  # Volumes record no compose file of their own, so the data volume carries the stack ID from
  # deploy/.env. Read it as compose resolves it, so a value set in the shell counts too.
  stack_id="$(sed -n 's/^ *com\.drefyn\.selfhost\.stack-id: *//p' <<<"$config" | head -n 1 | tr -d "\"'")"
  selfhost_project="$(sed -n 's/^name: *//p' <<<"$config" | head -n 1)"
  if [ -z "$selfhost_project" ]; then
    say <<<"selfhost: could not read the project name from $compose_file; nothing was changed."
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

  if ! volumes="$(docker volume ls --filter "label=com.docker.compose.project=$selfhost_project" \
    --format '{{.Name}}|{{.Label "com.drefyn.selfhost.stack-id"}}|{{.Label "com.drefyn.selfhost.compose-file"}}')"; then
    say <<<"selfhost: could not list volumes in project '$selfhost_project'; nothing was changed."
    exit 1
  fi
  while IFS='|' read -r volume label old_file; do
    [ -n "$volume" ] || continue
    if [ -n "$label" ] && [ "$label" = "$stack_id" ]; then continue; fi
    # Earlier builds of this stack labelled the volume with the compose file path instead.
    # Compose would want to recreate it, so only stopping and removing it are safe.
    if [ -z "$label" ] && [ -n "$old_file" ] && [ "$old_file" -ef "$compose_file" ]; then
      case "$command" in
        down | reset) ;;
        *) earlier+="  volume $volume"$'\n' ;;
      esac
      continue
    fi
    foreign+="  volume $volume (stack ID ${label:-missing})"$'\n'
  done <<<"$volumes"

  if [ -n "$earlier" ] && [ -z "$foreign" ]; then
    say <<EOF
selfhost: project '$selfhost_project' has a data volume from an earlier build of this stack,
labelled in a way newer Compose would want to recreate:
${earlier}Nothing was changed. If it holds nothing you need, delete it with
'bash scripts/selfhost.sh reset --yes' and run up again. Otherwise set COMPOSE_PROJECT_NAME
to another name, in the shell or in deploy/.env.
EOF
    exit 1
  fi

  if [ -n "$foreign" ]; then
    say <<EOF
selfhost: project '$selfhost_project' already has containers or volumes from another compose file:
${foreign}Nothing was changed. Set COMPOSE_PROJECT_NAME to another name, in the shell or in
deploy/.env, to run this stack beside them.
EOF
    exit 1
  fi
}

# The newest healthcheck output, which names the check that failed.
health_output() {
  docker inspect --format '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' \
    "$1" 2>/dev/null | sed '/^$/d' | tail -n 1
}
