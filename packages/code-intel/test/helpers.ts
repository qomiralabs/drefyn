import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { organizationId, projectId } from '@drefyn/tenancy';
import { extractFile, loadGrammars } from '../src/index.ts';
import type { CodeLanguage, ExtractLogger, FileExtraction, LogFields } from '../src/index.ts';

const fixtures = new URL('./fixtures/', import.meta.url);

export const fixture = (name: string): string =>
  readFileSync(new URL(`${name}.txt`, fixtures), 'utf8');

const expectedSchema = (value: unknown) =>
  value as { partial: boolean; symbols: Record<string, unknown>[] };

// The expectation files leave out language and path, which every symbol shares.
export async function expectFixture(
  language: CodeLanguage,
  name: string,
  path: string,
): Promise<FileExtraction> {
  const grammars = await loadGrammars();
  const base = name.replace(/\.[a-z]+$/, '');
  const expected = expectedSchema(
    JSON.parse(readFileSync(new URL(`${base}.expected.json`, fixtures), 'utf8')),
  );
  const result = extractFile(language, fixture(name), grammars, { path });
  const withoutShared = result.symbols.map((symbol) =>
    Object.fromEntries(
      Object.entries(symbol).filter(([key]) => key !== 'language' && key !== 'path'),
    ),
  );
  expect(withoutShared).toEqual(expected.symbols);
  expect(new Set(result.symbols.map((symbol) => symbol.language))).toEqual(
    new Set(result.symbols.length > 0 ? [language] : []),
  );
  expect(result.symbols.every((symbol) => symbol.path === path)).toBe(true);
  expect(result.partial).toBe(expected.partial);
  return result;
}

export const TENANT = {
  organizationId: organizationId('00000000-0000-4000-8000-00000000000a'),
  projectId: projectId('00000000-0000-4000-8000-0000000000a1'),
};

// Generic arguments that never close send the TypeScript grammar's error recovery down a path
// many times slower than real code: about 3 s for these 510 KB, where a real file of that size
// takes about 250 ms. It stays under the byte limit so that it reaches the grammar.
export const SLOW_TYPESCRIPT = 'f<a<b<'.repeat(85_000);

export interface LogLine {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields;
}

export function recordingLogger(): { logger: ExtractLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      info: (event, fields) => lines.push({ level: 'info', event, fields }),
      warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
    },
  };
}
