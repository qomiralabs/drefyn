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
                    key: 'source' in job ? job.source : job.tree,
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

describe('the queue under a colluding group', () => {
  // Threads that never finish, so everything past the first two stays queued.
  const parked = (): ParseThread => ({
    alive: () => true,
    stop: () => Promise.resolve(),
    run: () => new Promise<ThreadAnswer>(() => undefined),
  });

  const submit = fc.record({ org: fc.nat(11), project: fc.nat(3) });

  it('always has a place for an organization holding nothing', { timeout: 60_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(submit, { maxLength: 200 }), async (steps) => {
        const config = poolConfig({
          threads: 2,
          orgThreads: 1,
          maxQueued: 16,
          maxQueuedPerOrg: 8,
          maxQueuedPerProject: 4,
        });
        const pool = createParsePool(config, {
          logger: recordingLogger(),
          onStuck: () => undefined,
          now: () => 0,
          startThread: parked,
        });
        const parse = (org: number, project: number) =>
          pool.parse({
            tenant: { organizationId: orgAt(org), projectId: projectAt(project) },
            path: 'a.md',
            source: 'a',
            dialect: 'md',
            policy: isolatedPolicy(),
          });
        for (const { org, project } of steps) void parse(org, project);
        await flush();
        expect(pool.stats().queued).toBeLessThanOrEqual(config.maxQueued);

        // Twelve organizations cannot hold sixteen places one each, so this one must get in.
        const newcomer = parse(99, 0);
        const verdict = await Promise.race([
          newcomer.then((result) => (result.ok ? 'ok' : result.error[0]?.code)),
          flush().then(() => 'queued'),
        ]);
        expect(verdict).toBe('queued');
        expect(pool.stats().queued).toBeLessThanOrEqual(config.maxQueued);
      }),
      { numRuns: 100 },
    );
  });
});
