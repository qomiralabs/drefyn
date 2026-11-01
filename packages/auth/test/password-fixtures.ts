import { createPasswordHasher, type Argon2Params } from '../src/index.ts';

// Tiny parameters: the hashing code is the same, and a test hash costs well under 1 ms.
export const SMALL: Argon2Params = { memoryKib: 64, passes: 1, parallelism: 1 };

export const smallHasher = (extra: Partial<Parameters<typeof createPasswordHasher>[0]> = {}) =>
  createPasswordHasher({
    params: SMALL,
    floor: SMALL,
    concurrency: 4,
    queueMax: 64,
    ...extra,
  });
