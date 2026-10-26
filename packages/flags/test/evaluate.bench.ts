// Warm evaluation cost through the real flagd provider in offline file mode, the path every
// request takes once the provider is ready. The budget is p99 under 1 ms per call; read the
// p99 column of the output. Not a gate in CI: timings depend on the machine.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { organizationId } from '@drefyn/tenancy';
import { test } from 'vitest';
import { createFlagClient, flags, type FlagContext } from '../src/index.ts';

const noEntitlements = { hasFeature: () => Promise.resolve(false) };
const ctx: FlagContext = { organizationId: organizationId('0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f') };
const internalCtx: FlagContext = { ...ctx, internal: true };

test('warm flag evaluation per call', async ({ bench }) => {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-flags-bench-'));
  const file = join(dir, 'flags.json');
  const state = Object.fromEntries(
    flags.map((flag) => [
      flag.name,
      {
        state: 'ENABLED',
        variants: { on: true, off: false },
        defaultVariant: 'off',
        // The production shape for a release flag on the rollout ladder.
        targeting: { if: [{ '==': [{ var: 'internal' }, true] }, 'on', 'off'] },
      },
    ]),
  );
  writeFileSync(file, JSON.stringify({ flags: state }));
  const client = await createFlagClient(
    { source: 'file', file, evalTimeoutMs: 50, initTimeoutMs: 10_000 },
    { entitlements: noEntitlements },
  );
  try {
    await bench.compare(
      bench('isOn, release flag with targeting', async () => {
        await client.isOn('product.docs', internalCtx);
      }),
      bench('evaluate, release flag with targeting', async () => {
        await client.evaluate('product.docs', ctx);
      }),
      { iterations: 20_000, time: 0, warmupIterations: 2_000 },
    );
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
