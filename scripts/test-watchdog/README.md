# Test watchdog

Every vitest worker runs a small thread beside the tests, from the setup file in
`vitest.shared.ts`. A sync loop never gives its thread back, so a test timeout cannot fire and
vitest waits on the worker for good. The thread does what the worker cannot:

- If the worker's event loop gets no turn for `DREFYN_TEST_STALL_LIMIT_MS` (10 minutes by
  default), it kills the worker. Vitest fails the file with `Worker exited unexpectedly`.
- If the run that started the worker is gone, it kills the worker within a second.

A global setup does the same one level up. A timeout around `pnpm` or `turbo` kills only that
wrapper, so vitest's main process exits within a second of its parent going, and its workers
follow. To put a timeout around a test run from a script, start it in its own process group and
kill the group: the wrapper is not the only thing running.

To see a spin end:

```sh
cd scripts/test-watchdog/test/fixtures
FIXTURE_FILE=spin.fixture.ts FIXTURE_READY=/dev/null FIXTURE_CACHE="$(mktemp -d)" \
  DREFYN_TEST_STALL_LIMIT_MS=2000 pnpm exec vitest run --root .
```

The tests that start real runs and real hosts are `*.process.ts`, here and in `packages/mdx`. They
stay out of `pnpm test`, because their CPU would land on time window tests. Run them with
`pnpm test:process`, one file at a time. CI runs them after the tests, in both
`tests (release flags ...)` jobs.

`./tree` lists a process and everything under it, for tests that prove nothing was left behind.
