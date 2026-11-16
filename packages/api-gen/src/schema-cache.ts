import type { CacheKey } from '@drefyn/tenancy';

export interface SchemaCacheOptions<T> {
  readonly maxBytes: number;
  // Distinct keys that may build at once. A waiter on a running build is free and not counted.
  readonly maxInFlight?: number;
  // An estimate in bytes. A size that is not a whole number at or above zero is never kept.
  readonly sizeOf: (value: T) => number;
}

export interface SchemaCache<T> {
  // Builds on a miss, once per key however many callers ask at the same time.
  get(key: CacheKey, build: () => Promise<T>): Promise<T>;
  delete(key: CacheKey): void;
  has(key: CacheKey): boolean;
  readonly bytes: number;
  readonly size: number;
}

export class SchemaCacheBusyError extends Error {
  readonly code = 'api_gen.cache_busy';

  constructor() {
    super('too many schema builds in flight');
    this.name = 'SchemaCacheBusyError';
  }
}

const DEFAULT_MAX_IN_FLIGHT = 256;

interface Entry<T> {
  readonly value: T;
  readonly bytes: number;
}

interface Flight<T> {
  readonly promise: Promise<T>;
  // Cleared by delete, so a build that started before it is not stored after it.
  current: boolean;
}

const isCount = (value: number) => Number.isSafeInteger(value) && value >= 1;

export function createSchemaCache<T>(options: SchemaCacheOptions<T>): SchemaCache<T> {
  const { maxBytes, maxInFlight = DEFAULT_MAX_IN_FLIGHT, sizeOf } = options;
  if (!isCount(maxBytes)) throw new RangeError('createSchemaCache: maxBytes must be at least 1');
  if (!isCount(maxInFlight)) {
    throw new RangeError('createSchemaCache: maxInFlight must be at least 1');
  }
  // Map order is insertion order, so re-inserting on a hit keeps the oldest entry first.
  const entries = new Map<CacheKey, Entry<T>>();
  const flights = new Map<CacheKey, Flight<T>>();
  let bytes = 0;
  // Builds still running, including ones a delete has disowned, so deletes cannot unbound it.
  let building = 0;

  const remove = (key: CacheKey) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    bytes -= entry.bytes;
  };

  const store = (key: CacheKey, value: T) => {
    const size = sizeOf(value);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return;
    remove(key);
    for (const [oldest] of entries) {
      if (bytes + size <= maxBytes) break;
      remove(oldest);
    }
    entries.set(key, { value, bytes: size });
    bytes += size;
  };

  return {
    get(key, build) {
      const hit = entries.get(key);
      if (hit !== undefined) {
        entries.delete(key);
        entries.set(key, hit);
        return Promise.resolve(hit.value);
      }
      const running = flights.get(key);
      if (running !== undefined) return running.promise;
      if (building >= maxInFlight) return Promise.reject(new SchemaCacheBusyError());
      building += 1;
      const flight: Flight<T> = {
        current: true,
        promise: Promise.resolve()
          .then(build)
          .then((value) => {
            if (flight.current) store(key, value);
            return value;
          })
          .finally(() => {
            building -= 1;
            if (flights.get(key) === flight) flights.delete(key);
          }),
      };
      flights.set(key, flight);
      return flight.promise;
    },
    delete(key) {
      remove(key);
      const flight = flights.get(key);
      if (flight !== undefined) {
        flight.current = false;
        flights.delete(key);
      }
    },
    has(key) {
      return entries.has(key);
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return entries.size;
    },
  };
}
