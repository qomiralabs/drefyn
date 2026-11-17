import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SealError, aesGcmSealer } from '../src/index.ts';
import { CONFIG_KEY, LABELS, caught } from './support.ts';

const MATERIAL = new Uint8Array(32).map((_, i) => 200 - i);
// A canary a reader would spot in any log line.
const CANARY = Buffer.from('sk-canary-7f3a9c1e5b2d8f4a6c0e9b7d', 'utf8');
const BOUND = ['0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f', '01934c1e-7a2b-7c3d-8e4f-5a6b7c8d9e0f'];

// Every way a value could be spelled once it reaches text.
function spellings(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString('hex'),
    buffer.toString('base64'),
    buffer.toString('base64url'),
    inspect(buffer).slice(8, 40),
    Array.from(bytes.subarray(0, 8)).join(', '),
    Array.from(bytes.subarray(0, 8)).join(','),
  ];
}

function printed(error: unknown): string {
  return [
    String(error),
    (error as Error).stack ?? '',
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
    inspect((error as Error).cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

describe('sealed values and key material stay out of logs and errors', () => {
  const output: unknown[] = [];

  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(...args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    output.length = 0;
  });

  it('a refused open names nothing it was given or holds', () => {
    const sealer = aesGcmSealer([{ id: 'k1', material: MATERIAL }], LABELS, CONFIG_KEY);
    const row = sealer.seal(CANARY, BOUND);
    const bent = Buffer.from(row.sealed);
    bent[0] = (bent[0] ?? 0) ^ 1;
    for (const work of [
      () => sealer.open(row, ['someone else']),
      () => sealer.open({ ...row, sealed: bent }, BOUND),
      () => sealer.open({ ...row, keyId: 'k9' }, BOUND),
      () => sealer.open({ ...row, nonce: row.nonce.subarray(1) }, BOUND),
      () => sealer.open(row, []),
    ]) {
      const error = caught(work);
      expect(error).toBeInstanceOf(SealError);
      expect((error as Error).cause).toBeUndefined();
      const text = printed(error);
      expect(text).not.toContain(CANARY.toString('utf8'));
      for (const value of BOUND) expect(text).not.toContain(value);
      for (const bytes of [MATERIAL, CANARY, row.nonce, row.sealed]) {
        for (const spelling of spellings(bytes)) expect(text).not.toContain(spelling);
      }
    }
    expect(output).toEqual([]);
  });

  it('a refused keyring names the config key and a position, never an id or material', () => {
    const error = caught(() =>
      aesGcmSealer(
        [
          { id: 'secretid', material: MATERIAL },
          { id: 'secretid', material: MATERIAL },
        ],
        LABELS,
        CONFIG_KEY,
      ),
    );
    const text = printed(error);
    expect(text).toContain(CONFIG_KEY);
    expect(text).not.toContain('secretid');
    for (const spelling of spellings(MATERIAL)) expect(text).not.toContain(spelling);
    expect(output).toEqual([]);
  });

  it('a sealer prints no key material', () => {
    const sealer = aesGcmSealer([{ id: 'k1', material: MATERIAL }], LABELS, CONFIG_KEY);
    const text = [JSON.stringify(sealer), inspect(sealer, { depth: 10, showHidden: true })].join(
      '\n',
    );
    for (const spelling of spellings(MATERIAL)) expect(text).not.toContain(spelling);
    expect(output).toEqual([]);
  });
});
