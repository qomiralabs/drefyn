import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MdxIssueCode, ParseResult } from '../src/index.ts';
import { createParsePool } from '../src/pool.ts';
import type { ParsePool, ParseRequest } from '../src/pool.ts';
import { parsePoolConfig } from '../src/pool-config.ts';
import type { ParsePoolConfig } from '../src/pool-config.ts';
import { startParseThread } from '../src/thread.ts';
import {
  isolatedPolicy,
  ORG_A,
  ORG_B,
  orgAt,
  poolConfig,
  POOL_CONFIG,
  PROJECT_A,
  PROJECT_B,
  projectAt,
  recordingLogger,
} from './helpers.ts';

const KB = 1_000;
const TIMEOUT_MS = 90_000;
// Pages of about this size stay under the scan, so only the kill stops them.
const sized = (head: string, unit: string, bytes: number) =>
  head + unit.repeat(Math.ceil((bytes - head.length) / unit.length));

const lazyLines = (bytes: number) => sized('> a\n', 'b\n', bytes);
const frontmatter = (bytes: number) => {
  const lines = Array.from({ length: Math.ceil(bytes / 12) }, (_, key) => `k${key}: 1\n\n`);
  return `---\n${lines.join('')}---\n`;
};
const honest = '# Title\n\nA plain page with a [link](https://example.com).\n';

const request = (
  source: string,
  projectId = PROJECT_A,
  dialect: 'md' | 'mdx' = 'md',
  organizationId = ORG_A,
): ParseRequest => ({
  tenant: { organizationId, projectId },
  path: 'docs/hostile.md',
  source,
  dialect,
  policy: isolatedPolicy(),
});

const codeOf = (result: ParseResult): MdxIssueCode | 'ok' =>
  result.ok ? 'ok' : (result.error[0]?.code ?? 'mdx.parse_failed');

describe('pages only the kill can stop', () => {
  const logger = recordingLogger();
  let pool: ParsePool;
  let project = 0;
  beforeAll(() => {
    pool = createParsePool(poolConfig({ timeoutMs: 1_000, maxMemoryMb: 512 }), {
      logger,
      onStuck: () => undefined,
    });
  });
  afterAll(() => pool.close());

  // These pass the scan and run far past the timeout, so a pass here is the kill and not luck.
  it.each([
    ['lazy lines, 125 KB', lazyLines(125 * KB), 'md'],
    ['lazy lines, 125 KB, mdx', lazyLines(125 * KB), 'mdx'],
    ['lazy lines, 1 MB', lazyLines(1_000 * KB), 'md'],
    ['distinct frontmatter keys, 1 MB', frontmatter(1_000 * KB), 'md'],
  ] as const)(
    'stops %s at the timeout, and the next page parses',
    async (_name, source, dialect) => {
      const projectId = projectAt(project++);
      const began = performance.now();
      const result = await pool.parse(request(source, projectId, dialect));
      const took = performance.now() - began;
      expect(codeOf(result)).toBe('mdx.parse_timeout');
      expect(took).toBeLessThan(30_000);
      expect(codeOf(await pool.parse(request(honest, projectId)))).toBe('ok');
    },
    TIMEOUT_MS,
  );
});

describe('a stall inside the parser', () => {
  it(
    'ends in the GFM email regular expression, on the largest page the scan lets through',
    async () => {
      // A short timeout on a warm thread, so it lands in the transform and not in the first
      // parse, which takes over 100 ms on a CI runner.
      const limits = { ...POOL_CONFIG, timeoutMs: 30_000 };
      const script = new URL('../src/parse-worker.ts', import.meta.url);
      const pool = createParsePool(POOL_CONFIG, {
        logger: recordingLogger(),
        onStuck: () => undefined,
        startThread: () => startParseThread(script, limits),
      });
      try {
        expect(codeOf(await pool.parse(request(honest)))).toBe('ok');
        limits.timeoutMs = 50;
        const result = await pool.parse(request(sized('', 'a.', 23 * KB)));
        expect(codeOf(result)).toBe('mdx.parse_timeout');
      } finally {
        await pool.close();
      }
    },
    TIMEOUT_MS,
  );
});

describe('pages that blow the heap', () => {
  const logger = recordingLogger();
  let pool: ParsePool;
  beforeAll(() => {
    pool = createParsePool(poolConfig({ timeoutMs: 45_000, maxMemoryMb: 64 }), {
      logger,
      onStuck: () => undefined,
    });
  });
  afterAll(() => pool.close());

  it.each([
    ['table rows', sized('|a\n|-\n', 'b\n', 1_000 * KB), 0],
    ['empty paragraphs', sized('', 'a\n\n', 1_000 * KB), 1],
  ])(
    'ends %s at the memory cap, and the process lives',
    async (_name, source, index) => {
      const result = await pool.parse(request(source, projectAt(100 + index)));
      expect(codeOf(result)).toBe('mdx.out_of_memory');
      expect(codeOf(await pool.parse(request(honest, projectAt(100 + index))))).toBe('ok');
    },
    TIMEOUT_MS,
  );
});

// Honest pages here land on cold threads, and a first parse takes over 100 ms on a CI runner,
// so the timeout stays well above that. The bombs run for many seconds, so it still kills them.
describe('many hostile files', () => {
  const pools: ParsePool[] = [];
  const open = (config: Partial<ParsePoolConfig>, logger = recordingLogger()) => {
    const pool = createParsePool(poolConfig(config), { logger, onStuck: () => undefined });
    pools.push(pool);
    return pool;
  };
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.close()));
  });

  it(
    'one repo of bombs holds one thread, and its neighbour keeps working',
    async () => {
      const logger = recordingLogger();
      const pool = open(
        {
          timeoutMs: 1_000,
          maxQueued: 16,
          maxQueuedPerOrg: 8,
          maxQueuedPerProject: 8,
          orgBudgetMs: 3_000,
          projectBudgetMs: 3_000,
          windowMs: 60_000,
        },
        logger,
      );
      const canary = 'CANARY-PAGE-TEXT\n\n';
      const bomb = canary + lazyLines(60 * KB);

      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 20);
      const bombs = Array.from({ length: 40 }, () => pool.parse(request(bomb, PROJECT_A)));
      expect(pool.stats().queued).toBeLessThanOrEqual(8);

      const neighbour: ParseResult[] = [];
      for (let index = 0; index < 5; index += 1) {
        neighbour.push(await pool.parse(request(honest, PROJECT_B, 'md', ORG_B)));
        expect(pool.stats().threads).toBeLessThanOrEqual(POOL_CONFIG.threads);
      }
      const results = await Promise.all(bombs);
      clearInterval(ticker);

      expect(neighbour.map(codeOf)).toEqual(Array.from({ length: 5 }, () => 'ok'));
      const codes = results.map(codeOf);
      const killed = codes.filter((code) => code === 'mdx.parse_timeout').length;
      // The budget admits three full timeouts; anything past that is refused without a thread.
      expect(killed).toBeGreaterThanOrEqual(1);
      expect(killed).toBeLessThanOrEqual(4);
      expect(new Set(codes)).toEqual(new Set(['mdx.parse_timeout', 'mdx.organization_limit']));
      expect(ticks).toBeGreaterThan(5);

      expect(pool.stats()).toMatchObject({ busy: 0, queued: 0 });
      expect(JSON.stringify(logger.entries)).not.toContain('CANARY');
      expect(JSON.stringify(results)).not.toContain('CANARY');
      for (const { fields } of logger.entries) {
        expect([ORG_A, ORG_B]).toContain(fields['organizationId']);
        expect([PROJECT_A, PROJECT_B]).toContain(fields['projectId']);
      }
      expect(codeOf(await pool.parse(request(honest, PROJECT_B, 'md', ORG_B)))).toBe('ok');
    },
    TIMEOUT_MS,
  );

  it(
    'many hostile projects at once all settle, and an honest page still gets through',
    async () => {
      const pool = open({
        timeoutMs: 1_000,
        threads: 2,
        orgThreads: 1,
        maxQueued: 25,
        maxQueuedPerOrg: 3,
        maxQueuedPerProject: 3,
        orgBudgetMs: 1_000,
        projectBudgetMs: 1_000,
      });
      const bomb = lazyLines(60 * KB);
      const flood = Array.from({ length: 8 }, (_, tenant) =>
        Array.from({ length: 5 }, () => pool.parse(request(bomb, PROJECT_A, 'md', orgAt(tenant)))),
      ).flat();
      // Eight organizations hold 24 places, so this one takes the last. A newcomer after it takes
      // places from them, until it holds as much as they do and has to wait with the rest.
      expect(pool.stats().queued).toBe(24);
      const honestPage = pool.parse(request(honest, PROJECT_A, 'md', orgAt(99)));
      const late = [
        pool.parse(request(bomb, projectAt(1), 'md', orgAt(8))),
        pool.parse(request(bomb, projectAt(2), 'md', orgAt(8))),
      ];
      expect(pool.stats().queued).toBe(25);
      const third = pool.parse(request(bomb, projectAt(3), 'md', orgAt(8)));
      expect(codeOf(await third)).toBe('mdx.queue_full');

      const codes = (await Promise.all([...flood, ...late])).map(codeOf);
      expect(new Set(codes)).toEqual(
        new Set(['mdx.parse_timeout', 'mdx.organization_limit', 'mdx.queue_full']),
      );
      expect(codeOf(await honestPage)).toBe('ok');
      expect(pool.stats()).toMatchObject({ busy: 0, queued: 0 });
      expect(pool.stats().threads).toBeLessThanOrEqual(2);
      expect(codeOf(await pool.parse(request(honest, PROJECT_A, 'md', orgAt(99))))).toBe('ok');
    },
    TIMEOUT_MS,
  );

  // Security's measured case: 0 of 374 honest pages at these defaults before the outer limits.
  it(
    'one organization with eight projects at the default limits leaves a neighbour parsing',
    async () => {
      const pool = createParsePool(parsePoolConfig({}), {
        logger: recordingLogger(),
        onStuck: () => undefined,
      });
      pools.push(pool);
      const bomb = lazyLines(60 * KB);
      const until = performance.now() + 6_000;
      const pace = (ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        });

      const attacker = async (project: number) => {
        while (performance.now() < until) {
          await pool.parse(request(bomb, projectAt(project)));
          await pace(50);
        }
      };
      const saves: { code: string; ms: number }[] = [];
      const honestSaves = async () => {
        while (performance.now() < until) {
          const began = performance.now();
          const result = await pool.parse(request(honest, PROJECT_B, 'md', ORG_B));
          saves.push({ code: codeOf(result), ms: performance.now() - began });
          await pace(200);
        }
      };
      await Promise.all([
        ...Array.from({ length: 8 }, (_, index) => attacker(index)),
        honestSaves(),
      ]);

      expect(saves.length).toBeGreaterThan(5);
      expect(saves.filter(({ code }) => code !== 'ok')).toEqual([]);
      // A thread stays free for other organizations, so a save never waits on a bomb.
      expect(Math.max(...saves.map(({ ms }) => ms))).toBeLessThan(5_000);
    },
    TIMEOUT_MS,
  );

  // Security's measured case: 1 of 296 honest pages from eight organizations with one project
  // each, and two organizations filling the queue at the old share.
  it(
    'eight organizations acting together at the default limits leave a neighbour parsing',
    async () => {
      const pool = createParsePool(parsePoolConfig({}), {
        logger: recordingLogger(),
        onStuck: () => undefined,
      });
      pools.push(pool);
      const bomb = lazyLines(60 * KB);
      const until = performance.now() + 8_000;
      const pace = (ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        });

      const attacker = async (index: number) => {
        await Promise.all(
          Array.from({ length: 12 }, async () => {
            while (performance.now() < until) {
              await pool.parse(request(bomb, projectAt(index), 'md', orgAt(index + 1)));
              await pace(50);
            }
          }),
        );
      };
      const saves: { code: string; ms: number }[] = [];
      const honestSaves = async () => {
        while (performance.now() < until) {
          const began = performance.now();
          const result = await pool.parse(request(honest, PROJECT_B, 'md', ORG_B));
          saves.push({ code: codeOf(result), ms: performance.now() - began });
          await pace(200);
        }
      };
      await Promise.all([
        ...Array.from({ length: 8 }, (_, index) => attacker(index)),
        honestSaves(),
      ]);

      expect(saves.length).toBeGreaterThan(0);
      expect(saves.filter(({ code }) => code !== 'ok')).toEqual([]);
      // Turns go by organization: at worst eight bombs ahead, two threads, 2 s each. Load adds.
      expect(Math.max(...saves.map(({ ms }) => ms))).toBeLessThan(30_000);
    },
    TIMEOUT_MS,
  );

  it(
    'closing during a stall ends with the kill and refuses what waits',
    async () => {
      const pool = open({ timeoutMs: 300 });
      const bomb = pool.parse(request(lazyLines(60 * KB), PROJECT_A));
      const queued = pool.parse(request(honest, PROJECT_A));
      await pool.close();
      expect(codeOf(await bomb)).toBe('mdx.parse_timeout');
      expect(codeOf(await queued)).toBe('mdx.parse_unavailable');
      expect(pool.stats()).toMatchObject({ threads: 0, busy: 0, queued: 0 });
    },
    TIMEOUT_MS,
  );

  it(
    'a killed page changes nothing for the next tenant',
    async () => {
      const pool = open({ timeoutMs: 1_000 });
      await pool.parse(request(lazyLines(60 * KB), PROJECT_A));
      const result = await pool.parse(request(honest, PROJECT_B, 'md', ORG_B));
      expect(result.ok && result.value.ast.children.length).toBe(2);
    },
    TIMEOUT_MS,
  );
});
