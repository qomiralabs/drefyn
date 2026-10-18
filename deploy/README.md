# Self host stack

Docker Compose files for running Drefyn yourself. Today the stack is Postgres with pgvector;
other services join it as they are built.

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

It also:

- creates schema `extensions` and installs pgvector there, both owned by the superuser.
  pgvector is not a trusted extension, so only a superuser can create it; migrations never
  need to. All three roles get `USAGE` on the schema; none can create, drop or change
  anything in it.
- sets the `drefyn` database's `search_path` to `app, extensions`, so `vector` works
  unqualified. The roles carry no settings of their own.
- revokes every right on schema `public` from `PUBLIC`.
- revokes `CONNECT` and `TEMP` on the `drefyn` database from `PUBLIC` and grants `CONNECT`
  to the three roles only. A role created later cannot connect until it is granted, and no
  role can create temporary tables in `drefyn`.
- revokes every right on the `postgres` and `template1` databases from `PUBLIC`, so the
  three roles and any role created later cannot connect to them.

Grants on `app` and row level security policies come from migrations.

The image runs the newest patched PostgreSQL 18 minor (18.6) with pgvector 0.8.7. Managed
Postgres ships pgvector 0.8.2 today; the two have the same SQL surface, and the schema uses
nothing newer than what managed Postgres offers.

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

## Managed Postgres

On a managed database, run the same file once as the master user, with
`DREFYN_OWNER_PASSWORD`, `DREFYN_APP_PASSWORD` and `DREFYN_PUBLIC_READER_PASSWORD` set in the
environment:

```sh
psql --no-psqlrc --dbname drefyn --file deploy/postgres/bootstrap.sql
```

It stops before changing anything if the roles or schemas already exist. On `postgres` and
`template1` it only revokes `PUBLIC` rights where the master user owns the database, and
prints a notice for any it skips.

The file turns off statement logging for its own session before it reads a password. A
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
