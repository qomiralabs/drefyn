# `@drefyn/cli`

The `drefyn` binary for operators. It holds no command logic: the first word picks the
package that owns the command, and that package parses the rest.

```sh
drefyn migrate up | down [n] | status [--migrations-dir <dir>]
drefyn auth password-list build --from <file> --min-count <n> --out <file>
drefyn auth link --email <address> [--create-organization <name>]
drefyn auth revoke-sessions --email <address> | --all
```

- `migrate` runs `runMigrate` from `@drefyn/db/command`, with its own exit codes.
- `auth` runs `runAuthCommand` from `@drefyn/auth/command`: 0 done, 2 bad input, 3 config,
  4 database or role missing, 5 file system.
- Anything else prints both usage lines and exits 2.

`runDrefyn(options)` is the same dispatch as a function, for tests.

Neither db nor auth imports this package; their integration tests run `src/main.ts` by path.
