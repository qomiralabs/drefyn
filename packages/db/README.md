# `@drefyn/db`

Postgres access for Drefyn: typed, validated database config and the `drefyn migrate`
command, which runs reversible SQL migrations as `drefyn_owner`.

Not implemented yet; the tests describe the contract.

## Public API

- `parseDatabaseConfig(env)`: reads `DREFYN_DATABASE_URL`, `DREFYN_DATABASE_POOL_MAX` (10),
  `DREFYN_DATABASE_POOL_WAIT_MS` (2000), `DREFYN_DATABASE_STATEMENT_TIMEOUT_MS` (5000) and
  `DREFYN_DATABASE_SSL` (`verify-full` unless set). Throws `DbError` with `DB_CONFIG_INVALID`;
  the message never holds a password or the URL.
- `parseMigrationConfig(env)`: reads `DREFYN_MIGRATION_DATABASE_URL` and `DREFYN_DATABASE_SSL`.
- `DbError`, `DbErrorCode`.

## `drefyn migrate`

```sh
drefyn migrate up | down [n] | status [--migrations-dir <dir>]
```

Connects with `DREFYN_MIGRATION_DATABASE_URL` as `drefyn_owner`. Before it takes the advisory
lock it checks that `vector` is installed in schema `extensions` at 0.8.2 or later.

| Exit code | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| 0         | done                                                                        |
| 1         | anything else: bad config, bad file, failed SQL, wrong role                 |
| 2         | another run holds the lock                                                  |
| 3         | checksum mismatch: an applied file changed or is gone; the message names it |
| 4         | prerequisite missing: names what is missing and the operator command        |

## Testing

```sh
pnpm --filter @drefyn/db test
COMPOSE_PROJECT_NAME=<project> pnpm --filter @drefyn/db test:integration
```

Integration tests need the compose stack from `scripts/selfhost.sh up` and refuse to run
without `COMPOSE_PROJECT_NAME`.
