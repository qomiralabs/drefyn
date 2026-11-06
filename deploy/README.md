# Self host stack

Docker Compose files for running Drefyn yourself. Today the stack is Postgres with pgvector;
other services join it as they are built.

The parse host is the one service that does not start with the stack. It is off behind the
`parse` compose profile until the app tier joins it. See [The parse host](#the-parse-host).

## Requirements

- Docker Engine 25 or later, for the healthcheck's start interval
- Docker Compose 2.23.1 or later, for secrets read from the environment
- `jq`, for the scripts and the smoke check

## Start, stop, reset

From the repository root:

```sh
bash scripts/selfhost.sh up            # first run writes deploy/.env with random passwords
bash scripts/selfhost-smoke.sh         # checks health, roles, grants, pgvector and port bindings
bash scripts/selfhost.sh restart       # recreates the container from deploy/.env
bash scripts/selfhost.sh upgrade       # adds what an older volume lacks; see Upgrading a volume
bash scripts/selfhost.sh down          # keeps the data volume
bash scripts/selfhost.sh reset --yes   # deletes the data volume
```

`up` pulls the image first (about 150 MB), then waits until Postgres is healthy and prints
how long that took: 2 to 6 seconds from an empty volume on an Apple silicon laptop, 2 to 4
seconds on a restart, which recreates the container. Like `restart`, `up` recreates the
container when the stack is already
running, so Postgres is down for a few seconds.

To write `deploy/.env` yourself, copy `deploy/.env.example`, set `DREFYN_STACK_ID` to any
random value (it is not a secret, but it must never change after the first start and must not
be copied to another checkout), and fill every password, including the superuser's, with at
least 16 random characters. Empty or short passwords stop the first start on purpose, and the
superuser stays closed to TCP even then. `deploy/.env` is gitignored; make it readable only by
you (`chmod 600 deploy/.env`, which `up` warns about if you forget) and keep it out of backups
that others can read. Two first `up` runs at once share one generated file.

If `up` fails, it says whether compose could not start the container or the healthcheck
failed, with the last healthcheck message, and prints the command that shows the server log.
A first start that was interrupted leaves nothing in the log; `reset --yes` and `up` again.

## Postgres

| Setting   | Value                                                                 |
| --------- | --------------------------------------------------------------------- |
| Image     | `pgvector/pgvector:0.8.7-pg18-bookworm`, pinned by digest             |
| Host port | `127.0.0.1:55432` (`DREFYN_POSTGRES_PORT`), never on other interfaces |
| Database  | `drefyn`                                                              |
| Data      | named volume `pgdata`                                                 |
| Limits    | 512 processes, 1 GB memory (`DREFYN_POSTGRES_MEMORY_LIMIT`)           |

The container runs as the `postgres` user with all capabilities dropped. Passwords reach it
as Compose secrets, so they appear as files in `/run/secrets` and not in `docker inspect`.
Local socket logins use peer authentication and every TCP login needs a password, loopback
included. The superuser cannot log in over TCP at all, even with its password, and nothing can
start a replication session; reach the superuser with
`docker compose exec postgres psql -U postgres -d drefyn`. These rules live in
`postgres/pg_hba.conf`, which the server reads from a read only mount rather than from the
data directory, so they hold from the very first start, even one that stopped halfway.

On the first start, with an empty volume, `postgres/bootstrap.sql` runs once as the
superuser and creates:

| Role                   | Purpose                                        | Notes                                     |
| ---------------------- | ---------------------------------------------- | ----------------------------------------- |
| `drefyn_owner`         | Owns schema `app`; migrations run as this role | no superuser, no `BYPASSRLS`              |
| `drefyn_app`           | The application's connection                   | owns nothing, `NOINHERIT`, no `BYPASSRLS` |
| `drefyn_public_reader` | Public read paths only                         | owns nothing, `NOINHERIT`, no `BYPASSRLS` |
| `drefyn_auth`          | Sign in lookups, before anyone is known        | owns nothing, `NOINHERIT`, no `BYPASSRLS` |

It also:

- creates schema `extensions` and installs pgvector there, both owned by the superuser.
  pgvector is not a trusted extension, so only a superuser can create it; migrations never
  need to. `drefyn_owner`, `drefyn_app` and `drefyn_public_reader` get `USAGE` on the schema;
  none can create, drop or change anything in it. `drefyn_auth` never needs pgvector and gets
  nothing there.
- sets the `drefyn` database's `search_path` to `app, extensions`, so `vector` works
  unqualified. The roles carry no settings of their own.
- revokes every right on schema `public` from `PUBLIC`.
- revokes `CONNECT` and `TEMP` on the `drefyn` database from `PUBLIC` and grants `CONNECT`
  to the four roles only. A role created later cannot connect until it is granted, and no
  role can create temporary tables in `drefyn`.
- revokes every right on the `postgres` and `template1` databases from `PUBLIC`, so the
  four roles and any role created later cannot connect to them.

Grants on `app` and row level security policies come from migrations.

The image runs the newest patched PostgreSQL 18 minor (18.6) with pgvector 0.8.7. Managed
Postgres ships pgvector 0.8.2 today; the two have the same SQL surface, and the schema uses
nothing newer than what managed Postgres offers.

### Upgrading a volume

A volume first started before `drefyn_auth` existed has only the first three roles. The
bootstrap never runs twice and `drefyn_owner` cannot create roles, so after pulling a version
that adds the role, `up` fails with `role drefyn_auth is missing` and migrations exit 4 naming
it. The fix is one command, which is safe to run again:

```sh
bash scripts/selfhost.sh upgrade
```

It adds a generated `DREFYN_AUTH_PASSWORD` to `deploy/.env` if the file has none, recreates
the container so the new secret is mounted, runs every script in `postgres/upgrade/` as the
superuser over the socket, and waits until the stack is healthy. Your data is not touched.

Each script reads its quiet log settings from `postgres/quiet-log.sql`, the same file the
bootstrap uses, so the password never reaches the server log or `pg_stat_statements`. If
`drefyn_auth` already exists with other attributes, for example `BYPASSRLS` or a membership in
another role, the script names what differs and changes nothing; fix the role as the
superuser and run it again. The scripts need psql 10 or later, which the image has.

### Upgrading pgvector

Migrations cannot change the extension, so after an image change that brings a newer
pgvector, update it as the superuser:

```sh
docker compose -f deploy/compose.yaml exec -T postgres psql --no-psqlrc -U postgres -d drefyn -c 'alter extension vector update'
```

A database bootstrapped from an earlier build of this stack, where `drefyn_owner` owned
schema `extensions`, gets the superuser back as owner with these two statements, run the
same way:

```sql
alter schema extensions owner to postgres;
revoke create on schema extensions from drefyn_owner;
```

Earlier builds also differ in role settings and logins, so on a volume with nothing worth
keeping, `bash scripts/selfhost.sh reset --yes` and `up` is simpler.

If the first start fails (for example because a password was too short), the volume is left
half initialised and the container stays unhealthy. Fix `deploy/.env`, then run
`bash scripts/selfhost.sh reset --yes` and `up` again.

## Changing a password

Passwords are set in the database once, on the first start. Editing `deploy/.env` alone does
not change them. `restart` copies `deploy/.env` into the container again, and the healthcheck
logs in as every role with it, so a password that only changed in `deploy/.env` fails the
restart with a message naming the role. To change one, for example the app's:

```sh
docker compose -f deploy/compose.yaml exec postgres psql -U postgres -d drefyn -c '\password drefyn_app'
# then put the same password in deploy/.env and run
bash scripts/selfhost.sh restart
```

`\password` hashes the new password before sending it, so the plain text never reaches the
server or its log. The superuser's password is only used during the first start, because
the superuser has no TCP login, so changing it in `deploy/.env` later has no effect.

## Auth keys

The dashboard does not run in this compose file yet. These sections describe its settings and
commands so `deploy/.env` is ready when it does.

`up` also writes three dashboard keys to `deploy/.env`, each exactly 32 random bytes in
unpadded base64url: `DREFYN_AUTH_SECRET`, `DREFYN_AUTH_INVITATION_BLOCK_KEY` and
`DREFYN_API_RATE_LIMIT_KEY`. It never prints them. A `deploy/.env` from before a key existed
gets that key appended by `up` or `upgrade`; one already there is never replaced. To make one
by hand:

```sh
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
```

The dashboard refuses to start with `AUTH_CONFIG_INVALID`, naming the key, when
`DREFYN_AUTH_SECRET` or `DREFYN_AUTH_INVITATION_BLOCK_KEY` is missing or the wrong length. The
API service refuses to start when any `DREFYN_AUTH_` key is set; it gets only
`DREFYN_API_RATE_LIMIT_KEY`.

### Rotating `DREFYN_AUTH_SECRET`

1. Copy the current value to `DREFYN_AUTH_SECRET_PREVIOUS`.
2. Put a new value in `DREFYN_AUTH_SECRET` and restart the dashboard.
3. After a day, remove `DREFYN_AUTH_SECRET_PREVIOUS` and restart again.

While both are set, sign in codes and form tokens made under the old secret still verify, so
nobody mid sign in is turned away. Rate limit windows start fresh under the new secret, which
for one window lets each address and network try again. Sessions, device cookies, CLI links
and invitation blocks do not depend on this secret and are not touched.

### `DREFYN_AUTH_INVITATION_BLOCK_KEY` is never rotated

Never rotate it with `DREFYN_AUTH_SECRET`, and never rotate it on a schedule. A block from the
"I did not expect this" link is stored as an HMAC of the address under this key, so a new key
lifts every block at once, and people who asked not to be invited again can be. Change it only
if it leaked, knowing that cost: replace the value and restart. There is no previous key for
it. Keep it in the same backups as the database, because a restored database with a lost key
has the same effect.

### Rotating `DREFYN_API_RATE_LIMIT_KEY`

Put a new value in the API service's environment and restart it. The only effect is that API
key failure windows start fresh. No key, session or block depends on it.

### Rotating the OAuth client secrets

Create a second client secret in the GitHub or Google console, put it in
`DREFYN_AUTH_GITHUB_CLIENT_SECRET` or `DREFYN_AUTH_GOOGLE_CLIENT_SECRET`, restart, check that a
provider sign in works, then delete the old secret in the console. A sign in started before
the restart finishes with the new secret, because the secret is only used when the dashboard
exchanges the code.

### Rotating the `drefyn_auth` password

The same as any other password, above:

```sh
docker compose -f deploy/compose.yaml exec postgres psql -U postgres -d drefyn -c '\password drefyn_auth'
# then put the same password in deploy/.env and run
bash scripts/selfhost.sh restart
```

Then restart the dashboard with the new `DREFYN_AUTH_DATABASE_URL`. Until it restarts, its
open connections keep working and new ones fail, so sign in fails until the restart.

## The first admin

A fresh install needs no SMTP and no OAuth app to sign in. Run the dashboard's own command
with the dashboard's environment, where it runs:

```sh
drefyn auth link --email you@example.com --create-organization "Acme"
```

It prints one line on stdout, `<DREFYN_APP_ORIGIN>/sign-in/cli#drf_cl_...`, and on stderr its
log events as JSON lines (ids only, never the address or the link) and "Valid once, for 15
minutes.". Open it in a browser to sign in. A second open fails, and printing a new
link makes the older unused one worthless. It never sends mail and writes the link nowhere but
your terminal; treat the scrollback like a password until you have used it. The person is made
if the address is new, unless `DREFYN_AUTH_SIGNUP=closed`, which only lets existing people in.
`--create-organization` makes an organization with that person as owner, and its URL name
from the name: `Acme Docs` becomes `acme-docs`. A URL name already in use gets four random
characters on the end, as does one the dashboard keeps for itself. If that person already owns
an organization with exactly that name, the command reuses it, makes nothing new and says so on
stderr, so running it twice for a fresh link is safe. Only owning counts, not another role.

To sign someone out everywhere, for example after a lost laptop:

```sh
drefyn auth revoke-sessions --email person@example.com
drefyn auth revoke-sessions --all
```

Both commands need both database URLs, `DREFYN_DATABASE_URL` and `DREFYN_AUTH_DATABASE_URL`:
people are found as `drefyn_auth`, and sessions and organizations are written as `drefyn_app`.
A missing one exits 3 naming it. The auth release flags gate the `/sign-in/cli` page, not these
commands, because `revoke-sessions` is an incident tool; with the flags off, `link` still
creates the person and the organization, and the link does nothing until the page is on.

Each prints how many sessions it ended. Exit codes for `drefyn auth`: 0 done, 2 bad input
(the flag is named, the value never echoed), 3 a setting is missing or invalid (the key is
named), 4 the database cannot be reached or the role is wrong, 5 a file cannot be read or
written.

## Behind a reverse proxy

The dashboard runs `server.ts`, which resolves the client address from the socket before Next
sees the request, and replaces every forwarding header a client could send: `X-Forwarded-For`,
`Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` and `CloudFront-Viewer-Address`.
`X-Forwarded-Host`, `-Proto` and `-Port` always come from `DREFYN_APP_ORIGIN`, and a request
whose `Host` is not the origin's host gets 421. The health check is `GET /healthz` on a
loopback host (`127.0.0.1`, `localhost` or `[::1]`), so it answers before the origin
resolves.

With nothing in front, leave `DREFYN_TRUSTED_PROXY_HOPS` at 0; the socket is the client. With
one proxy in front, set it to 1, and the address that proxy appended wins over anything the
client wrote. With 0 hops and forwarding headers arriving, the dashboard logs
`auth.forwarded_header_ignored` at most once a minute: that is a proxy you have not declared.
Hops above 0 with a loopback origin stop startup. Behind CloudFront, either count every hop or
set `DREFYN_CLIENT_IP_HEADER=cloudfront-viewer-address`, which is read only from the trusted
hop.

Keep the dashboard's port private when hops is above 0. With one hop the wrapper trusts the
right most `X-Forwarded-For` entry, so anyone who can reach the port directly can name any
client address they like. Bind it to loopback (`HOSTNAME=127.0.0.1`) when the proxy runs on the
same host, or to a private network the proxy alone can reach, and never publish it. The default
is `0.0.0.0`, because a container needs it, so a host port mapping or firewall has to do this
job.

The wrapper takes only the origin form of a request, a path starting with one `/`. Anything
else, such as an absolute `http://host/` target, gets 400. The dashboard has no WebSocket route,
so an upgrade request is answered as an ordinary request, with the same checks.

Set `UV_THREADPOOL_SIZE=16` in the dashboard's environment. Node sizes that pool when it starts,
so it cannot be set from inside the dashboard. A smaller or missing value logs
`auth.threadpool_small` once at startup, and while passwords are on the dashboard refuses to
start with `AUTH_CONFIG_INVALID` unless it is above 4.

A Caddy example with automatic TLS and one hop. Invitation and sign in links carry their
secret after `#`, which browsers never send, but the `/invite` path is still kept out of the
access log in case a link is pasted without its fragment:

```caddyfile
app.example.com {
	log {
		output file /var/log/caddy/drefyn.log
		format filter {
			wrap json
			fields {
				request>uri regexp ^/invite.* /invite[redacted]
				request>headers>Cookie delete
				request>headers>Authorization delete
			}
		}
	}
	reverse_proxy 127.0.0.1:3000 {
		# Caddy appends the client address to X-Forwarded-For; the dashboard reads it with
		# DREFYN_TRUSTED_PROXY_HOPS=1 and DREFYN_APP_ORIGIN=https://app.example.com.
		header_up Host {host}
	}
}
```

## Scheduled cleanup

Every dashboard server deletes expired rows on its own timer: revoked API keys 90 days after
the revoke, ended sign in limits, spent challenges and links, and stale devices. There is
nothing to install and no cron entry to add. With several servers, one takes each turn through
a row in `app.scheduled_jobs`, so they never repeat each other, and a server that dies mid run
leaves the turn free for the next.

It runs as `drefyn_auth` on one connection of its own, first within a minute of start and then
hourly. A failed run is retried, from 1 minute apart up to 15, for as long as it keeps failing.

Each run logs `dashboard.expiry_done` with a count per table, `dashboard.expiry_deleted` with
the organization, table and count for tenant rows, and `dashboard.metric` with
`metric: expiry_job_runs_total` and `outcome: done` or `failed`. A failure also logs
`dashboard.expiry_failed` with its code. Alert on `outcome: failed`. To check the job by hand:

```sql
select name, last_run_at, next_run_at from app.scheduled_jobs;
```

With no dashboard server running, nothing is deleted until one starts.

## Mail for tests

A test profile adds Mailpit (MIT), pinned by digest, for the auth flows and end to end tests.
It never starts with `up`:

```sh
docker compose -f deploy/compose.yaml --profile test up --detach --wait mailpit
# SMTP on 127.0.0.1:51025, the web UI and API on http://127.0.0.1:58025
docker compose -f deploy/compose.yaml --profile test rm --stop --force mailpit
```

`DREFYN_MAILPIT_SMTP_PORT` and `DREFYN_MAILPIT_WEB_PORT` move the ports. It keeps at most 500
messages in memory and is not for real mail.

## Breached passwords

Drefyn always refuses passwords that its built in rules catch: one character repeated,
runs like `abcdef` or `qwerty`, short units repeated, and the person's address, the
organization's name and "drefyn". It ships no list of breached passwords. To also refuse
every password in the Pwned Passwords set, build a list once and point Drefyn at it. Nothing
is called over the network when a password is checked.

First download the set in SHA-1 mode (the default) with Have I Been Pwned's own downloader
(BSD 3 Clause). The data is under CC BY 4.0. The output is one large file of `HASH:count`
lines.

```sh
dotnet tool install --global haveibeenpwned-downloader
haveibeenpwned-downloader pwnedpasswords
```

Then build the list. `--min-count` leaves out passwords seen fewer times than that; 1 keeps
everything, and higher values make a smaller file.

```sh
drefyn auth password-list build --from pwnedpasswords.txt --min-count 1 \
  --out /var/lib/drefyn/breached-passwords.bin
```

It prints one line with the lines read, the records written and the lines dropped. It exits 2
on a bad line and names the line number, and 5 when a file cannot be read or written. If it
says the hashes must be in ascending order, sort the input first and build again:

```sh
LC_ALL=C sort -o pwnedpasswords.sorted.txt pwnedpasswords.txt
```

The list is written to a temporary file next to `--out` and renamed into place, so an existing
list is never half replaced. A build that was killed may leave a `<out>.tmp-<8 hex>` file,
which is safe to delete.

Last, set `DREFYN_AUTH_BREACHED_PASSWORDS_FILE` to the absolute path of the list, and restart.
Startup logs `auth.breached_list_loaded` with the record count. A file that is missing,
unreadable, empty or not whole 20 byte records stops startup with `AUTH_CONFIG_INVALID`.
Without the key, startup logs `auth.breached_list_absent` once and the built in rules still
apply.

The list is checked only when a password is chosen, never at sign in. A check that does not
answer within one second lets the password through and logs and counts
`auth.breach_check_unavailable`. A rebuilt list takes effect on the next restart.

## Managed Postgres

On a managed database, run the same file once as the master user, with
`DREFYN_OWNER_PASSWORD`, `DREFYN_APP_PASSWORD`, `DREFYN_PUBLIC_READER_PASSWORD` and
`DREFYN_AUTH_PASSWORD` set in the environment:

```sh
psql --no-psqlrc --dbname drefyn --file deploy/postgres/bootstrap.sql
```

It stops before changing anything if the roles or schemas already exist. On `postgres` and
`template1` it only revokes `PUBLIC` rights where the master user owns the database, and
prints a notice for any it skips.

A managed database bootstrapped before `drefyn_auth` gets it from the upgrade script instead,
run the same way as the master user with `DREFYN_AUTH_PASSWORD` set:

```sh
psql --no-psqlrc --dbname drefyn --file deploy/postgres/upgrade/0001-auth-role.sql
```

Both files turn off statement logging for their own session before they read a password. A
master user that is not a real superuser may not be allowed to, and then the file stops
before it reads any password unless the server already logs nothing. These record a
`create role ... password` in plain text, even when it succeeds:

- `log_statement` set to `ddl`, `mod` or `all`
- `log_min_error_statement` at `error` (the default) or lower, which logs a statement that
  fails, so a `create role` refused by a password policy logs its password
- `log_min_duration_statement` or `log_min_duration_sample` at 0 or more
- `log_transaction_sample_rate` above 0
- `pgaudit` loaded, whatever the session sets
- `auto_explain` loaded, which with `auto_explain.log_min_duration` at 0 or more logs the
  query text, password checks included
- `pg_stat_statements` loaded with `pg_stat_statements.track_utility` on (its default), which
  keeps the text of every `create role ... password` even after a rollback, readable by
  monitoring roles

The file turns `debug_print_parse`, `debug_print_rewritten` and `debug_print_plan` off for its
session itself, and `pg_stat_statements.track_utility` too where the master user may.

The file checks all of these, and finds `pgaudit` and `auto_explain` in any of the three
preload lists in any spelling. Turn them off for the run. If you have checked that nothing
logs these statements, or you will change each password afterwards with `\password` as
above, run the file with `DREFYN_BOOTSTRAP_LOG_CHECKED=yes` set. A master user that cannot
read the preload lists also needs it.

The master user owns schema `extensions` and the extension. After an engine upgrade, or when
the provider adds a newer pgvector, it runs `alter extension vector update to '<version>'`,
choosing a version that `pg_available_extension_versions` lists.

## Project name

The stack runs as Compose project `drefyn`. The scripts refuse to start, stop, restart, reset
or smoke check it when that project already has containers or volumes that came from a
different compose file, such as an older stack or another checkout, because Compose would
recreate those containers or mount that volume, and `reset` would delete it. They also refuse
when Docker cannot list the project's containers or volumes. Nothing is changed when they
refuse.

The data volume carries a label with `DREFYN_STACK_ID` from `deploy/.env`, so plain
`docker compose` and the scripts label it the same way and Compose never asks to recreate
it. Set it in `deploy/.env` only, not in the shell. It identifies the stack and is not a
secret. It must never change after the first start: a changed ID makes the scripts refuse,
naming both IDs, and newer Compose then offers to recreate the volume, which deletes the data.
A volume with another stack ID, or none, is refused. A volume from an earlier build of this
stack, labelled with the compose file path, can only be removed: `reset --yes` deletes it.

Set `COMPOSE_PROJECT_NAME` (in the shell or in `deploy/.env`) and a different
`DREFYN_POSTGRES_PORT` to run this stack beside another one, for example from another
worktree.

## The parse host

Customer pages are hostile input, so they are parsed in a service of their own: the `parse-host`
image, built from `deploy/parse-host/Dockerfile`. It holds no credentials, has no volume and
publishes no port, and its `parse` network is `internal`, so it has no route to the internet or
to the machine it runs on. Node has no network permission, so that network is the only thing
closing egress. Keep it that way: anything on the `parse` network can reach the host, and only
the app tier belongs there.

```sh
token="$(openssl rand -hex 32)"                 # goes to the app tier as DREFYN_PARSE_HOST_TOKEN
printf '%s' "$token" | shasum -a 256            # goes in deploy/.env as DREFYN_PARSE_TOKEN_SHA256
docker compose -f deploy/compose.yaml --profile parse up --detach --build --wait parse-host
bash scripts/selfhost-parse-test.sh             # proves the boundary from real containers
```

The host keeps only the hash, and it will not start without one. `DREFYN_PARSE_HOST_MEMORY_MB`,
default 2048, sets both the check the host makes at start and the container's memory limit. The
supervisor inside the container restarts a host that dies. A crash loop stops it for a minute
and logs `mdx.parse_host_crash_loop` at error level, and the container reads unhealthy until it
is back.
