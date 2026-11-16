import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

const ALLOWED = ['@drefyn/mdx', '@drefyn/schema', '@drefyn/tenancy', 'graphql', 'zod'];

describe('package layout', () => {
  // Pure: no engine, no database, no network. Whatever reaches the engine takes a shared one
  // as an argument, so this package must never be able to build its own.
  it('depends only on pure packages and never on the engine', () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(ALLOWED);
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(src, file), 'utf8');
      const imported = ts
        .preProcessFile(text, true, true)
        .importedFiles.map((f) => f.fileName)
        .filter((spec) => !spec.startsWith('./'));
      expect(
        imported.filter((spec) => !ALLOWED.includes(spec)),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/createEngine|process\.env|Date\.now|Math\.random/);
    }
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual([
      'CONTENT_ERROR_CODES',
      'ContentApiError',
      'FIELD_ISSUE_CODES',
      'GRAPHQL_ERROR_CODES',
      'GRAPHQL_LIMITS',
      'MAX_FILTER_PARAM_LENGTH',
      'SchemaCacheBusyError',
      'compileValidator',
      'createSchemaCache',
      'emitOpenApi',
      'graphqlEmitter',
      'parseFilterParam',
      'parseSchemaCacheConfig',
      'runGraphql',
      'schemaCacheKey',
    ]);
  });
});
