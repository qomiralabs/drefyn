#!/usr/bin/env bash
# Proves the parse host's boundary from real containers: no way out, no credentials, reachable
# only from its own network and only with the token, and restarted when it dies. Needs a
# deploy/.env, so run it after scripts/selfhost.sh up. It removes what it starts.
set -euo pipefail

# shellcheck source=scripts/selfhost-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-lib.sh"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

parse=(docker compose -f "$compose_file" --profile parse)
image=drefyn-parse-host:local
outside_port=18790
listener=""

token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
DREFYN_PARSE_TOKEN_SHA256="$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)"
export DREFYN_PARSE_TOKEN_SHA256

cleanup() {
  if [ -n "$listener" ]; then kill "$listener" 2>/dev/null || true; fi
  "${parse[@]}" rm --stop --force parse-host >/dev/null 2>&1 || true
  if [ -n "${network:-}" ]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

"${parse[@]}" up --detach --build --wait --wait-timeout 180 parse-host
id="$("${parse[@]}" ps -q parse-host)"
network="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$id")"
network="${network% }"

# Runs a connect from inside a container: exit 0 means it reached something.
connect='
const [host, port] = process.argv.slice(1);
const socket = require("node:net").connect({ host, port: Number(port), timeout: 3000 });
socket.on("connect", () => process.exit(0));
socket.on("timeout", () => process.exit(1));
socket.on("error", () => process.exit(1));
'
reaches_from_inside() { docker exec "$id" node -e "$connect" "$1" "$2" >/dev/null 2>&1; }
reaches_from_bridge() {
  docker run --rm --network bridge --entrypoint node "$image" -e "$connect" "$1" "$2" >/dev/null 2>&1
}

if [[ "$network" != *" "* ]] && [ -n "$network" ]; then
  pass "the parse host sits on one network"
else
  fail "the parse host sits on one network" "networks: $network"
fi
if [ "$(docker network inspect --format '{{.Internal}}' "$network")" = true ]; then
  pass "that network is internal"
else
  fail "that network is internal"
fi
if [ -z "$(docker port "$id")" ]; then
  pass "the parse host publishes no port"
else
  fail "the parse host publishes no port" "$(docker port "$id")"
fi
limit="$(docker inspect --format '{{.HostConfig.Memory}}' "$id")"
if [ "$limit" = "$((1536 * 1024 * 1024))" ]; then
  pass "the parse host has its memory limit"
else
  fail "the parse host has its memory limit" "limit is $limit"
fi

# A control first: a blocked connect proves nothing unless the same target answers from a
# container that is not on the closed network.
if ! reaches_from_bridge 1.1.1.1 443; then
  fail "control: the internet answers from the default bridge"
elif reaches_from_inside 1.1.1.1 443; then
  fail "no connect to the internet from inside"
else
  pass "no connect to the internet from inside"
fi
if docker exec "$id" node -e 'require("node:dns").lookup("github.com", (e) => process.exit(e ? 1 : 0))' \
  >/dev/null 2>&1; then
  fail "no name lookup for the internet from inside"
else
  pass "no name lookup for the internet from inside"
fi

python3 -m http.server --bind 0.0.0.0 "$outside_port" >/dev/null 2>&1 &
listener=$!
gateway="$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$network")"
bridge_gateway="$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' bridge)"
for _ in $(seq 1 20); do
  if reaches_from_bridge "$bridge_gateway" "$outside_port"; then break; fi
  sleep 1
done
if ! reaches_from_bridge "$bridge_gateway" "$outside_port"; then
  fail "control: the host network answers from the default bridge"
elif reaches_from_inside "$gateway" "$outside_port" ||
  reaches_from_inside "$bridge_gateway" "$outside_port"; then
  fail "no connect to the host network from inside"
else
  pass "no connect to the host network from inside"
fi

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

keys="$(docker exec "$id" sh -c 'tr "\0" "\n" </proc/1/environ | cut -d= -f1')"
extra="$(grep -vE '^(DREFYN_PARSE_[A-Z_]+|HOME|HOSTNAME|NODE_VERSION|PATH|PWD|YARN_VERSION)$' <<<"$keys" || true)"
if [ -z "$extra" ]; then
  pass "the parse host environment holds only its own keys"
else
  fail "the parse host environment holds only its own keys" "$extra"
fi

canary="canary-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if out="$(docker run --rm -e DATABASE_URL="$canary" -e DREFYN_PARSE_TOKEN_SHA256 "$image" 2>&1)"; then
  fail "a credential in the environment stops the host"
elif [[ "$out" == *DATABASE_URL* && "$out" != *"$canary"* ]]; then
  pass "a credential in the environment stops the host, by name and not by value"
else
  fail "a credential in the environment stops the host, by name and not by value" "$out"
fi
if docker run --rm -e DREFYN_PARSE_TOKEN_SHA256= "$image" >/dev/null 2>&1; then
  fail "no token hash stops the host"
else
  pass "no token hash stops the host"
fi

# The app tier's side, from a container on the network and one that is not.
# shellcheck disable=SC2016
probe='
const url = "http://parse-host:8787/parse";
const organizationId = "00000000-0000-4000-a000-000000000001";
const projectId = "00000000-0000-4000-9000-000000000001";
const limits = { maxBytes: 1048576, maxDepth: 64, maxNodes: 100000 };
const policy = {
  version: 1,
  components: [],
  rawHtml: "sanitize",
  remoteImages: "proxy",
  linkProtocols: ["https"],
  limits,
};
const source = "# One\n";
const frame = { tenant: { organizationId, projectId }, path: "a.md", source, dialect: "md", policy };
const body = JSON.stringify(frame);
const headers = { "x-drefyn-organization": organizationId };
const post = (extra) => fetch(url, { method: "POST", body, headers: { ...headers, ...extra } });
const refused = await post({});
const answered = await post({ authorization: `Bearer ${process.env.TOKEN}` });
const result = await answered.json();
process.exit(refused.status === 401 && answered.status === 200 && result.ok === true ? 0 : 1);
'
if docker run --rm --network "$network" -e TOKEN="$token" --entrypoint node "$image" \
  --input-type=module -e "$probe"; then
  pass "the app tier reaches the host, and only with the token"
else
  fail "the app tier reaches the host, and only with the token"
fi
address="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$id")"
if reaches_from_bridge "$address" 8787; then
  fail "nothing off the network reaches the host"
else
  pass "nothing off the network reaches the host"
fi

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
docker exec "$id" sh -c "kill -9 $pid"
for _ in $(seq 1 60); do
  if [ "$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_listening || true)" -ge 2 ] &&
    docker exec "$id" node -e 'fetch("http://127.0.0.1:8787/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
      >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
crashes="$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_crashed || true)"
if [ "$crashes" -ge 1 ] && [ "$(docker logs "$id" 2>/dev/null | grep -c mdx.parse_host_listening || true)" -ge 2 ]; then
  pass "a killed host comes back behind a backoff"
else
  fail "a killed host comes back behind a backoff" "$(docker logs --tail 20 "$id" 2>&1)"
fi
if [ "$(docker inspect --format '{{.RestartCount}}' "$id")" = "$restarts" ]; then
  pass "the supervisor did that, not the container restart"
else
  fail "the supervisor did that, not the container restart"
fi

if [ "$failures" -gt 0 ]; then
  docker logs --tail 40 "$id" 2>&1 || true
  echo "parse: $failures check(s) failed" >&2
  exit 1
fi
echo "parse: passed"
