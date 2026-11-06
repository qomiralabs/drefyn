import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig } from '../src/index.ts';

describe('the engine config', () => {
  it('defaults the source cap to the render policy and the tree cap to 5 MiB', () => {
    expect(DEFAULT_ENGINE_CONFIG).toEqual({ maxNodeBytes: 1_048_576, maxTreeBytes: 5_242_880 });
  });

  it('reads both from the environment', () => {
    expect(
      parseEngineConfig({
        DREFYN_ENGINE_MAX_NODE_BYTES: '1024',
        DREFYN_ENGINE_MAX_TREE_BYTES: '4096',
      }),
    ).toEqual({ maxNodeBytes: 1024, maxTreeBytes: 4096 });
  });

  it.each([
    ['DREFYN_ENGINE_MAX_NODE_BYTES', '0'],
    ['DREFYN_ENGINE_MAX_NODE_BYTES', '1048577'],
    ['DREFYN_ENGINE_MAX_NODE_BYTES', 'lots'],
    ['DREFYN_ENGINE_MAX_TREE_BYTES', '16777217'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => parseEngineConfig({ [key]: value })).toThrow();
  });
});
