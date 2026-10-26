import { describe, expect, it } from 'vitest';
import { defineFlags, flags, type FlagDefinition } from '../src/index.ts';

// Widened, so the checks still hold once other kinds join the registry.
const registry: readonly FlagDefinition[] = flags;

describe('the registry', () => {
  it('holds the three product release flags', () => {
    const products = flags.filter((flag) => flag.name.startsWith('product.'));
    expect(products.map((flag) => flag.name).sort()).toEqual([
      'product.docs',
      'product.status',
      'product.studio',
    ]);
    for (const flag of products) {
      expect(flag.kind).toBe('release');
      expect(flag).toMatchObject({ safeValue: false });
    }
  });

  it('gives every flag an owner, a description and a removal date after it was created', () => {
    for (const flag of flags) {
      expect(flag.owner.trim(), flag.name).not.toBe('');
      expect(flag.description.trim(), flag.name).not.toBe('');
      expect(Date.parse(flag.removeBy), flag.name).toBeGreaterThan(Date.parse(flag.created));
    }
  });

  it('never lets a release or experiment flag fail open', () => {
    for (const flag of registry) {
      if (flag.kind === 'release' || flag.kind === 'experiment') {
        expect(flag.safeValue, flag.name).toBe(false);
      }
    }
  });

  it('is validated at module load: it passes the same check again', () => {
    expect(() => defineFlags([...flags] as readonly FlagDefinition[])).not.toThrow();
  });

  it('is frozen, so no caller can add a flag or flip a safe value', () => {
    expect(Object.isFrozen(flags)).toBe(true);
    for (const flag of flags) expect(Object.isFrozen(flag), flag.name).toBe(true);
    expect(() => {
      (flags as unknown as FlagDefinition[]).push(flags[0]);
    }).toThrow(TypeError);
  });
});
