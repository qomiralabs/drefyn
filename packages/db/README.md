# `@drefyn/db`

Postgres access for Drefyn: tenant scoped transactions under forced row level security, typed,
validated database config, and the `drefyn migrate` command, which runs reversible SQL
migrations as `drefyn_owner`.

## Tenant access

There are five ways in: three need a tenant, one needs a signed in user and one is the sign in
path itself. Nothing exported hands out a pool, a client, a Kysely instance or a transaction
without one of those.

- `createDatabase(config, { logger })` opens the app pool as `drefyn_app`.
  `createPublishedDatabase(config, { logger })` opens the reader pool as
  `drefyn_public_reader`. Both run a startup role check and fail with `DB_ROLE_UNSAFE`, naming
  every problem, when the role is a superuser, has `BYPASSRLS`, owns anything in `app`, is a
  member of another role, has any persisted role setting (in any database), when a setting is
  stored for all roles, when the database has any setting other than the bootstrap's
  `search_path=app, extensions`, or when the pool is on the wrong role. The optional logger
  gets `warn(event, fields)` with ids and the pool kind, never SQL text or values.
- `withTenant(db, tenant, work, { timeoutMs })` takes a `TenantRef`: the project is required.
  It runs `work(tx)` in one transaction with `drefyn.organization_id` and `drefyn.project_id`
  set for that transaction only. The default timeout is
  `DREFYN_DATABASE_STATEMENT_TIMEOUT_MS`; per call values go up to 60000 ms.
- `withOrganization(db, org, work, { timeoutMs })` takes an `OrganizationRef` with no
  `projectId` key at all, for organization work such as members, plans and the credit
  ledger. Its transaction type holds only tables without `project_id`, and project tables
  read as empty even through raw SQL, because their policy needs both settings. An
  organization wide view of project data loops over the projects the caller may access, one
  `withTenant` each, or reads a summary table written by a job.
- `withPublishedReader(db, tenant, work, { timeoutMs })` needs a `TenantRef` and runs a read only
  transaction whose type holds only the tables on the published allow list. Default 2000 ms, up
  to 10000 ms.
- `withUser(db, { userId }, work, { timeoutMs })` takes a `UserRef` and nothing else, for work
  that belongs to the person rather than an organization: their own rows and the organizations
  they belong to. It runs as `drefyn_app` with only `drefyn.user_id` set, so tenant tables read
  as empty, and policies read the user with `app.current_user_id()`. Its transaction type,
  `UserSchema`, names only the tables on the user list. Before the work runs only `BEGIN` and
  the settings are sent, so a caller that must prove a credential first can make that read its
  first statement.
- `createAuthDatabase(config, { logger })` opens the auth pool as `drefyn_auth`, with the same
  startup role check, and refuses any other role with `DB_ROLE_UNSAFE`.
  `withAuth(db, work, { timeoutMs })` runs the sign in path, before any user or organization is
  known, with every setting empty. `drefyn_auth` holds grants only on the identity tables and
  its transaction type, `AuthSchema`, names only those. Default 2000 ms, up to 10000 ms.
- `withApiKeyLimiter(db, work, { timeoutMs })` counts failed API key checks on the app pool,
  before any key or organization is proved, with every setting empty. Its transaction type,
  `ApiKeyLimiterSchema`, names `api_key_failures` alone. The `api_access` policy exists on
  that table only and holds only when no organization, project or user is set, so tenant or
  user work, which also runs as `drefyn_app`, reads and writes no row there.
- `withTenant` work is typed `TenantSchema` and `withOrganization` work `OrganizationSchema`:
  neither names an identity or limiter table (organization scope keeps `users`, with
  `drefyn_app`'s columns, for the members page).
- `closeDatabase(db)` ends the pool. It is safe to call twice; later work fails with
  `DB_UNAVAILABLE`.

A context must be a plain object with only its own keys as own data properties:
`organizationId` and `projectId` for the tenant entry points, `userId` for `withUser`.
Getters, prototype values and extra fields are refused before any SQL is sent. The entry
points refuse each other's keys, so a user and an organization are never set in one
transaction, where their permissive policies would combine.

Rules for the work:

- Use `tx` only inside `work`. Once `work` settles, every query through that `tx` throws, so it
  can never run on a connection that now carries another tenant.
- Never end the transaction or change the tenant or user inside the work. Every transaction
  sets all three settings, empty where unused, and the commit checks that they are still the
  ones it set; if the work changed them, or committed or rolled back
  itself, the call fails with `DB_TRANSACTION_INVALID` and the connection is replaced.
  `check:sources` refuses `begin`, `commit`, `rollback` and session `SET` in raw SQL, and any
  setting of a `drefyn.` value outside this package. Savepoints are fine.
- If a statement fails, the transaction is over. Work that catches a SQL error and returns
  still rejects with that error.
- After every transaction the connection runs `DISCARD ALL` before it goes back to the pool,
  so cursors held past commit, session settings, `LISTEN` and advisory locks never reach the
  next tenant. It also drops prepared statements, so queries are never named.
- Streaming is not supported inside a transaction.
- No insert path accepts a client chosen `id`. Ids come from `uuidv7()` or `newId(kind)`, so a
  primary key conflict can never tell a caller that an id exists in another tenant. This is
  why unique keys other than `(id)` must include `organization_id`.

Errors are `DbError` with a stable `code`; messages never carry query values, server detail or
secrets.

| Code                        | When                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `DB_CONFIG_INVALID`         | bad config or `timeoutMs`, or a login the server refused                                       |
| `DB_ROLE_UNSAFE`            | the startup role check failed                                                                  |
| `DB_TENANT_CONTEXT_MISSING` | no valid organization, no valid project where one is required, or no user                      |
| `DB_TENANT_CONTEXT_INVALID` | a key that belongs to another entry point, a malformed user id, or a context that is not plain |
| `DB_TRANSACTION_INVALID`    | the work ended the transaction or changed the tenant or user                                   |
| `DB_RLS_VIOLATION`          | a row level security policy refused a write                                                    |
| `DB_UNIQUE_VIOLATION`       | a unique constraint refused a write                                                            |
| `DB_IDEMPOTENCY_CONFLICT`   | an idempotency key reused with a different request                                             |
| `DB_TIMEOUT`                | a statement, lock or idle transaction timed out                                                |
| `DB_UNAVAILABLE`            | the server is unreachable or the pool stayed busy past its wait                                |
| `INTEGER_INVALID`           | a value is not a safe integer, including a `bigint` read past 2^53 - 1                         |

Other driver errors, such as a foreign key violation, come back unchanged.

`toSafeInteger(value, field, { allowNegative })` takes a safe integer, a `bigint` or a canonical
decimal string and refuses everything else with `INTEGER_INVALID`, naming the field and never
the value. Negatives are refused unless asked for. `newId(kind)` returns a UUIDv7 that
increases within the process.

### Tables

Tenant tables are built with `tenantTableSql` and published tables with `publishedTableSql`
from `src/tenant-sql.ts`, in a migration. A tenant table gets `organization_id` (and
`project_id` with a composite foreign key to its project), an index leading with
`organization_id`, row level security enabled and forced, and the `tenant_isolation` policy to
`drefyn_app` only. On a project table that policy needs both the organization and the
project. A foreign key into a tenant table carries `organization_id`, and `project_id` too
when both tables have one, against a matching composite unique key; a reference across
projects of one organization needs a reviewed entry in the allow list. A published table also gets an explicit `select` grant to
`drefyn_public_reader` and the `published_read` policy, which needs both organization and
project. It must be added to the published allow list in `src/allow-lists.ts`.

### Identity and limiter tables

`users`, `identities`, `sessions`, `password_credentials`, `email_challenges`, `oauth_states`,
`auth_rate_limits` and `api_key_failures` carry no `organization_id`: a person exists before
and across organizations. Each is on the global table list with a reason. `drefyn_auth`
reaches the six sign in tables and never `sessions` or `api_key_failures`; `drefyn_app` reaches
the person's own `users`, `identities`, `sessions` and `password_credentials` rows under
`withUser`, holds nothing on `email_challenges`, `oauth_states` and `auth_rate_limits`, and
writes `api_key_failures` only through `withApiKeyLimiter`.

On `users` and `password_credentials` every select, insert and update is per column. The
columns each role may touch are written once in `src/identity-columns.ts`; the catalog allow
list and the `AuthSchema` and `UserSchema` table types are both built from it, so selecting
`email_verified_at` under `withUser` does not compile, and the database refuses it too.
`drefyn_app` reads `id`, `email`, `display_name` and `created_at` of users and updates only
`display_name` and `updated_at`; only `drefyn_auth` writes the address.

`reserveAuthRateWindows(authDb, { bucket, keyHmac, windowSeconds })` and
`reserveApiKeyFailureWindows(appDb, { keyHmac, windowSeconds })` count one attempt against each
fixed window (1 to 3 windows of 1 s to 7 days) with one upsert, aligned to the database clock,
and return each window's count and seconds until it ends. Each runs in a transaction of its
own (1 s timeout) and commits before it returns, so the count stands whatever the caller's
work does and the row lock is held for one statement only. The key is a 32 byte HMAC made by
the caller, so no address or IP is stored. Parallel calls on one key queue on its row, so each
sees its own count.

`selectAll()` on `users` or `password_credentials` fails lint (`drefyn/no-select-all`): it
sends `select *`, which the per column grants refuse for every role.

`deleteExpired(tx, rules, { batchSize })` deletes rows a fixed time after a timestamp column,
by database time, at most `batchSize` (5000) per rule, and returns counts by table.
`AUTH_EXPIRY_RULES` clears ended limiter windows and challenges and OAuth states 24 hours after
expiry; `API_KEY_EXPIRY_RULES` clears ended API key windows. `createExpiryCleanup({ rules,
transact, onDeleted, logger })` runs them at most once a minute per process, never twice at
once, reports every count, and never rejects: a failure logs `db_expiry_cleanup_failed` with
the table names and the DbError code only. A later table registers its own rule beside these.

`drefyn_owner` matches no policy, so migrations cannot read or change tenant rows. Data
changes run as jobs through `withTenant`, one transaction per tenant.

## Checks

```sh
pnpm --filter @drefyn/db check:catalog   # DREFYN_MIGRATION_DATABASE_URL
pnpm --filter @drefyn/db check:sources [--migrations-dir <dir>] [--root <dir>]
```

`check:catalog` reads the catalog of a migrated database and exits 1 with one line per problem:
a table in `app` without `organization_id`, RLS or forced RLS that is not on the global table
allow list; a weakened, extra or missing policy; a `numeric`, `real`, `double precision`,
`money` or `timestamp without time zone` column; a `SECURITY DEFINER` function off its allow
list; a view without `security_invoker = true`; a materialized view; a unique key on a tenant
table without `organization_id`; any reader grant outside the published allow list; any grant
on the bookkeeping tables; a function executable by `PUBLIC`; default privileges to the reader
or `PUBLIC`; anything `drefyn_app` holds beyond `SELECT`, `INSERT`, `UPDATE` and `DELETE` on
tables (`TRUNCATE` ignores RLS), `USAGE` and `SELECT` on sequences and `EXECUTE` on its
allow list, including grant options, `CREATE`, `TEMP`, ownership and default privileges; a
foreign key into a tenant table without the tenant columns; and any persisted setting on
`drefyn_app`, `drefyn_public_reader` or `drefyn_auth`, for all roles, or on the database
beyond the bootstrap's.

For the identity tables it also refuses: any `drefyn_auth` grant on a table with
`organization_id`, even one on the auth table list, or on a table off that list; `EXECUTE` on
any function in `app`, or anything beyond `USAGE` on the schema, for `drefyn_auth`; anything
beyond `SELECT`, `INSERT`, `UPDATE` and `DELETE` for it on a listed table, or any grant option;
default privileges to `drefyn_auth`; a permissive policy other than `tenant_isolation` and
`published_read` unless it matches its `userPolicies` entry exactly (command, roles, `USING`
and `WITH CHECK` as `pg_get_expr` prints them), on tenant and global tables alike; any policy
to `PUBLIC`, restrictive ones included; a unique key without `organization_id` on a tenant table
unless it is on the global unique list; and on `users` and `password_credentials`, any table
level `SELECT` or `UPDATE` and any column grant off the column grant list, so a new column is
closed until someone grants it. Insert is per column there too, so no insert can set a column
such as `email_verified_at` that the role was not given. It refuses any grant to `drefyn_app`,
even one column, on the auth only tables (`email_challenges`, `oauth_states`,
`auth_rate_limits`), and checks each column grant entry names `SELECT`, `INSERT` or `UPDATE`,
`drefyn_app` or `drefyn_auth`, and a table on the column grant list.

`check:sources` fails on migration DDL aimed at an extension or schema `extensions`, and on a
session level tenant setting (a plain or session `SET` of a `drefyn.` setting, or `set_config`
with `is_local` false) in any tracked file.

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
- `parsePublishedReaderConfig(env)`: reads `DREFYN_PUBLIC_READER_DATABASE_URL` with the same
  pool and SSL keys and a fixed 2000 ms statement timeout. It never falls back to
  `DREFYN_DATABASE_URL`.
- `parseAuthDatabaseConfig(env)`: reads `DREFYN_AUTH_DATABASE_URL`,
  `DREFYN_AUTH_DATABASE_POOL_MAX` (4), `DREFYN_DATABASE_POOL_WAIT_MS` and `DREFYN_DATABASE_SSL`,
  with a fixed 2000 ms statement timeout. It never falls back to `DREFYN_DATABASE_URL`. This
  pool carries every address and password hash, so `require` and `disable` are refused unless
  the host is loopback (`localhost`, `127.0.0.0/8`, `[::1]`) or the compose service
  `postgres`; anywhere else it must be `verify-full`.
- `createDatabase`, `createPublishedDatabase`, `createAuthDatabase`, `withTenant`,
  `withOrganization`, `withPublishedReader`, `withUser`, `withAuth`, `closeDatabase`,
  `withApiKeyLimiter`, `toSafeInteger`, `newId`: see Tenant access. `AuthSchema`,
  `UserSchema` and `ApiKeyLimiterSchema` are the transaction types.
- `reserveAuthRateWindows`, `reserveApiKeyFailureWindows`, `deleteExpired`,
  `createExpiryCleanup`, `AUTH_EXPIRY_RULES`, `API_KEY_EXPIRY_RULES`: see Identity and limiter
  tables.
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

The same check stops when a role added after the first bootstrap, today `drefyn_auth`, is
missing or has no `CONNECT` on the database, before any migration that might grant to it.
The message names the role and the upgrade: `bash scripts/selfhost.sh upgrade` on compose, or
`deploy/postgres/upgrade/0001-auth-role.sql` run with psql by the master user.

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
