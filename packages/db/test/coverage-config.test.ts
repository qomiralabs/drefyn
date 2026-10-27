import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config.ts';
import { INTEGRATION_COVERED, TENANCY_FILES } from '../vitest.coverage.ts';

const root = join(import.meta.dirname, '..');

interface CoverageShape {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly thresholds?: { readonly lines?: number };
}

// mergeConfig types the result loosely, so read only what this file checks.
const coverage = (unitConfig as { test?: { coverage?: CoverageShape } }).test?.coverage;

describe('coverage split between the unit and merged runs', () => {
  it('lists the tenancy files the merged run holds to 95 percent', () => {
    expect([...TENANCY_FILES].sort()).toEqual(
      [
        'src/catalog-check.ts',
        'src/config.ts',
        'src/database.ts',
        'src/integers.ts',
        'src/new-id.ts',
        'src/pg-errors.ts',
        'src/role-check.ts',
        'src/source-check.ts',
        'src/tenant-context.ts',
        'src/tenant-sql.ts',
      ].sort(),
    );
    for (const file of TENANCY_FILES) expect(existsSync(join(root, file)), file).toBe(true);
  });

  it('names the files only a real Postgres exercises, database.ts first among them', () => {
    expect(INTEGRATION_COVERED).toContain('src/database.ts');
    expect(new Set(INTEGRATION_COVERED).size).toBe(INTEGRATION_COVERED.length);
  });

  it('keeps every integration covered file on the tenancy list', () => {
    expect(INTEGRATION_COVERED.length).toBeGreaterThan(0);
    for (const file of INTEGRATION_COVERED) {
      expect(TENANCY_FILES, file).toContain(file);
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('excludes exactly those files from the unit coverage run', () => {
    expect([...(coverage?.exclude ?? [])].sort()).toEqual([...INTEGRATION_COVERED].sort());
    expect(INTEGRATION_COVERED.length).toBeGreaterThan(0);
  });

  it('keeps the unit thresholds for everything else', () => {
    expect(coverage?.include).toEqual(['src/**/*.ts']);
    expect(coverage?.thresholds?.lines).toBeGreaterThanOrEqual(85);
  });
});
