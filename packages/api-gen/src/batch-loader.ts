import { ContentApiError } from './errors.ts';

export interface BatchLoaderOptions {
  // Keys per call to the load function, so one call never builds an unbounded query.
  readonly maxBatch: number;
  // Distinct keys one request may load in total. Past it, loads fail instead of queueing.
  readonly maxKeys: number;
}

export interface BatchLoader<V> {
  load(key: string): Promise<V | null>;
}

type Load<V> = (keys: readonly string[]) => Promise<readonly (V | null)[]>;

// Lives for one request. Keys asked for while a level of the query resolves wait until every
// resolver at that level has run, then go out together, so a list of n items makes one call
// and not n. Each key is loaded once per request.
export function createBatchLoader<V>(load: Load<V>, options: BatchLoaderOptions): BatchLoader<V> {
  const cache = new Map<string, Promise<V | null>>();
  let pending: { key: string; resolve: (value: V | null) => void; reject: (e: unknown) => void }[] =
    [];

  async function run(batch: typeof pending): Promise<void> {
    try {
      const values = await load(batch.map((entry) => entry.key));
      if (values.length !== batch.length) throw new Error('batch loader: answer length differs');
      for (const [index, entry] of batch.entries()) entry.resolve(values[index] ?? null);
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    }
  }

  function dispatch(): void {
    const queued = pending;
    pending = [];
    for (let start = 0; start < queued.length; start += options.maxBatch) {
      void run(queued.slice(start, start + options.maxBatch));
    }
  }

  return {
    load(key) {
      const known = cache.get(key);
      if (known !== undefined) return known;
      if (cache.size >= options.maxKeys) {
        return Promise.reject(new ContentApiError('api.query_too_complex'));
      }
      const promise = new Promise<V | null>((resolve, reject) => {
        // setImmediate runs once every promise job queued by this level has run, which is
        // what lets sibling resolvers join one batch.
        if (pending.length === 0) setImmediate(dispatch);
        pending.push({ key, resolve, reject });
      });
      cache.set(key, promise);
      return promise;
    },
  };
}
