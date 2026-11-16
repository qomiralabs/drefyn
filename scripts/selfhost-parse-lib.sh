# shellcheck shell=bash
# Checks on a running parse host that change nothing, shared by the smoke check, which runs
# them on the stack's own host, and the parse test, which runs them on one it started. The
# caller defines pass and fail. Sourced, not run.

# Runs a connect from inside a container: exit 0 means it reached something.
parse_connect_js='
const [host, port] = process.argv.slice(1);
const socket = require("node:net").connect({ host, port: Number(port), timeout: 3000 });
socket.on("connect", () => process.exit(0));
socket.on("timeout", () => process.exit(1));
socket.on("error", () => process.exit(1));
'

# Tries every TCP port on each address given and prints the ones that answer. Closed ports on
# a bridge answer with a reset at once, so the whole range takes seconds, not hours.
# shellcheck disable=SC2016
parse_scan_js='
const net = require("node:net");
const targets = process.argv.slice(1);
const open = [];
const jobs = [];
for (const host of targets) for (let port = 1; port <= 65535; port += 1) jobs.push([host, port]);
let next = 0;
const worker = () =>
  new Promise((resolve) => {
    const step = () => {
      const job = jobs[next++];
      if (job === undefined) return resolve();
      const socket = net.connect({ host: job[0], port: job[1], timeout: 1000 });
      const done = (hit) => {
        if (hit) open.push(`${job[0]}:${job[1]}`);
        socket.destroy();
        step();
      };
      socket.on("connect", () => done(true));
      socket.on("timeout", () => done(false));
      socket.on("error", () => done(false));
    };
    step();
  });
Promise.all(Array.from({ length: 512 }, worker)).then(() => {
  process.stdout.write(open.join(" "));
});
'

parse_image=drefyn-parse-host:local

parse_reaches_from_inside() {
  docker exec "$1" node -e "$parse_connect_js" "$2" "$3" >/dev/null 2>&1
}
parse_reaches_from_bridge() {
  docker run --rm --network bridge --entrypoint node "$parse_image" -e "$parse_connect_js" \
    "$1" "$2" >/dev/null 2>&1
}

# parse_network_of <container>: the one network it is on, or every name when it is on several.
parse_network_of() {
  local names
  names="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$1")"
  printf '%s' "${names% }"
}

# parse_open_neighbour_ports <container> <network>: every port that answers the parse host on
# any other container on its network. The app tier joins this network to reach the host, and
# internal only closes the way out, so whatever a neighbour listens on there is reachable from
# a taken host.
parse_open_neighbour_ports() {
  local id="$1" network="$2" addresses
  addresses="$(docker network inspect --format \
    '{{range $cid, $c := .Containers}}{{$cid}} {{$c.IPv4Address}}{{"\n"}}{{end}}' "$network" |
    awk -v self="$(docker inspect --format '{{.Id}}' "$id")" '$1 != self && $2 != "" { sub(/\/.*/, "", $2); print $2 }')"
  if [ -z "$addresses" ]; then return 0; fi
  # One address per word; splitting is the point.
  # shellcheck disable=SC2086
  docker exec "$id" node -e "$parse_scan_js" $addresses
}

# parse_app_probe_js: a parse from the app tier's side, then the same request with no token.
# shellcheck disable=SC2016
parse_app_probe_js='
const url = `http://${process.env.PARSE_HOST}:8787/parse`;
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

# parse_app_reaches <network> <service name> <token>: true when a container on the network gets
# a parse with the token and a 401 without it.
parse_app_reaches() {
  docker run --rm --network "$1" -e PARSE_HOST="$2" -e TOKEN="$3" --entrypoint node \
    "$parse_image" --input-type=module -e "$parse_app_probe_js" >/dev/null 2>&1
}

# parse_boundary_checks <container> <token> <memory MB>: the host is closed in, holds nothing,
# and answers the app tier.
parse_boundary_checks() {
  local id="$1" token="$2" memory_mb="$3" network limit swap gateway bridge_gateway listener=""
  local outside_port=18790 keys extra address open target reached machine targets
  network="$(parse_network_of "$id")"

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
  swap="$(docker inspect --format '{{.HostConfig.MemorySwap}}' "$id")"
  if [ "$limit" = "$((memory_mb * 1024 * 1024))" ] && [ "$swap" = "$limit" ]; then
    pass "the parse host's memory limit is DREFYN_PARSE_HOST_MEMORY_MB, with no swap"
  else
    fail "the parse host's memory limit is DREFYN_PARSE_HOST_MEMORY_MB, with no swap" \
      "limit $limit, with swap $swap, want $((memory_mb * 1024 * 1024))"
  fi

  # A control first: a blocked connect proves nothing unless the same target answers from a
  # container that is not on the closed network.
  if ! parse_reaches_from_bridge 1.1.1.1 443; then
    fail "control: the internet answers from the default bridge"
  elif parse_reaches_from_inside "$id" 1.1.1.1 443; then
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
  # On Linux the machine answers at the bridge's gateway. Docker Desktop runs containers in a
  # VM, where the machine is host.docker.internal instead.
  machine=()
  for _ in $(seq 1 20); do
    for target in "$bridge_gateway" host.docker.internal; do
      if parse_reaches_from_bridge "$target" "$outside_port"; then machine+=("$target"); fi
    done
    if [ "${#machine[@]}" -gt 0 ]; then break; fi
    sleep 1
  done
  # With inhibit_ipv4 the network may have no gateway at all. Docker then prints nothing or
  # "invalid IP", and either would be a connect that fails for the wrong reason.
  targets=(${machine[@]+"${machine[@]}"})
  if [[ "$gateway" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then targets+=("$gateway"); fi
  reached=""
  if [ "${#machine[@]}" = 0 ]; then
    fail "control: the host network answers from the default bridge"
  else
    for target in "${targets[@]}"; do
      if parse_reaches_from_inside "$id" "$target" "$outside_port"; then reached+=" $target"; fi
    done
    if [ -n "$reached" ]; then
      fail "no connect to the host network from inside" "reached$reached"
    else
      pass "no connect to the host network from inside (tried ${targets[*]})"
    fi
  fi
  kill "$listener" 2>/dev/null || true
  wait "$listener" 2>/dev/null || true

  keys="$(docker exec "$id" sh -c 'tr "\0" "\n" </proc/1/environ | cut -d= -f1')"
  extra="$(grep -vE '^(DREFYN_PARSE_[A-Z0-9_]+|HOME|HOSTNAME|NODE_VERSION|PATH|PWD|YARN_VERSION)$' <<<"$keys" || true)"
  if [ -z "$extra" ]; then
    pass "the parse host environment holds only its own keys"
  else
    fail "the parse host environment holds only its own keys" "$extra"
  fi
  if grep -qx DREFYN_PARSE_HOST_TOKEN <<<"$keys"; then
    fail "the parse host holds the token's hash and not the token"
  else
    pass "the parse host holds the token's hash and not the token"
  fi

  if parse_app_reaches "$network" parse-host "$token"; then
    pass "the app tier reaches the host, and only with the token"
  else
    fail "the app tier reaches the host, and only with the token"
  fi
  address="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$id")"
  if parse_reaches_from_bridge "$address" 8787; then
    fail "nothing off the network reaches the host"
  else
    pass "nothing off the network reaches the host"
  fi

  if open="$(parse_open_neighbour_ports "$id" "$network")" && [ -z "$open" ]; then
    pass "no neighbour on the parse network answers the host on any port"
  else
    fail "no neighbour on the parse network answers the host on any port" "answered: ${open:-scan failed}"
  fi
}
