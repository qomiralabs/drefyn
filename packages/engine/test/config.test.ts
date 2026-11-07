import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig } from '../src/index.ts';

describe('the engine config', () => {
  it('defaults the source cap to the render policy and the tree cap to 5 MiB', () => {
    expect(DEFAULT_ENGINE_CONFIG).toMatchObject({
      maxNodeBytes: 1_048_576,
      maxTreeBytes: 5_242_880,
    });
  });

  it('defaults chunks to a target of 800 characters and a cap of 2000', () => {
    expect(DEFAULT_ENGINE_CONFIG).toMatchObject({ chunkTargetChars: 800, chunkMaxChars: 2000 });
  });

  it('reads both from the environment', () => {
    expect(
      parseEngineConfig({
        DREFYN_ENGINE_MAX_NODE_BYTES: '1024',
        DREFYN_ENGINE_MAX_TREE_BYTES: '4096',
      }),
    ).toMatchObject({ maxNodeBytes: 1024, maxTreeBytes: 4096 });
  });

  it('reads chunk sizes from the environment', () => {
    expect(
      parseEngineConfig({ DREFYN_CHUNK_TARGET_CHARS: '400', DREFYN_CHUNK_MAX_CHARS: '1000' }),
    ).toMatchObject({ chunkTargetChars: 400, chunkMaxChars: 1000 });
  });

  it('defaults the list timeout to 2 s and the scan limit to 20,000 items', () => {
    expect(DEFAULT_ENGINE_CONFIG).toMatchObject({
      queryTimeoutMs: 2000,
      undeclaredScanMaxItems: 20_000,
    });
  });

  it('reads both from the environment', () => {
    expect(
      parseEngineConfig({
        DREFYN_ENGINE_QUERY_TIMEOUT_MS: '500',
        DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS: '1000',
        DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT: '2',
      }),
    ).toMatchObject({ queryTimeoutMs: 500, undeclaredScanMaxItems: 1000, queryMaxInFlight: 2 });
  });

  it('refuses a target above the cap', () => {
    expect(() =>
      parseEngineConfig({ DREFYN_CHUNK_TARGET_CHARS: '2001', DREFYN_CHUNK_MAX_CHARS: '2000' }),
    ).toThrow();
  });

  it.each([
    ['DREFYN_ENGINE_MAX_NODE_BYTES', '0'],
    ['DREFYN_ENGINE_MAX_NODE_BYTES', '1048577'],
    ['DREFYN_ENGINE_MAX_NODE_BYTES', 'lots'],
    ['DREFYN_ENGINE_MAX_TREE_BYTES', '16777217'],
    ['DREFYN_CHUNK_TARGET_CHARS', '1'],
    ['DREFYN_CHUNK_MAX_CHARS', '200001'],
    ['DREFYN_ENGINE_QUERY_TIMEOUT_MS', '0'],
    ['DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT', '0'],
    ['DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT', '257'],
    ['DREFYN_ENGINE_QUERY_TIMEOUT_MS', '60001'],
    ['DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS', '1000001'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => parseEngineConfig({ [key]: value })).toThrow();
  });
});
