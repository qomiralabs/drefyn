# shellcheck shell=bash
# Shared by the self host scripts; sourced, not run.

selfhost_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$selfhost_root/deploy/compose.yaml"
compose=(docker compose -f "$compose_file")
selfhost_project=""
# compose.yaml writes this into a label on the data volume. Volumes record no compose file
# of their own, and without it a volume an older stack left behind looks like ours.
export DREFYN_COMPOSE_FILE="$compose_file"

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
guard_project() {
  local config listing volumes id name files volume file containers=0 foreign=""
  if ! config="$("${compose[@]}" config 2>&1)"; then
    say <<EOF
selfhost: could not read the project name from $compose_file; nothing was changed.
$config
EOF
    exit 1
  fi
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
    --format '{{.Name}} {{.Label "com.drefyn.selfhost.compose-file"}}')"; then
    say <<<"selfhost: could not list volumes in project '$selfhost_project'; nothing was changed."
    exit 1
  fi
  while read -r volume file; do
    [ -n "$volume" ] || continue
    if [ -n "$file" ] && [ "$file" -ef "$compose_file" ]; then continue; fi
    # Plain docker compose leaves the label empty. Such a volume is ours only while this file's
    # containers are the ones using the project.
    if [ -z "$file" ] && [ "$containers" -gt 0 ] && [ -z "$foreign" ]; then continue; fi
    foreign+="  volume $volume (from ${file:-an unknown compose file})"$'\n'
  done <<<"$volumes"

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
