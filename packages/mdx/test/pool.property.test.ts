import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ParseResult } from '../src/index.ts';
import { createParsePool } from '../src/pool.ts';
import type { ParseThread, ThreadAnswer } from '../src/thread.ts';
import { isolatedPolicy, orgAt, poolConfig, projectAt, recordingLogger } from './helpers.ts';

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const step = fc.oneof(
  fc.record({ kind: fc.constant('submit' as const), org: fc.nat(2), project: fc.nat(5) }),
  fc.record({
    kind: fc.constant('finish' as const),
    end: fc.constantFrom<ThreadAnswer['end']>('reusable', 'killed'),
    ms: fc.nat(3_000),
  }),
);

const ANSWER: ParseResult = { ok: false, error: [] };

describe('the scheduler', () => {
  it('holds its bounds and settles every page, whatever the order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 80 }), async (steps) => {
        const clock = { now: 0 };
        const running: { key: string; resolve: (answer: ThreadAnswer) => void }[] = [];
        const live = new Set<ParseThread>();
        const config = poolConfig({ projectBudgetMs: 4_000, windowMs: 10_000 });

        const pool = createParsePool(config, {
          logger: recordingLogger(),
          onStuck: () => undefined,
          now: () => clock.now,
          startThread: () => {
            const thread: ParseThread = {
              alive: () => true,
              stop: () => {
                live.delete(thread);
                return Promise.resolve();
              },
              run: (job) =>
                new Promise((resolve) => {
                  running.push({
                    key: 'source' in job ? job.source : 'tree' in job ? job.tree : job.trees,
                    resolve: (answer) => {
                      if (answer.end === 'killed') live.delete(thread);
                      resolve(answer);
                    },
                  });
                }),
            };
            live.add(thread);
            return thread;
          },
        });

        const pages: Promise<ParseResult>[] = [];
        const check = () => {
          expect(live.size).toBeLessThanOrEqual(config.threads);
          expect(running.length).toBeLessThanOrEqual(config.threads);
          // The source carries org:project, so these are the two limits as the threads see them.
          expect(new Set(running.map(({ key }) => key)).size).toBe(running.length);
          const orgs = running.map(({ key }) => key.split(':')[0] ?? '');
          for (const org of orgs) {
            expect(orgs.filter((other) => other === org).length).toBeLessThanOrEqual(
              config.orgThreads,
            );
          }
          expect(pool.stats().queued).toBeLessThanOrEqual(config.maxQueued);
        };

        for (const item of steps) {
          if (item.kind === 'submit') {
            const organizationId = orgAt(item.org);
            const projectId = projectAt(item.project);
            pages.push(
              pool.parse({
                tenant: { organizationId, projectId },
                path: 'a.md',
                source: `${organizationId}:${projectId}`,
                dialect: 'md',
                policy: isolatedPolicy(),
              }),
            );
          } else {
            clock.now += item.ms;
            running.shift()?.resolve({ result: ANSWER, end: item.end, workMs: item.ms });
          }
          await flush();
          check();
        }
        while (running.length > 0) {
          running.shift()?.resolve({ result: ANSWER, end: 'reusable', workMs: 0 });
          await flush();
          check();
        }
        await Promise.all(pages);
        expect(pool.stats()).toMatchObject({ busy: 0, queued: 0 });
      }),
      { numRuns: 200 },
    );
  });
});
