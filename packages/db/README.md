# `@drefyn/db`

Postgres access for Drefyn: typed, validated database config and the `drefyn migrate`
command, which runs reversible SQL migrations as `drefyn_owner`.

## Public API

- `parseDatabaseConfig(env)`: reads `DREFYN_DATABASE_URL`, `DREFYN_DATABASE_POOL_MAX` (10),
  `DREFYN_DATABASE_POOL_WAIT_MS` (2000), `DREFYN_DATABASE_STATEMENT_TIMEOUT_MS` (5000) and
  `DREFYN_DATABASE_SSL` (`verify-full` unless set; `require` and `disable` also accepted).
  `require` encrypts the connection but checks no certificate, so anyone on the path can
  pose as the server; use it only where `verify-full` cannot work, and never across a network
  you do not control.
  Throws `DbError` with `DB_CONFIG_INVALID` naming each bad key; the message never holds a
  password or the URL. Zero for the wait or the timeout is refused, because pg and Postgres
  read zero as "forever". Query parameters on the URL are refused: TLS is set only by
  `DREFYN_DATABASE_SSL`.
- `parseMigrationConfig(env)`: reads `DREFYN_MIGRATION_DATABASE_URL` and `DREFYN_DATABASE_SSL`.
  It never falls back to the application URL.
- `DbError`, `DbErrorCode`.

## `drefyn migrate`

```sh
drefyn migrate up | down [n] | status [--migrations-dir <dir>]
```

Connects with `DREFYN_MIGRATION_DATABASE_URL` and refuses any role other than `drefyn_owner`,
and any role that is a superuser or has `BYPASSRLS`. Every command then checks that `vector` is
installed in schema `extensions` at 0.8.2 or later, before it takes any lock. `up` and `down`
take the advisory lock, verify the checksum of every applied file, create the bookkeeping
tables if needed (`app.pgmigrations` and `app.migration_checksums`, owner only), and run.
`status` only reads: it never takes the lock or creates anything, and prints one line per
file: `applied`, `pending`, `changed`, `missing` or `unrecorded`.

| Exit code | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| 0         | done                                                                                 |
| 1         | anything else: bad config, bad file, failed SQL, wrong role, wrong tracking table    |
| 2         | another run holds the lock; nothing was run                                          |
| 3         | checksum mismatch: an applied file changed, is gone or has no recorded hash          |
| 4         | prerequisite missing or an invalid index in `app`: names it and the operator command |

The codes are part of the contract; scripts may branch on them.

### Migration files

Files live in `migrations/` and are named like `1793032432000_create_widgets.sql`: 13 digits,
an underscore, then lower case words joined by single underscores. Anything else in the folder
stops every command before it connects, because the underlying tool would load an unknown file
as code. Names starting with a dot, such as `.DS_Store`, are skipped with a warning and never
read.

Each file has exactly one `-- Up Migration` line followed by exactly one `-- Down Migration`
line. Only comments may appear above the up section. Each file runs in its own transaction
with its record and its hash, so a failure rolls all three back.

A grant or revoke that changes nothing (Postgres warns "no privileges were granted") fails the
file, since it does not do what it says.

Statements that cannot run in a transaction, such as `create index concurrently`, need the
line `-- drefyn: no-transaction` above `-- Up Migration`. A marked file must:

- hold one statement per section, since Postgres runs several statements in one string as a
  transaction and refuses the concurrent build (the run exits 1);
- be safe to repeat in both directions (`if not exists`, `if exists`), because a crash between
  the statement and its record leaves it run but unrecorded, and the next `up` runs it again.

`if not exists` alone would let a rerun skip over a build that failed halfway, because a failed
or cancelled concurrent build leaves its index behind, invalid. Two checks make the form safe:

- Every command (`up`, `down`, `status`) exits 4 when any index in schema `app` is invalid,
  naming each as `app.<index> on app.<table>`, before it takes the lock or runs anything. It
  says when a build for that index is still in progress; that includes a build someone started
  by hand, so wait for it to finish and run again.
- After each section of a marked file, before its hash and record are written, the same check
  runs. If it finds an invalid index, the run exits 1: after `up` the file stays unrecorded,
  after `down` it stays recorded.

To repair, as `drefyn_owner`:

1. Fix the cause: remove the duplicate rows a unique index refused, or end the long running
   reader that held the build up.
2. Drop the invalid index: `drop index concurrently if exists app.<index>;`
3. Run `drefyn migrate up` again.

There is no flag to skip the check.

### Exit code 3: repairing checksums

Exit 3 means the history of this database can no longer be proved: a file that already ran
was edited, deleted, or ran without a recorded hash. Nothing was run. There is no flag to
override it.

1. Find the affected files. `drefyn migrate status` lists them as `changed`, `missing` or
   `unrecorded`, and the exit 3 message names each one with both hashes.
2. Repair one of two ways, by hand:
   - Restore the file from git so its bytes match what ran, for example
     `git checkout origin/main -- packages/db/migrations/<file>.sql`. This is the right fix
     whenever the edit was a mistake. Put a new change in a new migration instead.
   - Only after a reviewer has confirmed that the file's current bytes are exactly what ran
     on this database, record its hash. Compute it with
     `shasum -a 256 packages/db/migrations/<file>.sql` (or `sha256sum`), then, connected as
     `drefyn_owner`:

     ```sql
     insert into app.migration_checksums (name, sha256)
     values ('<file name without .sql>', '<sha256>')
     on conflict (name) do update set sha256 = excluded.sha256, recorded_at = now();
     ```

3. Run `drefyn migrate status` again; it exits 0 once every applied file matches.

### Exit code 2: finding the run that holds the lock

The lock is a session advisory lock on key `7241865325823964`, so it ends with the session
that holds it. To see who holds it, connected to the same database:

```sql
select a.pid, a.usename, a.application_name, a.client_addr, a.backend_start, a.state
  from pg_locks l join pg_stat_activity a on a.pid = l.pid
 where l.locktype = 'advisory' and l.classid = 1686128 and l.objid = 708954076
   and l.objsubid = 1 and l.database = (select oid from pg_database where datname = current_database());
```

A live `drefyn-migrate` session is a real run: wait for it. Only once you are sure it is stuck,
end it with `select pg_terminate_backend(<pid>)` as the superuser or master user. A file that
was mid run rolls back, unless it was marked to run outside a transaction, which is why marked
files must be safe to repeat.

### Exit code 4: prerequisites

Migrations never create or change an extension, because `drefyn_owner` owns neither the
extension nor its schema. The message gives the one statement to run as the superuser on
compose or the master user on managed Postgres.

## `check:types`

```sh
pnpm --filter @drefyn/db check:types [--migrations-dir <dir>] [--write]
```

Migrates the database in `DREFYN_MIGRATION_DATABASE_URL`, reads the `app` tables from
`pg_catalog` (the bookkeeping tables excluded) and compares them with `src/schema.generated.ts`.
It exits 1 naming each table that differs. It refuses a database whose `app.pgmigrations`
already has rows, so it can never migrate a live database by mistake: point it at a fresh copy
of the bootstrapped database. `--write` regenerates the file.

## Testing

```sh
pnpm --filter @drefyn/db test
COMPOSE_PROJECT_NAME=<project> pnpm exec turbo run test:integration --filter @drefyn/db
```

Integration tests need the compose stack from `scripts/selfhost.sh up`, started with a
`COMPOSE_PROJECT_NAME` of your own (set `DREFYN_POSTGRES_PORT` too if another stack uses the
port). Without the stack they skip with the reason in the suite name; in CI they fail instead.
One run per stack at a time: the run holds a lock on the stack, drops any `drefyn_test_*`
databases a crashed run left behind, and builds two template databases that each test file
clones.
