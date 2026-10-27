import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extensionDdlProblems, sessionSettingProblems } from '../src/source-check.ts';

const SEEDS = [1, 42, 20261026];

const BAD_DDL = [
  ['create', 'extension', 'pg_trgm'],
  ['alter', 'extension', 'vector', 'update'],
  ['drop', 'extension', 'vector'],
  ['comment', 'on', 'extension', 'vector', 'is', "'x'"],
  ['alter', 'schema', 'extensions', 'owner', 'to', 'drefyn_owner'],
  ['grant', 'create', 'on', 'schema', 'extensions', 'to', 'drefyn_owner'],
  ['create', 'table', 'extensions.t', '(id', 'int)'],
  ['alter', 'function', 'app.f()', 'set', 'schema', 'extensions'],
];

// Anything SQL allows between two tokens.
const gap = fc
  .array(fc.constantFrom(' ', '\n', '\t', '  ', ' /* note */ ', ' -- note\n', '\r\n'), {
    minLength: 1,
    maxLength: 3,
  })
  .map((parts) => parts.join(''));

const casing = (word: string) =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((flags) =>
      flags.map((upper, i) => (upper ? word.charAt(i).toUpperCase() : word.charAt(i))).join(''),
    );

function spelled(tokens: readonly string[]) {
  return fc
    .tuple(
      fc.tuple(...tokens.map(casing)),
      fc.array(gap, { minLength: tokens.length, maxLength: tokens.length }),
    )
    .map(([words, gaps]) => words.map((w, i) => (i === 0 ? w : `${gaps[i] ?? ' '}${w}`)).join(''));
}

const migrationOf = (statement: string) =>
  `-- Up Migration\n${statement};\n\n-- Down Migration\nselect 1;\n`;

const identifier = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,20}$/)
  .filter((name) => !name.includes('extension'));

// Building the first binary string costs about 300 ms in fast-check, so it happens here, at
// collection, instead of inside the first test's timeout.
const anyText = fc.string({ unit: 'binary', maxLength: 400 });
fc.sample(anyText, { seed: 0, numRuns: 1 });

// 400 runs take 3 to 25 ms once warm on a quiet laptop; cold they took about 300 ms there and
// near 6 s under heavy load, so the limit leaves room for a loaded CI runner.
const FUZZ_TIMEOUT_MS = 20_000;

describe.each(SEEDS)('source checks with seed %i', (seed) => {
  it('never throw on arbitrary text', { timeout: FUZZ_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(anyText, (text) => {
        expect(Array.isArray(extensionDdlProblems('f.sql', text))).toBe(true);
        expect(Array.isArray(sessionSettingProblems('f.ts', text))).toBe(true);
      }),
      { seed, numRuns: 400 },
    );
  });

  it('find extension DDL however it is spaced, cased or commented', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BAD_DDL).chain((tokens) => spelled(tokens)),
        (statement) => extensionDdlProblems('f.sql', migrationOf(statement)).length > 0,
      ),
      { seed, numRuns: 300 },
    );
  });

  it('pass tenant tables with vector columns under any safe names', () => {
    fc.assert(
      fc.property(
        identifier,
        identifier,
        fc.integer({ min: 1, max: 2000 }),
        (table, column, dims) => {
          const sql = migrationOf(
            `create table app.${table} (id uuid primary key, organization_id uuid not null, ${column} extensions.vector(${String(dims)}));\n` +
              `create index ${table}_idx on app.${table} using hnsw (${column} vector_cosine_ops)`,
          );
          return extensionDdlProblems('f.sql', sql).length === 0;
        },
      ),
      { seed, numRuns: 300 },
    );
  });

  it('find set_config with false however the arguments are spaced', () => {
    fc.assert(
      fc.property(gap, gap, gap, casing('set_config'), casing('false'), (a, b, c, name, no) => {
        const text = `select ${name}(${a}'drefyn.organization_id',${b}$1,${c}${no})`;
        return sessionSettingProblems('f.sql', text).length > 0;
      }),
      { seed, numRuns: 300 },
    );
  });

  it('pass set_config with true however the arguments are spaced', () => {
    fc.assert(
      fc.property(gap, gap, casing('true'), (a, b, yes) => {
        const text = `select set_config('drefyn.organization_id',${a}$1,${b}${yes})`;
        return sessionSettingProblems('f.sql', text).length === 0;
      }),
      { seed, numRuns: 300 },
    );
  });
});
