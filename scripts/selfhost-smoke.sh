#!/usr/bin/env bash
# Smoke check for the self host compose stack. Run it against a stack that is already up
# (scripts/selfhost.sh up). With the parse profile on, it checks the parse host too; --parse
# fails when that profile is off. --faults also runs scripts/selfhost-parse-test.sh, which
# kills, floods and starves a parse host of its own, never the stack's. With --teardown it then
# removes the stack and its volume and proves nothing is left behind.
set -euo pipefail

# shellcheck source=scripts/selfhost-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-lib.sh"
# shellcheck source=scripts/selfhost-parse-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/selfhost-parse-lib.sh"

teardown=false
want_parse=false
faults=false
for arg in "$@"; do
  case "$arg" in
    --teardown) teardown=true ;;
    --parse) want_parse=true ;;
    --faults)
      want_parse=true
      faults=true
      ;;
    *)
      echo "usage: $0 [--parse] [--faults] [--teardown]" >&2
      exit 64
      ;;
  esac
done

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}
finish() {
  if [ "$failures" -gt 0 ]; then
    echo "smoke: $failures check(s) failed" >&2
    exit 1
  fi
  echo "smoke: passed"
}

# Every check after this needs the compose file and a running stack, so stop early with one
# clear message instead of a page of follow on failures.
if [ ! -f "$compose_file" ]; then
  fail "compose file exists" "$compose_file not found"
  finish
fi
for tool in docker jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is installed"
    finish
  fi
done

# The checks exec into the project's postgres container and --teardown deletes volumes, so
# make sure that container is ours first.
guard_project smoke

config="$("${compose[@]}" config --format json)"
project="$(jq -r '.name' <<<"$config")"

# Ports: anything published must be bound to loopback. An empty host_ip means all interfaces.
bad_ports="$(jq -r '
  .services | to_entries[] | .key as $svc | (.value.ports // [])[]
  | select((.host_ip // "") != "127.0.0.1")
  | "\($svc) \(.published // "?"):\(.target) on \(.host_ip // "all interfaces")"
' <<<"$config")"
if [ -z "$bad_ports" ]; then
  pass "published ports bind to 127.0.0.1 only"
else
  fail "published ports bind to 127.0.0.1 only" "$bad_ports"
fi

container="$("${compose[@]}" ps -q postgres 2>/dev/null || true)"
if [ -z "$container" ]; then
  fail "postgres container is running" "project $project has no postgres container; run scripts/selfhost.sh up"
  finish
fi
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
if [ "$health" = "healthy" ]; then
  pass "postgres is healthy"
else
  fail "postgres is healthy" "health is $health: $(health_output "$container")"
  finish
fi

user="$(docker inspect --format '{{.Config.User}}' "$container")"
if [ "$user" = "postgres" ]; then
  pass "container runs as the postgres user, not root"
else
  fail "container runs as the postgres user, not root" "user is '${user:-root}'"
fi

limits="$(docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' "$container")"
read -r pids memory <<<"$limits"
if [ "${pids:-0}" -gt 0 ] && [ "${memory:-0}" -gt 0 ]; then
  pass "container has a process and a memory limit"
else
  fail "container has a process and a memory limit" "pids limit ${pids:-none}, memory ${memory:-none}"
fi

# Superuser queries go over the container's local socket. Output is unaligned, one row per line.
superuser_sql() {
  "${compose[@]}" exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -qtA -F '|' \
    --username postgres --dbname drefyn
}

# Role connections go over TCP with the role's own password, so they also prove the
# password works and that TCP is not trust.
role_sql() {
  local role="$1" secret="$2" database="${3:-drefyn}"
  # Expanded by the shell inside the container, where the secret file lives.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T -e ROLE="$role" -e SECRET="$secret" -e DATABASE="$database" postgres sh -c \
    'PGPASSWORD="$(cat "/run/secrets/$SECRET")" exec psql --no-psqlrc -v ON_ERROR_STOP=1 -qtA \
      --host 127.0.0.1 --username "$ROLE" --dbname "$DATABASE"'
}

expect_rows() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$name"
  else
    fail "$name" "expected [$expected], got [$actual]"
  fi
}

# Older 18.x servers have code execution bugs that any login role can reach. Raise this with
# each Postgres security release, so a stale image digest fails here.
min_server_version_num=180006
version="$(superuser_sql <<<"select current_setting('server_version_num')::int >= $min_server_version_num, current_setting('server_version');")"
if [[ "$version" == "t|"* ]]; then
  pass "server is at least version $min_server_version_num (${version#t|})"
else
  fail "server is at least version $min_server_version_num" "server is ${version#*|}"
fi

# Login rules come from a read only file the compose stack mounts, not from the data directory,
# so they hold from the first start whether or not init finished.
hba_file="$(superuser_sql <<<"select current_setting('hba_file');")"
expect_rows "the server reads its login rules from the mounted read only file" \
  "/etc/drefyn/pg_hba.conf" "$hba_file"
hba_rules="$(superuser_sql <<'SQL'
select type, array_to_string(database, ','), array_to_string(user_name, ','), auth_method
from pg_hba_file_rules order by rule_number;
SQL
)"
expect_rows "login rules: peer on the socket, no superuser or replication over TCP, scram otherwise" \
  "local|all|all|peer
host|all|postgres|reject
host|replication|all|reject
host|all|all|scram-sha-256" "$hba_rules"

# Role attributes. Columns: name, super, bypassrls, createrole, createdb, inherit, login.
roles="$(superuser_sql <<'SQL'
select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
from pg_roles
where rolname in ('drefyn_owner', 'drefyn_app', 'drefyn_public_reader', 'drefyn_auth')
order by rolname;
SQL
)"
expect_rows "roles exist with no superuser, bypassrls, createrole or createdb" \
  "drefyn_app|f|f|f|f|f|t
drefyn_auth|f|f|f|f|f|t
drefyn_owner|f|f|f|f|t|t
drefyn_public_reader|f|f|f|f|f|t" "$roles"

# The bootstrap superuser is the only role allowed to skip row level security.
bypass="$(superuser_sql <<'SQL'
select coalesce(string_agg(rolname, ',' order by rolname), '')
from pg_roles where (rolsuper or rolbypassrls) and rolname <> 'postgres';
SQL
)"
expect_rows "no role besides the bootstrap superuser bypasses row level security" "" "$bypass"

owner="$(superuser_sql <<<"select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'app';")"
expect_rows "schema app is owned by drefyn_owner" "drefyn_owner" "$owner"

# Owner dependencies cover every object type, so this catches a table, schema, function or
# type owned by a role that must never own anything.
owned="$(superuser_sql <<'SQL'
select coalesce(string_agg(distinct r.rolname, ',' order by r.rolname), '')
from pg_shdepend d join pg_roles r on r.oid = d.refobjid
where d.deptype = 'o' and r.rolname in ('drefyn_app', 'drefyn_public_reader', 'drefyn_auth');
SQL
)"
expect_rows "app, public reader and auth roles own nothing" "" "$owned"

public_schema="$(superuser_sql <<'SQL'
select r, has_schema_privilege(r, 'public', 'USAGE'), has_schema_privilege(r, 'public', 'CREATE')
from unnest(array['drefyn_app', 'drefyn_public_reader', 'drefyn_auth']) as r order by r;
SQL
)"
expect_rows "app, public reader and auth roles have no rights on schema public" \
  "drefyn_app|f|f
drefyn_auth|f|f
drefyn_public_reader|f|f" "$public_schema"

# The extension is created once by the bootstrap, in its own schema, so migrations never need
# a superuser. The superuser owns both, so no other role can drop them.
vector="$(superuser_sql <<'SQL'
select n.nspname, e.extversion, pg_get_userbyid(n.nspowner), pg_get_userbyid(e.extowner)
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'vector';
SQL
)"
expect_rows "pgvector 0.8.7 is installed in schema extensions, both owned by the superuser" \
  "extensions|0.8.7|postgres|postgres" "$vector"

# Exactly these entries: the owner and both readers may use the schema, nobody but the superuser may
# create in it, and PUBLIC has nothing.
extension_acl="$(superuser_sql <<<"select nspacl from pg_namespace where nspname = 'extensions';")"
# drefyn_auth reads identity tables only and never needs pgvector, so it gets no entry here.
expect_rows "only owner, app and the readers may use schema extensions, and only the superuser may create in it" \
  "{postgres=UC/postgres,drefyn_owner=U/postgres,drefyn_app=U/postgres,drefyn_public_reader=U/postgres,drefyn_protected_reader=U/postgres}" \
  "$extension_acl"

# The search path is a database setting, so a role can only drift from it by changing its
# own settings, and those must stay empty.
search_path="$(superuser_sql <<'SQL'
select coalesce(array_to_string(s.setconfig, ';'), '')
from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
where d.datname = 'drefyn' and s.setrole = 0;
SQL
)"
expect_rows "database drefyn searches app, then extensions" "search_path=app, extensions" "$search_path"

# rolconfig must be null, not just empty, and pg_db_role_setting covers settings a role made
# for one database only, which rolconfig does not show.
role_settings="$(superuser_sql <<'SQL'
select r.rolname, r.rolconfig is null,
  (select count(*) from pg_db_role_setting s where s.setrole = r.oid)
from pg_roles r
where r.rolname in ('drefyn_owner', 'drefyn_app', 'drefyn_public_reader', 'drefyn_auth',
  'drefyn_protected_reader')
order by r.rolname;
SQL
)"
expect_rows "no role carries its own settings: rolconfig is null and pg_db_role_setting has no rows" \
  "drefyn_app|t|0
drefyn_auth|t|0
drefyn_owner|t|0
drefyn_protected_reader|t|0
drefyn_public_reader|t|0" "$role_settings"

# PUBLIC gets nothing on the database: no CONNECT for roles created later, no TEMP for anyone.
# The database owner's own entry is left out; it is the bootstrap superuser.
database_acl="$(superuser_sql <<'SQL'
select coalesce(string_agg(entry, ',' order by entry), '')
from (
  select case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
    || ':' || a.privilege_type as entry
  from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  where d.datname = current_database() and a.grantee <> d.datdba
) entries;
SQL
)"
expect_rows "only the five roles may connect, and PUBLIC has no rights on the database" \
  "drefyn_app:CONNECT,drefyn_auth:CONNECT,drefyn_owner:CONNECT,drefyn_protected_reader:CONNECT,drefyn_public_reader:CONNECT" \
  "$database_acl"

# The same for the databases every cluster has, so a role made later has nowhere to go.
other_acl="$(superuser_sql <<'SQL'
select d.datname, coalesce((
  select string_agg(case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
    || ':' || a.privilege_type, ',' order by a.privilege_type)
  from aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  where a.grantee <> d.datdba), '')
from pg_database d where d.datname in ('postgres', 'template1') order by d.datname;
SQL
)"
expect_rows "nobody but the superuser may connect to postgres or template1" "postgres|
template1|" "$other_acl"

whoami="$(role_sql drefyn_app drefyn_app_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_app logs in over TCP with its password" "drefyn_app" "$whoami"
whoami="$(role_sql drefyn_public_reader drefyn_public_reader_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_public_reader logs in over TCP with its password" "drefyn_public_reader" "$whoami"
whoami="$(role_sql drefyn_auth drefyn_auth_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_auth logs in over TCP with its password" "drefyn_auth" "$whoami"
whoami="$(role_sql drefyn_protected_reader drefyn_protected_reader_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_protected_reader logs in over TCP with its password" "drefyn_protected_reader" "$whoami"

wrong="$("${compose[@]}" exec -T -e PGPASSWORD=not-the-password postgres \
  psql --no-psqlrc -qtA --host 127.0.0.1 --username drefyn_app --dbname drefyn -c 'select 1' 2>&1 || true)"
if [[ "$wrong" == *"password authentication failed"* ]]; then
  pass "a wrong password is refused over TCP"
else
  fail "a wrong password is refused over TCP" "$wrong"
fi

# Even the right superuser password is refused over TCP; operators use docker exec.
# shellcheck disable=SC2016
super_tcp="$("${compose[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --no-psqlrc -qtA \
    --host 127.0.0.1 --username postgres --dbname drefyn -c "select 1"' 2>&1 || true)"
if [[ "$super_tcp" == *"pg_hba.conf rejects connection"* ]]; then
  pass "the superuser cannot log in over TCP, even with its password"
else
  fail "the superuser cannot log in over TCP, even with its password" "$super_tcp"
fi

# Physical replication is a separate pg_hba database keyword, and a replication session can
# copy every tenant's data and every password verifier. Nothing here replicates.
# shellcheck disable=SC2016
replication="$("${compose[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --no-psqlrc -qtA \
    "host=127.0.0.1 user=postgres dbname=replication replication=true" -c IDENTIFY_SYSTEM' 2>&1 || true)"
if [[ "$replication" == *"pg_hba.conf rejects replication connection"* ]]; then
  pass "physical replication is refused over TCP"
else
  fail "physical replication is refused over TCP" "$replication"
fi

# The socket must check the OS user, or any process in the container could be any role.
peer="$("${compose[@]}" exec -T postgres psql --no-psqlrc -qtA --username drefyn_app \
  --dbname drefyn -c 'select 1' 2>&1 || true)"
if [[ "$peer" == *"Peer authentication failed"* ]]; then
  pass "the socket refuses a role that does not match the OS user"
else
  fail "the socket refuses a role that does not match the OS user" "$peer"
fi

# Each statement must fail with a permission error, not succeed and not fail for another reason.
expect_denied() {
  local role="$1" secret="$2" statement="$3" message="$4" database="${5:-drefyn}" out name
  name="$role cannot run in $database: $statement"
  if out="$(role_sql "$role" "$secret" "$database" <<<"$statement" 2>&1)"; then
    fail "$name" "it succeeded"
  elif [[ "$out" == *"$message"* ]]; then
    pass "$name"
  else
    fail "$name" "unexpected error: $out"
  fi
}
for pair in "drefyn_app drefyn_app_password" "drefyn_public_reader drefyn_public_reader_password" \
  "drefyn_auth drefyn_auth_password" "drefyn_protected_reader drefyn_protected_reader_password"; do
  read -r role secret <<<"$pair"
  expect_denied "$role" "$secret" "create table app.smoke (id int);" "permission denied for schema app"
  expect_denied "$role" "$secret" "create table public.smoke (id int);" "permission denied for schema public"
  expect_denied "$role" "$secret" "create table extensions.smoke (id int);" \
    "permission denied for schema extensions"
  expect_denied "$role" "$secret" "create temp table smoke (id int);" \
    'permission denied to create temporary tables in database "drefyn"'
  expect_denied "$role" "$secret" "create schema smoke;" "permission denied for database drefyn"
  for database in postgres template1; do
    expect_denied "$role" "$secret" "select 1;" "permission denied for database \"$database\"" "$database"
  done
done

# The owner runs migrations but must not be able to remove pgvector or hide objects in its
# schema, where the catalog checks do not look. Each runs in a transaction that is rolled back.
expect_denied drefyn_owner drefyn_owner_password "begin; drop schema extensions cascade; rollback;" \
  "must be owner of schema extensions"
expect_denied drefyn_owner drefyn_owner_password "create table extensions.smoke (id int);" \
  "permission denied for schema extensions"
expect_denied drefyn_owner drefyn_owner_password \
  "create function extensions.p() returns int language sql as 'select 1';" \
  "permission denied for schema extensions"
expect_denied drefyn_owner drefyn_owner_password "alter extension vector update;" \
  "must be owner of extension vector"
owner_vector="$(role_sql drefyn_owner drefyn_owner_password 2>&1 <<'SQL' || true
begin;
create table app.smoke_vector (v vector(2));
create index on app.smoke_vector using hnsw (v vector_cosine_ops);
insert into app.smoke_vector values ('[1,0]');
select v <=> '[0,1]' from app.smoke_vector;
rollback;
SQL
)"
expect_rows "drefyn_owner can create a vector column with an HNSW index in app" "1" "$owner_vector"

# Unqualified, so this also proves each role finds the type through its search_path.
for pair in "drefyn_owner drefyn_owner_password" "drefyn_app drefyn_app_password" \
  "drefyn_public_reader drefyn_public_reader_password"; do
  read -r role secret <<<"$pair"
  distance="$(role_sql "$role" "$secret" 2>&1 \
    <<<"select '[1,0]'::vector <=> '[0,1]'::vector, '[1,2]'::vector <=> '[2,4]'::vector;" || true)"
  expect_rows "$role computes cosine distance with pgvector" "1|0" "$distance"
done

# Run the bootstrap again, as an operator might by mistake on a managed database, with
# statement logging forced on. It must refuse before any role is touched, and the server log
# must never see a password.
canary="smokecanary$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
rerun="$("${compose[@]}" exec -T -e PGOPTIONS='-c log_statement=all' \
  -e DREFYN_OWNER_PASSWORD="$canary" -e DREFYN_APP_PASSWORD="$canary" \
  -e DREFYN_PUBLIC_READER_PASSWORD="$canary" -e DREFYN_AUTH_PASSWORD="$canary" \
  -e DREFYN_PROTECTED_READER_PASSWORD="$canary" postgres \
  psql --no-psqlrc --username postgres --dbname drefyn --file /etc/drefyn/bootstrap.sql 2>&1 || true)"
if [[ "$rerun" == *"the bootstrap has already run"* ]]; then
  pass "a second bootstrap stops before creating anything"
else
  fail "a second bootstrap stops before creating anything" "$rerun"
fi
# The server writes its log as it goes, but docker collects it on its own schedule. Wait for a
# marker logged after the rerun, so a missing canary means it was never written.
marker="smokemarker$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
superuser_sql <<<"do \$\$ begin raise log '%', '$marker'; end \$\$;" >/dev/null
server_log=""
for _ in $(seq 1 20); do
  server_log="$(docker logs "$container" 2>&1)"
  if [[ "$server_log" == *"$marker"* ]]; then break; fi
  sleep 0.5
done
if [[ "$server_log" != *"$marker"* ]]; then
  fail "the server log never shows a password" "marker $marker did not reach docker logs"
elif [[ "$server_log" == *"$canary"* ]]; then
  fail "the server log never shows a password" \
    "$(grep -c "$canary" <<<"$server_log") log line(s) hold the canary password"
else
  pass "the server log never shows a password"
fi

# The upgrade an older volume needs must be a no op on a stack the current bootstrap made.
if out="$("${compose[@]}" exec -T postgres sh /etc/drefyn/upgrade/run.sh 2>&1)"; then
  if [[ "$out" == *"drefyn_auth already exists"* ]]; then
    pass "the upgrade is a no op on a fresh stack"
  else
    fail "the upgrade is a no op on a fresh stack" "$out"
  fi
else
  fail "the upgrade is a no op on a fresh stack" "$out"
fi

# The API service, when its profile is on (COMPOSE_PROFILES=api). It must come up with nothing
# but this stack, hold no auth role or secret, answer health and readiness, refuse to start
# beside an auth secret, and stop cleanly on SIGTERM.
if jq -e '.services | has("api")' <<<"$config" >/dev/null; then
  api="$("${compose[@]}" ps -q api 2>/dev/null || true)"
  if [ -z "$api" ]; then
    fail "api container is running" "the api profile is on but project $project has no api container"
  else
    api_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$api")"
    if [ "$api_health" = "healthy" ]; then
      pass "api is healthy"
    else
      fail "api is healthy" "health is $api_health: $(health_output "$api")"
    fi
    api_user="$(docker inspect --format '{{.Config.User}}' "$api")"
    expect_rows "api runs as the node user, not root" "node" "$api_user"
    read -r api_pids api_memory <<<"$(docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' "$api")"
    if [ "${api_pids:-0}" -gt 0 ] && [ "${api_memory:-0}" -gt 0 ]; then
      pass "api has a process and a memory limit"
    else
      fail "api has a process and a memory limit" "pids limit ${api_pids:-none}, memory ${api_memory:-none}"
    fi
    # Names only: the values are never printed.
    api_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api" | cut -d= -f1)"
    leaked="$(grep -E '^DREFYN_AUTH_|_PASSWORD$|_DATABASE_URL$|^DREFYN_API_RATE_LIMIT_KEY$' <<<"$api_env" || true)"
    if [ -z "$leaked" ]; then
      pass "api holds no auth setting, password, database URL or limiter key in its environment"
    else
      fail "api holds no auth setting, password, database URL or limiter key in its environment" \
        "found: $(tr '\n' ' ' <<<"$leaked")"
    fi
    api_port="$("${compose[@]}" port api 3100 | sed 's/.*://')"
    for path in healthz readyz; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$api_port/$path" || true)"
      expect_rows "api answers /$path with 200" "200" "$code"
    done
    missing="$(curl -s --max-time 5 "http://127.0.0.1:$api_port/v1/nothing" || true)"
    expect_rows "api answers an unknown path with the one error body" \
      "api.not_found" "$(jq -r '.error.code' <<<"$missing" 2>/dev/null || true)"
    # The image's own entry point, with an auth secret added: it must exit 1 naming the key.
    refused_out="$("${compose[@]}" run --rm --no-deps -T -e DREFYN_AUTH_SECRET=smoke-not-a-secret \
      api 2>&1)" && refused_code=0 || refused_code=$?
    if [ "$refused_code" -eq 1 ] && [[ "$refused_out" == *'"key":"DREFYN_AUTH_SECRET"'* ]] &&
      [[ "$refused_out" != *smoke-not-a-secret* ]]; then
      pass "api refuses to start beside an auth secret, naming the key and never the value"
    else
      fail "api refuses to start beside an auth secret, naming the key and never the value" \
        "exit $refused_code: $(tail -n 3 <<<"$refused_out")"
    fi
    "${compose[@]}" stop api >/dev/null 2>&1 || true
    stopped="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$api")"
    # Read whole, not piped into grep -q: an early exit there would fail the pipe under pipefail.
    api_log="$(docker logs "$api" 2>&1 || true)"
    if [ "$stopped" = "exited 0" ] && [[ "$api_log" == *'"event":"api.stopped"'* ]]; then
      pass "api drains and exits 0 on SIGTERM"
    else
      fail "api drains and exits 0 on SIGTERM" "state $stopped"
    fi
    if ! out="$("${compose[@]}" up --detach --wait --wait-timeout 60 api 2>&1)"; then
      fail "api starts again after the stop" "$(tail -n 3 <<<"$out")"
    fi
  fi
fi

# Search, when its profile is on (COMPOSE_PROFILES=search). It must come up with nothing paid,
# keep its admin key out of docker inspect and the command line, refuse requests without a key,
# and hand out scoped keys that hold: a scoped search returns only its own tenant's document,
# even when the request asks for another's by id through pinned_hits.
if jq -e '.services | has("typesense")' <<<"$config" >/dev/null; then
  ts="$("${compose[@]}" ps -q typesense 2>/dev/null || true)"
  if [ -z "$ts" ]; then
    fail "typesense container is running" "the search profile is on but project $project has no typesense container"
  else
    ts_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$ts")"
    if [ "$ts_health" = "healthy" ]; then
      pass "typesense is healthy"
    else
      fail "typesense is healthy" "health is $ts_health: $(health_output "$ts")"
    fi
    ts_box="$(docker inspect --format '{{.HostConfig.CapDrop}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' "$ts")"
    read -r ts_caps ts_pids ts_memory <<<"$ts_box"
    if [ "$ts_caps" = "[ALL]" ] && [ "${ts_pids:-0}" -gt 0 ] && [ "${ts_memory:-0}" -gt 0 ]; then
      pass "typesense drops every capability and has a process and a memory limit"
    else
      fail "typesense drops every capability and has a process and a memory limit" "$ts_box"
    fi
    # Names only from the environment; the command line is checked for the key's value below.
    ts_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$ts" | cut -d= -f1)"
    if ! grep -q '^TYPESENSE_API_KEY$' <<<"$ts_env"; then
      pass "typesense has no admin key in its container environment"
    else
      fail "typesense has no admin key in its container environment"
    fi
    admin="$(sed -n 's/^DREFYN_SEARCH_ADMIN_KEY=//p' "$selfhost_root/deploy/.env" | tail -n 1)"
    ts_args="$(docker inspect --format '{{.Path}} {{json .Args}}' "$ts")"
    ts_proc="$("${compose[@]}" exec -T typesense sh -c 'tr "\0" " " </proc/1/cmdline' 2>/dev/null || true)"
    if [ -n "$admin" ] && [[ "$ts_args$ts_proc" != *"$admin"* ]] && [ -n "$ts_proc" ]; then
      pass "typesense's admin key is not on its command line"
    else
      fail "typesense's admin key is not on its command line"
    fi
    ts_port="$("${compose[@]}" port typesense 8108 | sed 's/.*://')"
    ts_url="http://127.0.0.1:$ts_port"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$ts_url/health" || true)"
    expect_rows "typesense answers /health with 200" "200" "$code"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$ts_url/collections" || true)"
    expect_rows "typesense refuses a request with no key" "401" "$code"

    # The admin key goes to curl in a header file, never as an argument.
    ts_scratch="$(mktemp -d)"
    chmod 700 "$ts_scratch"
    printf 'x-typesense-api-key: %s\n' "$admin" >"$ts_scratch/admin"
    ts_call() {
      local method="$1" path="$2" headers="$3" body="${4:-}"
      if [ -n "$body" ]; then
        curl -s --max-time 10 -X "$method" -H "@$headers" -H 'content-type: application/json' \
          --data-binary "$body" "$ts_url$path" || true
      else
        curl -s --max-time 10 -X "$method" -H "@$headers" "$ts_url$path" || true
      fi
    }
    hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
    collection="docs_pub_$(hex 16)"
    parent="$(hex 24)"
    ts_call POST /collections "$ts_scratch/admin" \
      "{\"name\":\"$collection\",\"fields\":[{\"name\":\"organization_id\",\"type\":\"string\"},{\"name\":\"body\",\"type\":\"string\"}]}" >/dev/null
    for doc in a b; do
      ts_call POST "/collections/$collection/documents" "$ts_scratch/admin" \
        "{\"id\":\"$doc\",\"organization_id\":\"org-$doc\",\"body\":\"smoke canary\"}" >/dev/null
    done
    key_id="$(ts_call POST /keys "$ts_scratch/admin" \
      "{\"description\":\"smoke\",\"actions\":[\"documents:search\"],\"collections\":[\"$collection\"],\"value\":\"$parent\"}" |
      jq -r '.id // empty' 2>/dev/null || true)"
    params="{\"filter_by\":\"organization_id:=\`org-a\`\",\"expires_at\":$(($(date +%s) + 60)),\"filter_curated_hits\":true,\"enable_overrides\":false}"
    digest="$(printf '%s' "$params" | openssl dgst -sha256 -hmac "$parent" -binary | base64)"
    scoped="$(printf '%s%s%s' "$digest" "${parent:0:4}" "$params" | base64 | tr -d '\n')"
    printf 'x-typesense-api-key: %s\n' "$scoped" >"$ts_scratch/scoped"
    found="$(ts_call GET "/collections/$collection/documents/search?q=canary&query_by=body" "$ts_scratch/scoped" |
      jq -r '[.hits[]?.document.id] | sort | join(",")' 2>/dev/null || true)"
    expect_rows "a scoped key finds its own tenant's document" "a" "$found"
    found="$(ts_call GET "/collections/$collection/documents/search?q=*&query_by=body&pinned_hits=b:1&filter_curated_hits=false&filter_by=organization_id:=org-b" "$ts_scratch/scoped" |
      jq -r '[.hits[]?.document.id] | sort | join(",")' 2>/dev/null || true)"
    expect_rows "a scoped key cannot be widened with pinned_hits or filter_by" "" "$found"
    if [ -n "$key_id" ]; then ts_call DELETE "/keys/$key_id" "$ts_scratch/admin" >/dev/null; fi
    ts_call DELETE "/collections/$collection" "$ts_scratch/admin" >/dev/null
    rm -rf "$ts_scratch"
  fi
fi

# The parse host, when its profile is on. Everything here only looks; the checks that kill or
# flood a host run on one of their own.
if jq -e '.services["parse-host"]' <<<"$config" >/dev/null; then
  parse_container="$("${compose[@]}" ps -q parse-host 2>/dev/null || true)"
  parse_health=""
  if [ -n "$parse_container" ]; then
    parse_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$parse_container")"
  fi
  if [ "$parse_health" = healthy ]; then
    pass "the parse host is healthy"
    env_file="$selfhost_root/deploy/.env"
    parse_token="$(sed -n 's/^DREFYN_PARSE_HOST_TOKEN=//p' "$env_file" | tail -n 1)"
    parse_hash="$(jq -r '.services["parse-host"].environment.DREFYN_PARSE_TOKEN_SHA256 // ""' <<<"$config")"
    if [ -n "$parse_token" ] &&
      [ "$(printf '%s' "$parse_token" | shasum -a 256 | cut -d' ' -f1)" = "$parse_hash" ]; then
      pass "the parse host's token hash is the hash of the token in deploy/.env"
    else
      fail "the parse host's token hash is the hash of the token in deploy/.env" \
        "set DREFYN_PARSE_HOST_TOKEN and its SHA-256 as DREFYN_PARSE_TOKEN_SHA256, then run restart"
    fi
    parse_memory="$(jq -r '.services["parse-host"].environment.DREFYN_PARSE_HOST_MEMORY_MB' <<<"$config")"
    parse_boundary_checks "$parse_container" "$parse_token" "$parse_memory"
  else
    fail "the parse host is healthy" "${parse_health:-no running container}; run scripts/selfhost.sh up"
  fi
elif [ "$want_parse" = true ]; then
  fail "the parse host is on" "set COMPOSE_PROFILES=parse in the shell or in deploy/.env, then run scripts/selfhost.sh up"
fi
if [ "$faults" = true ]; then
  if bash "$selfhost_root/scripts/selfhost-parse-test.sh"; then
    pass "the parse host survives its faults"
  else
    fail "the parse host survives its faults" "the failures are above"
  fi
fi

if [ "$teardown" = true ]; then
  if ! out="$("${compose[@]}" down --volumes --timeout 30 2>&1)"; then
    fail "down --volumes succeeds" "$out"
    finish
  fi
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  if [ -z "$left" ]; then
    pass "down --volumes removes every container"
  else
    fail "down --volumes removes every container" "still present: $left"
  fi
  left="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  if [ -z "$left" ]; then
    pass "down --volumes removes the data volume"
  else
    fail "down --volumes removes the data volume" "still present: $left"
  fi
fi

finish
