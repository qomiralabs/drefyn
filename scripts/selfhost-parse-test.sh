#!/usr/bin/env bash
# Proves the parse host's boundary and its failure behaviour from real containers: no way out,
# no credentials, reachable only from its own network and only with the token, restarted when
# it dies, stopped by the kernel at its memory limit and back after, and inside that limit
# under a flood at the defaults. Runs as its own Compose project, so a stack that is up keeps
# its own parse host. Needs a deploy/.env, so run it after scripts/selfhost.sh up. It removes
# what it starts. Set DREFYN_PARSE_FLOOD_SECONDS to flood for longer than the default 30.
set -euo pipefail

# shellcheck source=scripts/selfhost-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-lib.sh"
# shellcheck source=scripts/selfhost-parse-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-parse-lib.sh"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

# Its own name, so two checkouts on one machine can each run it.
project="${DREFYN_PARSE_TEST_PROJECT:-drefyn-parse-test}"
parse=(docker compose -p "$project" -f "$compose_file" --profile parse)
flood_seconds="${DREFYN_PARSE_FLOOD_SECONDS:-30}"
load_dir="$selfhost_root/packages/mdx/test"
stand_ins=()

token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
DREFYN_PARSE_TOKEN_SHA256="$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)"
export DREFYN_PARSE_TOKEN_SHA256
# Whatever the stack's deploy/.env says, this project runs at the defaults until it asks for
# the small profile. A value in the shell wins over the file.
export DREFYN_PARSE_HOST_MEMORY_MB=2048 DREFYN_PARSE_WORKER_MEMORY_MB=512
export DREFYN_PARSE_MAX_HELD_BYTES=268435456

cleanup() {
  local name
  for name in ${stand_ins[@]+"${stand_ins[@]}"}; do
    docker rm --force "$name" >/dev/null 2>&1 || true
  done
  "${parse[@]}" down --volumes --timeout 15 >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The project must start empty, or a leftover from a killed run would be what gets measured.
cleanup

"${parse[@]}" up --detach --build --wait --wait-timeout 180 parse-host
id="$("${parse[@]}" ps -q parse-host)"
network="$(parse_network_of "$id")"

parse_boundary_checks "$id" "$token" 2048

# Runs the load driver from the host image on the parse network, as the app tier would.
load() {
  docker run --rm --name "$1" --network "$network" -e DREFYN_PARSE_HOST_TOKEN="$token" \
    -v "$load_dir:/app/packages/mdx/test:ro" --entrypoint node "$parse_image" \
    packages/mdx/test/container-load.ts "${@:2}"
}
# memory_event <name>: a counter from the container's own memory controller.
memory_event() { docker exec "$id" sh -c "grep '^$1 ' /sys/fs/cgroup/memory.events | cut -d' ' -f2"; }
oom_kills() { memory_event oom_kill; }
peak_mb() { echo $(($(docker exec "$id" cat /sys/fs/cgroup/memory.peak) / 1048576)); }
answers_app() { parse_app_reaches "$network" parse-host "$token"; }

# The neighbour scan only means something if it finds a neighbour listening where the host can
# reach it. One stand in listens on every interface, the mistake the app tier must not make.
# The other joins both networks and listens only on the one the host is not on, which is how
# the app tier has to listen.
listen_js='
const address = process.env.BIND ?? Object.values(require("node:os").networkInterfaces())
  .flat().find((entry) => entry.family === "IPv4" && !entry.internal).address;
require("node:net").createServer((socket) => socket.end()).listen(8080, address);
'
careless="$project-careless"
careful="$project-careful"
stand_ins+=("$careless" "$careful")
docker run --detach --name "$careless" --network "$network" -e BIND=0.0.0.0 --entrypoint node \
  "$parse_image" -e "$listen_js" >/dev/null
docker run --detach --name "$careful" --network bridge --entrypoint node "$parse_image" \
  -e "$listen_js" >/dev/null
sleep 2
docker network connect "$network" "$careful"
careless_ip="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$careless")"
open="$(parse_open_neighbour_ports "$id" "$network" || true)"
if [ "$open" = "$careless_ip:8080" ]; then
  pass "control: the scan finds a neighbour on every interface, and not one listening elsewhere"
else
  fail "control: the scan finds a neighbour on every interface, and not one listening elsewhere" \
    "answered: ${open:-nothing}, want $careless_ip:8080"
fi
docker rm --force "$careless" "$careful" >/dev/null
stand_ins=()

# Reads under exactly the flags the host runs with, from the thread that a page would be in.
reads='
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const denied = (path) => {
  try {
    readFileSync(path);
    return false;
  } catch (error) {
    return error.code === "ERR_ACCESS_DENIED";
  }
};
const paths = ["/etc/passwd", "/proc/1/environ", "/run/secrets/postgres_password"];
if (isMainThread) {
  new Worker(process.argv[1], { eval: true })
    .on("message", (ok) => process.exit(ok ? 0 : 1))
    .on("error", () => process.exit(1));
} else {
  parentPort.postMessage(paths.every(denied));
}
'
if docker exec "$id" node --permission --allow-fs-read=/app --allow-worker -e "$reads" "$reads" \
  >/dev/null 2>&1; then
  pass "a thread under the host flags cannot read outside its code"
else
  fail "a thread under the host flags cannot read outside its code"
fi

canary="canary-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if out="$(docker run --rm -e DATABASE_URL="$canary" -e DREFYN_PARSE_TOKEN_SHA256 "$parse_image" 2>&1)"; then
  fail "a credential in the environment stops the host"
elif [[ "$out" == *DATABASE_URL* && "$out" != *"$canary"* ]]; then
  pass "a credential in the environment stops the host, by name and not by value"
else
  fail "a credential in the environment stops the host, by name and not by value" "$out"
fi
if docker run --rm -e DREFYN_PARSE_TOKEN_SHA256= "$parse_image" >/dev/null 2>&1; then
  fail "no token hash stops the host"
else
  pass "no token hash stops the host"
fi

# The memory floor counts threads at their cap and every held byte three times, so a flood at
# the defaults has to stay under the limit. A miss is a restart, not a loss, but it means the
# floor is wrong.
stand_ins+=("$project-flood")
if summary="$(load "$project-flood" flood "http://parse-host:8787" "$flood_seconds")" &&
  [[ "$summary" == *'"ok":'* ]]; then
  if [ "$(oom_kills)" = 0 ]; then
    pass "a ${flood_seconds}s flood at the defaults stays inside 2048 MB (peak $(peak_mb) MB)"
  else
    fail "a ${flood_seconds}s flood at the defaults stays inside 2048 MB" \
      "oom kills $(oom_kills), peak $(peak_mb) MB"
  fi
else
  fail "a ${flood_seconds}s flood at the defaults stays inside 2048 MB" "the flood itself failed"
fi
printf '      %s\n' "${summary:-no summary}"
stand_ins=()

# Kills the host process inside the container: the supervisor has to bring it back, and logs
# why, with no restart of the container.
restarts="$(docker inspect --format '{{.RestartCount}}' "$id")"
pid="$(docker logs "$id" 2>/dev/null | jq -r 'select(.event == "mdx.parse_host_started") | .pid' | tail -1)"
args="$(docker exec "$id" sh -c "tr '\\0' ' ' </proc/$pid/cmdline")"
if [[ "$args" == *"--permission --allow-fs-read=/app --allow-worker"* && "$args" != *child* ]]; then
  pass "the host runs with no way to start a process"
else
  fail "the host runs with no way to start a process" "$args"
fi
listening="$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_listening || true)"
docker exec "$id" sh -c "kill -9 $pid"
for _ in $(seq 1 60); do
  if [ "$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_listening || true)" -gt "$listening" ] &&
    answers_app; then
    break
  fi
  sleep 1
done
crashes="$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_crashed || true)"
if [ "$crashes" -ge 1 ] &&
  [ "$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_listening || true)" -gt "$listening" ]; then
  pass "a killed host comes back behind a backoff"
else
  fail "a killed host comes back behind a backoff" "$(docker logs --tail 20 "$id" 2>&1)"
fi
if [ "$(docker inspect --format '{{.RestartCount}}' "$id")" = "$restarts" ]; then
  pass "the supervisor did that, not the container restart"
else
  fail "the supervisor did that, not the container restart"
fi

# Native memory passes the heap cap, and only the kernel bounds it. A limit far under what the
# host was told it has stands in for that: the flood then has to end in a kill at the limit,
# not a host that grows past it, and the host has to answer again once the flood stops.
low_mb=384
docker update --memory "${low_mb}m" --memory-swap "${low_mb}m" "$id" >/dev/null
kills_before="$(oom_kills)"
hits_before="$(memory_event max)"
stand_ins+=("$project-fault")
load "$project-fault" flood "http://parse-host:8787" 120 >/dev/null 2>&1 &
flooding=$!
killed=false
for _ in $(seq 1 120); do
  if [ "$(oom_kills)" -gt "$kills_before" ]; then
    killed=true
    break
  fi
  sleep 1
done
docker rm --force "$project-fault" >/dev/null 2>&1 || true
wait "$flooding" 2>/dev/null || true
stand_ins=()
# memory.max is the limit the kernel enforced, and the max counter rises only when the
# container reached it, so the kill came from this limit and not from a machine out of memory.
enforced="$(docker exec "$id" cat /sys/fs/cgroup/memory.max)"
if [ "$killed" = true ] && [ "$enforced" = "$((low_mb * 1048576))" ] &&
  [ "$(memory_event max)" -gt "$hits_before" ]; then
  pass "a host past its memory limit is killed by the kernel at that limit ($low_mb MB)"
else
  fail "a host past its memory limit is killed by the kernel at that limit ($low_mb MB)" \
    "oom kills $(oom_kills), was $kills_before; enforced $enforced; limit reached $(memory_event max) times, was $hits_before"
fi
back=false
# A crash loop cools off for a minute before the next start, so this allows for one.
for _ in $(seq 1 120); do
  if answers_app; then
    back=true
    break
  fi
  sleep 1
done
if [ "$back" = true ]; then
  pass "after the kill, the host answers the app tier again"
else
  fail "after the kill, the host answers the app tier again" "$(docker logs --tail 20 "$id" 2>&1)"
fi

# The small profile for a machine with little memory: two threads at 256 MB and 64 MiB held
# fit under 1024. A page at the size limit has to parse and print inside it, or the profile
# would refuse honest pages. This is about memory, so the kill is long: how long a full page
# takes is proved on the thread, and depends on the machine. run takes the service as it is,
# limits and network included, with only those two keys added.
export DREFYN_PARSE_HOST_MEMORY_MB=1024 DREFYN_PARSE_WORKER_MEMORY_MB=256
export DREFYN_PARSE_MAX_HELD_BYTES=67108864
"${parse[@]}" rm --stop --force parse-host >/dev/null
small="$project-small"
stand_ins+=("$small")
id="$("${parse[@]}" run --detach --name "$small" -e DREFYN_PARSE_TIMEOUT_MS=20000 \
  -e DREFYN_PARSE_PRINT_TIMEOUT_MS=20000 parse-host)"
for _ in $(seq 1 60); do
  if parse_app_reaches "$network" "$small" "$token"; then break; fi
  sleep 1
done
limit="$(docker inspect --format '{{.HostConfig.Memory}}' "$id")"
if [ "$limit" = "$((1024 * 1024 * 1024))" ]; then
  pass "the small profile sets a 1024 MB limit"
else
  fail "the small profile sets a 1024 MB limit" "limit is $limit"
fi
stand_ins+=("$project-print")
if summary="$(load "$project-print" print "http://$small:8787")"; then
  pass "the small profile parses and prints an honest page at the size limit, in both dialects"
else
  fail "the small profile parses and prints an honest page at the size limit, in both dialects"
fi
printf '      %s\n' "${summary:-no summary}"
if [ "$(oom_kills)" = 0 ]; then
  pass "the small profile was never killed for memory (peak $(peak_mb) MB)"
else
  fail "the small profile was never killed for memory" "peak $(peak_mb) MB"
fi

if [ "$failures" -gt 0 ]; then
  docker logs --tail 40 "$id" 2>&1 || true
  echo "parse: $failures check(s) failed" >&2
  exit 1
fi
echo "parse: passed"
