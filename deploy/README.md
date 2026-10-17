# Self host stack

Docker Compose files for running Drefyn yourself. Today the stack is Postgres with pgvector;
other services join it as they are built.

## Requirements

- Docker Engine 25 or later with the Compose v2 plugin
- `jq`, for the smoke check

## Start, stop, reset

From the repository root:

```sh
bash scripts/selfhost.sh up            # first run writes deploy/.env with random passwords
bash scripts/selfhost-smoke.sh         # checks health, roles, grants, pgvector and port bindings
bash scripts/selfhost.sh restart
bash scripts/selfhost.sh down          # keeps the data volume
bash scripts/selfhost.sh reset --yes   # deletes the data volume
```

`up` pulls the image first (about 150 MB), then waits until Postgres is healthy and prints
how long that took: 2 to 6 seconds from an empty volume on an Apple silicon laptop, 1 to 2
seconds on a restart.

To write `deploy/.env` yourself, copy `deploy/.env.example` and fill every password with at
least 16 random characters. Empty or short passwords stop the first start on purpose.
`deploy/.env` is gitignored; keep it out of backups that others can read.

## Postgres

| Setting   | Value                                                                 |
| --------- | --------------------------------------------------------------------- |
| Image     | `pgvector/pgvector:0.8.2-pg18`, pinned by digest                      |
| Host port | `127.0.0.1:55432` (`DREFYN_POSTGRES_PORT`), never on other interfaces |
| Database  | `drefyn`                                                              |
| Data      | named volume `pgdata`                                                 |

The container runs as the `postgres` user with all capabilities dropped. Passwords reach it
as Compose secrets, so they appear as files in `/run/secrets` and not in `docker inspect`.
Local socket logins use peer authentication and every TCP login needs a password, loopback
included.

On the first start, with an empty volume, `postgres/bootstrap.sql` runs once as the
superuser and creates:

| Role                   | Purpose                                        | Notes                                     |
| ---------------------- | ---------------------------------------------- | ----------------------------------------- |
| `drefyn_owner`         | Owns schema `app`; migrations run as this role | no superuser, no `BYPASSRLS`              |
| `drefyn_app`           | The application's connection                   | owns nothing, `NOINHERIT`, no `BYPASSRLS` |
| `drefyn_public_reader` | Public read paths only                         | owns nothing, `NOINHERIT`, no `BYPASSRLS` |

It also:

- creates schema `extensions`, owned by `drefyn_owner`, and installs pgvector there. pgvector
  is not a trusted extension, so only a superuser can create it; migrations never need to.
  The app and reader roles get `USAGE` on it and cannot create anything in it.
- sets each role's `search_path` to `app, extensions`, so `vector` works unqualified.
- revokes every right on schema `public` from `PUBLIC`.
- revokes `CONNECT` and `TEMP` on the database from `PUBLIC` and grants `CONNECT` to the
  three roles only. A role created later cannot connect until it is granted, and no role can
  create temporary tables.

Grants on `app` and row level security policies come from migrations. On a managed database, run the same file once as the master
user with `DREFYN_OWNER_PASSWORD`, `DREFYN_APP_PASSWORD` and `DREFYN_PUBLIC_READER_PASSWORD`
set in the environment.

If the first start fails (for example because a password was too short), the volume is left
half initialised and the container stays unhealthy. Fix `deploy/.env`, then run
`bash scripts/selfhost.sh reset --yes` and `up` again.

## Project name

The stack runs as Compose project `drefyn`. The scripts refuse to start, stop, restart, reset
or smoke check it when that project already has containers created from a different compose
file, such as an older stack or another checkout, because Compose would recreate those
containers and `reset` would delete their volumes. Nothing is changed when they refuse.

Set `COMPOSE_PROJECT_NAME` (in the shell or in `deploy/.env`) and a different
`DREFYN_POSTGRES_PORT` to run this stack beside another one, for example from another
worktree.
