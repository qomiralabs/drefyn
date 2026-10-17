# shellcheck shell=bash
# Shared by the self host scripts; sourced, not run.

selfhost_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$selfhost_root/deploy/compose.yaml"
compose=(docker compose -f "$compose_file")

# The project name decides which containers compose treats as its own. If another checkout or
# an older stack already used the same name, up would recreate its containers and reset would
# delete its volumes. Refuse unless every container in the project came from this file.
guard_project() {
  local project id name files file ours list foreign=""
  project="$("${compose[@]}" config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1)"
  if [ -z "$project" ]; then
    echo "selfhost: could not read the project name from $compose_file" >&2
    exit 1
  fi
  while read -r id name files; do
    [ -n "$id" ] || continue
    ours=false
    # Overrides add more files to the label; ours only has to be one of them. -ef compares the
    # files themselves, so symlinks and path case do not matter.
    IFS=',' read -r -a list <<<"$files"
    for file in "${list[@]}"; do
      if [ "$file" -ef "$compose_file" ]; then ours=true; fi
    done
    if [ "$ours" = false ]; then foreign+="  $name (from ${files:-an unknown file})"$'\n'; fi
  done < <(docker ps -a --filter "label=com.docker.compose.project=$project" \
    --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project.config_files"}}')
  if [ -n "$foreign" ]; then
    {
      echo "selfhost: project '$project' already has containers from another compose file:"
      printf '%s' "$foreign"
      echo "Nothing was changed. Set COMPOSE_PROJECT_NAME to another name, in the shell or in"
      echo "deploy/.env, to run this stack beside them."
    } >&2
    exit 1
  fi
}
