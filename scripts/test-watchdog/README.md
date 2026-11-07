# Test watchdog

Every vitest worker runs a small thread beside the tests, from the setup file in
`vitest.shared.ts`. A sync loop never gives its thread back, so a test timeout cannot fire and
vitest waits on the worker for good. The thread does what the worker cannot:

- If the worker's event loop gets no turn for `DREFYN_TEST_STALL_LIMIT_MS` (10 minutes by
  default), it kills the worker. Vitest fails the file with `Worker exited unexpectedly`.
- If the run that started the worker is gone, it kills the worker within a second.

To see a spin end:

```sh
cd scripts/test-watchdog/test/fixtures
FIXTURE_FILE=spin.fixture.ts FIXTURE_READY=/dev/null FIXTURE_CACHE="$(mktemp -d)" \
  DREFYN_TEST_STALL_LIMIT_MS=2000 pnpm exec vitest run --root .
```

`./tree` lists a process and everything under it, for tests that prove nothing was left behind.
