import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('package layout', () => {
  it('is @drefyn/ai with one entry', () => {
    expect(manifest.name).toBe('@drefyn/ai');
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './package.json': './package.json' });
  });

  it('depends on no vendor SDK: the wire formats are spoken over the egress guard', () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@drefyn/credits',
      '@drefyn/egress',
      '@drefyn/tenancy',
      'zod',
    ]);
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual([
      'fast-check',
      'typescript',
    ]);
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual([
      'ANTHROPIC_DEFAULT_BASE_URL',
      'ANTHROPIC_DEFAULT_MODEL',
      'MODEL_ERROR_CAUSES',
      'MODEL_ERROR_CODES',
      'ModelConfigError',
      'ModelKey',
      'createAnthropicProvider',
      'createModelProvider',
      'createOpenAiCompatibleProvider',
      'loadModelConfig',
    ]);
  });

  it('reaches the network only through @drefyn/egress', () => {
    const src = join(root, 'src');
    for (const file of readdirSync(src)) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/\bfetch\(|node:(?:http|https|net|tls)\b|from 'undici'/);
    }
  });
});
