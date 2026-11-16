import { organizationId, projectId, type CacheKey } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  SchemaCacheBusyError,
  createSchemaCache,
  parseSchemaCacheConfig,
  schemaCacheKey,
} from '../src/index.ts';
import { ORG, PRJ } from './support.ts';

const TENANT = { organizationId: organizationId(ORG), projectId: projectId(PRJ) };
const key = (version: number): CacheKey => schemaCacheKey(TENANT, version);

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sized = (maxBytes: number, maxInFlight?: number) =>
  createSchemaCache<string>({
    maxBytes,
    sizeOf: (value) => value.length,
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
  });

describe('createSchemaCache', () => {
  it('builds once and then serves the cached value', async () => {
    const cache = sized(100);
    let builds = 0;
    const build = () => {
      builds += 1;
      return Promise.resolve('value');
    };
    expect(await cache.get(key(1), build)).toBe('value');
    expect(await cache.get(key(1), build)).toBe('value');
    expect(builds).toBe(1);
    expect(cache.bytes).toBe(5);
  });

  it('runs one rebuild per key under a storm of concurrent reads', async () => {
    const cache = sized(1000);
    const release = gate();
    const counts = new Map<number, number>();
    const build = (version: number) => async () => {
      counts.set(version, (counts.get(version) ?? 0) + 1);
      await release.promise;
      return `schema ${String(version)}`;
    };
    const reads = Array.from({ length: 200 }, (_, i) => cache.get(key(i % 4), build(i % 4)));
    release.open();
    const values = await Promise.all(reads);
    expect([...counts.values()]).toEqual([1, 1, 1, 1]);
    expect(values.filter((value) => value === 'schema 2')).toHaveLength(50);

    // Evicted and read again by many at once: still one rebuild.
    cache.delete(key(2));
    const again = gate();
    let rebuilds = 0;
    const slow = async () => {
      rebuilds += 1;
      await again.promise;
      return 'rebuilt';
    };
    const storm = Array.from({ length: 100 }, () => cache.get(key(2), slow));
    again.open();
    expect(new Set(await Promise.all(storm))).toEqual(new Set(['rebuilt']));
    expect(rebuilds).toBe(1);
  });

  it('shares a failed build with its waiters and retries on the next read', async () => {
    const cache = sized(100);
    const release = gate();
    const failing = async (): Promise<string> => {
      await release.promise;
      throw new Error('boom');
    };
    const reads = [cache.get(key(1), failing), cache.get(key(1), failing)];
    release.open();
    for (const read of reads) await expect(read).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
    expect(await cache.get(key(1), () => Promise.resolve('ok'))).toBe('ok');
  });

  it('evicts the least recently used entry to stay under its byte cap', async () => {
    const cache = sized(100);
    const value = (c: string) => () => Promise.resolve(c.repeat(40));
    await cache.get(key(1), value('a'));
    await cache.get(key(2), value('b'));
    // Touch 1, so 2 is the oldest.
    await cache.get(key(1), value('x'));
    await cache.get(key(3), value('c'));
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(80);
    expect(cache.has(key(1))).toBe(true);
    expect(cache.has(key(2))).toBe(false);
    expect(cache.has(key(3))).toBe(true);
  });

  it('hands back a value too large to keep without keeping it', async () => {
    const cache = sized(10);
    expect(await cache.get(key(1), () => Promise.resolve('x'.repeat(11)))).toHaveLength(11);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('does not keep a value whose size it cannot trust', async () => {
    for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = createSchemaCache<string>({ maxBytes: 100, sizeOf: () => size });
      expect(await cache.get(key(1), () => Promise.resolve('v'))).toBe('v');
      expect(cache.size).toBe(0);
    }
  });

  it('drops a build that was deleted while it ran', async () => {
    const cache = sized(100);
    const release = gate();
    const read = cache.get(key(1), async () => {
      await release.promise;
      return 'stale';
    });
    cache.delete(key(1));
    release.open();
    expect(await read).toBe('stale');
    expect(cache.has(key(1))).toBe(false);
  });

  it('bounds builds in flight and refuses past the bound', async () => {
    const cache = sized(100, 2);
    const release = gate();
    const slow = async () => {
      await release.promise;
      return 'v';
    };
    const first = cache.get(key(1), slow);
    const second = cache.get(key(2), slow);
    // A waiter on a running build costs nothing, so it is never refused.
    const shared = cache.get(key(1), slow);
    await expect(cache.get(key(3), slow)).rejects.toBeInstanceOf(SchemaCacheBusyError);
    release.open();
    expect(await Promise.all([first, second, shared])).toEqual(['v', 'v', 'v']);
    expect(await cache.get(key(3), slow)).toBe('v');
  });

  it('refuses options that cannot bound it', () => {
    for (const maxBytes of [0, -1, 1.5]) {
      expect(() => createSchemaCache({ maxBytes, sizeOf: () => 1 })).toThrow(RangeError);
    }
    expect(() => createSchemaCache({ maxBytes: 1, maxInFlight: 0, sizeOf: () => 1 })).toThrow(
      RangeError,
    );
  });
});

describe('parseSchemaCacheConfig', () => {
  it('defaults to 256 MiB', () => {
    expect(parseSchemaCacheConfig({})).toEqual({ maxBytes: 268_435_456 });
  });

  it('reads a whole number of bytes', () => {
    expect(parseSchemaCacheConfig({ DREFYN_SCHEMA_CACHE_MAX_BYTES: '1048576' })).toEqual({
      maxBytes: 1_048_576,
    });
  });

  it('refuses anything else', () => {
    for (const value of ['0', '-1', '1.5', '1e9', 'lots', '', '99999999999999']) {
      expect(() => parseSchemaCacheConfig({ DREFYN_SCHEMA_CACHE_MAX_BYTES: value })).toThrow();
    }
  });
});
