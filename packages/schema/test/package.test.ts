import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
  drefyn?: { pureEntries?: string[] };
  dependencies?: Record<string, string>;
};

describe('package layout', () => {
  it('has one pure entry, so Studio can run the same rules in a browser', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './package.json': './package.json',
    });
    expect(manifest.drefyn?.pureEntries).toEqual(['.']);
  });

  it('depends on zod and nothing else', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const imported = ts
        .preProcessFile(readFileSync(join(src, file), 'utf8'), true, true)
        .importedFiles.map((f) => f.fileName)
        .filter((spec) => !spec.startsWith('./'));
      expect(
        imported.filter((spec) => spec !== 'zod'),
        file,
      ).toEqual([]);
    }
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual([
      'FILTER_ERROR_CODES',
      'FILTER_SLOTS',
      'MAX_FIELDS',
      'MAX_FIELD_DEPTH',
      'MAX_FILTER_DEPTH',
      'MAX_FILTER_FIELDS',
      'MAX_FILTER_IN_VALUES',
      'MAX_FILTER_NODES',
      'MAX_FILTER_TEXT_BYTES',
      'MAX_LABEL_LENGTH',
      'MAX_LIST_ITEMS',
      'MAX_REFERENCE_TARGETS',
      'MAX_TEXT_BYTES',
      'SCHEMA_ERROR_CODES',
      'UNDECLARED_FILTER_MAX_ITEMS',
      'asFieldId',
      'asTypeId',
      'checkApiName',
      'checkFilter',
      'formatUnits',
      'parseContentSchema',
      'parseFilterNode',
      'parseUnits',
      'slotClassOf',
      'validateSchema',
    ]);
  });
});
