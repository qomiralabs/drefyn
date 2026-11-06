import { afterEach, describe, expect, it } from 'vitest';
import type { MdxRoot, PrintResult } from '../src/index.ts';
import { createParsePool } from '../src/pool.ts';
import type { ParsePool } from '../src/pool.ts';
import { DEFAULT_PRINT_TIMEOUT_MS, parsePoolConfig } from '../src/pool-config.ts';
import {
  isolatedPolicy,
  ORG_B,
  orgAt,
  parsed,
  PROJECT_B,
  projectAt,
  recordingLogger,
} from './helpers.ts';
import { allNew } from './print-helpers.ts';

// The print bomb security measured with: passes every limit and holds a thread for a whole kill.
const BOMB: MdxRoot = allNew(parsed(`${'*a*_b_'.repeat(3_000)}\n`, 'md'));
const SAVE = parsed('# Saved\n\nA real page.\n', 'md');
const TIMEOUT_MS = 180_000;
// The security review's rate: a person saving, not a benchmark.
const SAVE_EVERY_MS = 5_000;
const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('colluding organizations at the default limits, with print bombs', () => {
  const pools: ParsePool[] = [];
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.close()));
  });

  const printing = (pool: ParsePool, tree: unknown, org = ORG_B, project = PROJECT_B) =>
    pool.print({
      tenant: { organizationId: org, projectId: project },
      path: 'docs/page.md',
      tree: JSON.stringify(tree),
      policy: isolatedPolicy(),
      priority: 'interactive',
    });

  it.each([
    [8, 3],
    [64, 1],
  ])(
    '%i organizations with %i pages each leave a person saving',
    async (organizations, pages) => {
      const pool = createParsePool(parsePoolConfig({}), {
        logger: recordingLogger(),
        onStuck: () => undefined,
      });
      pools.push(pool);
      const until = performance.now() + 24_000;
      const attacker = async (index: number) => {
        await Promise.all(
          Array.from({ length: pages }, async () => {
            while (performance.now() < until) {
              const org = orgAt(index + 1);
              const result = await pool.print({
                tenant: { organizationId: org, projectId: projectAt(index) },
                path: 'docs/page.md',
                tree: JSON.stringify(BOMB),
                policy: isolatedPolicy(),
              });
              if (!result.ok) await pause(200);
            }
          }),
        );
      };
      const saves: { result: PrintResult; ms: number }[] = [];
      const person = async () => {
        await pause(1_000);
        while (performance.now() < until) {
          const began = performance.now();
          saves.push({ result: await printing(pool, SAVE), ms: performance.now() - began });
          await pause(SAVE_EVERY_MS);
        }
      };
      const flood = Array.from({ length: organizations }, (_, index) => attacker(index));
      await person();
      // Bombs still queued are the flood's problem, and they would take minutes to run out.
      await pool.close();
      await Promise.all(flood);

      expect(saves.length).toBeGreaterThanOrEqual(3);
      expect(saves.filter(({ result }) => !result.ok)).toEqual([]);
      // One running job at most, then a thread: a kill, and room for a loaded runner.
      expect(Math.max(...saves.map(({ ms }) => ms))).toBeLessThan(DEFAULT_PRINT_TIMEOUT_MS * 2.5);
    },
    TIMEOUT_MS,
  );
});
