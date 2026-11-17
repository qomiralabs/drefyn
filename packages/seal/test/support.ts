import { expect } from 'vitest';
import { SealError, type SealErrorCode, type SealLabels, type SealingKey } from '../src/index.ts';

// FC_SEED reproduces a failure on any machine; without it every run uses the same seed.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}
export const runs = { seed: seedFrom(process.env['FC_SEED'], 604), numRuns: 300 } as const;

export const LABELS: SealLabels = {
  hkdfSalt: 'drefyn.test.seal.v1',
  hkdfInfo: 'drefyn/test/v1/seal',
  aadVersion: 'drefyn.test_secret.v1',
};

export const CONFIG_KEY = 'DREFYN_TEST_KEYS';

export const key = (id: string, fill: number, length = 32): SealingKey => ({
  id,
  material: new Uint8Array(length).fill(fill),
});

export function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

export function expectSealError(work: () => unknown, code: SealErrorCode): SealError {
  const error = caught(work);
  expect(error).toBeInstanceOf(SealError);
  expect((error as SealError).code).toBe(code);
  return error as SealError;
}
