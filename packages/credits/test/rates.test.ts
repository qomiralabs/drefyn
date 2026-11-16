import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CreditError,
  RateTableError,
  credits,
  creditsForUsage,
  estimateCredits,
  estimateMonthlyRuns,
  parseRateTable,
  type AiOperation,
  type ModelCall,
  type PlannedCall,
  type RateTable,
} from '../src/index.ts';
import { FIXTURE_TABLE, fixtureCopy, usage } from './rates.fixture.ts';

const table = parseRateTable(FIXTURE_TABLE);

function failure(run: () => unknown): { code: string; path: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof RateTableError) {
      return { code: error.code, path: error.path, message: error.message };
    }
    if (error instanceof CreditError) return { code: error.code, path: '', message: '' };
    throw error;
  }
  throw new Error('expected a failure');
}

// Edits a fresh copy of the fixture through a small path language: names and indexes.
function mutated(edit: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = fixtureCopy();
  edit(draft);
  return draft;
}

type Json = Record<string, unknown>;
function at(draft: Json, ...keys: (string | number)[]): Json {
  let node: unknown = draft;
  for (const key of keys) node = (node as Record<string | number, unknown>)[key];
  return node as Json;
}

function expectInvalid(value: unknown, path: string): void {
  const result = failure(() => parseRateTable(value));
  expect(result.code).toBe('RATE_TABLE_INVALID');
  expect(result.path).toBe(path);
  expect(result.message).toBe(`rate table is invalid at ${path}`);
}

describe('parseRateTable', () => {
  it('parses the fixture into a frozen table with only the known fields', () => {
    expect(table).toEqual(FIXTURE_TABLE);
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.models)).toBe(true);
    for (const model of table.models) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.bands)).toBe(true);
      for (const band of model.bands) expect(Object.isFrozen(band)).toBe(true);
    }
    expect(Object.isFrozen(table.defaults)).toBe(true);
    expect(Object.isFrozen(table.reference)).toBe(true);
  });

  it('keeps no reference to the input', () => {
    const input = fixtureCopy();
    const parsed = parseRateTable(input);
    at(input, 'models', 0, 'bands', 0)['input'] = 1;
    expect(parsed.models[0]?.bands[0]?.input).toBe(16_667);
  });

  it('accepts a table with no reference profiles', () => {
    expect(parseRateTable(mutated((d) => (d['reference'] = []))).reference).toEqual([]);
  });

  it('refuses what is not a table', () => {
    for (const value of [null, undefined, 7, 'table', [], [FIXTURE_TABLE]]) {
      expectInvalid(value, 'table');
    }
  });

  it('refuses unknown fields at every level, naming the object and never the key', () => {
    expectInvalid(
      mutated((d) => (d['extra'] = 1)),
      'table',
    );
    expectInvalid(
      mutated((d) => (at(d, 'models', 1)['extra'] = 1)),
      'models[1]',
    );
    expectInvalid(
      mutated((d) => (at(d, 'models', 0, 'bands', 1)['extra'] = 1)),
      'models[0].bands[1]',
    );
    expectInvalid(
      mutated((d) => (at(d, 'defaults')['sms'] = 'fixture-mid')),
      'defaults',
    );
    expectInvalid(
      mutated((d) => (at(d, 'reference', 0)['extra'] = 1)),
      'reference[0]',
    );
    expectInvalid(
      mutated((d) => (at(d, 'reference', 0, 'calls', 0)['x'] = 1)),
      'reference[0].calls[0]',
    );
    expectInvalid(
      mutated((d) => (at(d, 'reference', 0, 'calls', 0, 'usage')['cacheWrite'] = 1)),
      'reference[0].calls[0].usage',
    );
  });

  it('refuses a symbol keyed field and a field reached only through the prototype', () => {
    expectInvalid(
      mutated((d) => ((d as Record<symbol, unknown>)[Symbol('x')] = 1)),
      'table',
    );
    const inherited = Object.create(fixtureCopy()) as object;
    expectInvalid(inherited, 'version');
  });

  it('refuses a bad version', () => {
    for (const version of ['', ' 1', 'a/b', 7, null, 'v'.repeat(65)]) {
      expectInvalid(
        mutated((d) => (d['version'] = version)),
        'version',
      );
    }
  });

  it('refuses an empty, missing or oversized model list', () => {
    expectInvalid(
      mutated((d) => (d['models'] = [])),
      'models',
    );
    expectInvalid(
      mutated((d) => delete d['models']),
      'models',
    );
    expectInvalid(
      mutated((d) => (d['models'] = {})),
      'models',
    );
    const many = Array.from({ length: 257 }, (_, i) => ({
      ...(FIXTURE_TABLE.models[1] as object),
      modelId: `m${String(i)}`,
    }));
    expectInvalid(
      mutated((d) => (d['models'] = many)),
      'models',
    );
  });

  it('refuses a hole in a list', () => {
    const models = [...FIXTURE_TABLE.models];
    // eslint-disable-next-line @typescript-eslint/no-array-delete -- a sparse array is the case
    delete (models as unknown[])[1];
    expectInvalid(
      mutated((d) => (d['models'] = models)),
      'models[1]',
    );
  });

  describe('one failing case per rule', () => {
    it('model ids are unique', () => {
      expectInvalid(
        mutated((d) => (at(d, 'models', 2)['modelId'] = 'fixture-small')),
        'models[2].modelId',
      );
    });

    it('model ids match the pattern', () => {
      for (const id of ['', 'Upper', '-lead', '.lead', 'has space', 'a_b', 'a'.repeat(64), 7]) {
        expectInvalid(
          mutated((d) => (at(d, 'models', 0)['modelId'] = id)),
          'models[0].modelId',
        );
      }
      const longest = 'a'.repeat(63);
      const ok = mutated((d) => {
        at(d, 'models', 2)['modelId'] = longest;
      });
      expect(parseRateTable(ok).models[2]?.modelId).toBe(longest);
    });

    it('premium is a boolean', () => {
      expectInvalid(
        mutated((d) => (at(d, 'models', 0)['premium'] = 'no')),
        'models[0].premium',
      );
    });

    it('bands are strictly ascending', () => {
      const edit = (bounds: number[]) =>
        mutated((d) => {
          const band = at(d, 'models', 0, 'bands', 0);
          at(d, 'models', 0)['bands'] = [
            ...bounds.map((bound) => ({ ...band, upToPromptTokens: bound })),
            { ...band, upToPromptTokens: null },
          ];
        });
      expectInvalid(edit([10, 10]), 'models[0].bands[1].upToPromptTokens');
      expectInvalid(edit([10, 9]), 'models[0].bands[1].upToPromptTokens');
      expect(parseRateTable(edit([10, 11])).models[0]?.bands).toHaveLength(3);
    });

    it('a null bound appears on the last band only', () => {
      expectInvalid(
        mutated((d) => (at(d, 'models', 0, 'bands', 0)['upToPromptTokens'] = null)),
        'models[0].bands[0].upToPromptTokens',
      );
      expectInvalid(
        mutated((d) => (at(d, 'models', 0, 'bands', 1)['upToPromptTokens'] = 200_000)),
        'models[0].bands[1].upToPromptTokens',
      );
      expectInvalid(
        mutated((d) => (at(d, 'models', 1, 'bands', 0)['upToPromptTokens'] = 5)),
        'models[1].bands[0].upToPromptTokens',
      );
    });

    it('a model has between one and sixteen bands', () => {
      expectInvalid(
        mutated((d) => (at(d, 'models', 1)['bands'] = [])),
        'models[1].bands',
      );
      const band = FIXTURE_TABLE.models[1].bands[0];
      const many = [
        ...Array.from({ length: 16 }, (_, i) => ({ ...band, upToPromptTokens: i + 1 })),
        band,
      ];
      expectInvalid(
        mutated((d) => (at(d, 'models', 1)['bands'] = many)),
        'models[1].bands',
      );
    });

    it('defaults name a non premium model in the table', () => {
      expectInvalid(
        mutated((d) => (at(d, 'defaults')['generation'] = 'fixture-large')),
        'defaults.generation',
      );
      expectInvalid(
        mutated((d) => (at(d, 'defaults')['stale_draft'] = 'nope')),
        'defaults.stale_draft',
      );
      expectInvalid(
        mutated((d) => (at(d, 'defaults')['reader_answer'] = 7)),
        'defaults.reader_answer',
      );
      expectInvalid(
        mutated((d) => delete at(d, 'defaults')['incident_draft']),
        'defaults.incident_draft',
      );
      expectInvalid(
        mutated((d) => (d['defaults'] = null)),
        'defaults',
      );
    });

    it('the check model is in the table', () => {
      expectInvalid(
        mutated((d) => (d['checkModel'] = 'nope')),
        'checkModel',
      );
      expectInvalid(
        mutated((d) => (d['checkModel'] = undefined)),
        'checkModel',
      );
    });

    it('at most one reference per operation', () => {
      expectInvalid(
        mutated((d) => (at(d, 'reference', 1)['operation'] = 'stale_draft')),
        'reference[1].operation',
      );
    });

    it('a reference names a known operation, roles and at least one call', () => {
      expectInvalid(
        mutated((d) => (at(d, 'reference', 0)['operation'] = 'sms')),
        'reference[0].operation',
      );
      expectInvalid(
        mutated((d) => (at(d, 'reference', 0)['calls'] = [])),
        'reference[0].calls',
      );
      expectInvalid(
        mutated((d) => (at(d, 'reference', 0, 'calls', 1)['role'] = 'judge')),
        'reference[0].calls[1].role',
      );
      expectInvalid(
        mutated((d) => (at(d, 'reference', 0, 'calls', 1)['usage'] = [])),
        'reference[0].calls[1].usage',
      );
      const six = Array.from({ length: 6 }, () => FIXTURE_TABLE.reference[1]);
      expectInvalid(
        mutated((d) => (d['reference'] = six)),
        'reference',
      );
    });

    it('every number is a non negative safe integer', () => {
      for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, '5', null, -0.5, 5n]) {
        expectInvalid(
          mutated((d) => (at(d, 'models', 2, 'bands', 0)['output'] = bad)),
          'models[2].bands[0].output',
        );
        expectInvalid(
          mutated((d) => (at(d, 'models', 0, 'bands', 0)['upToPromptTokens'] = bad)),
          'models[0].bands[0].upToPromptTokens',
        );
        expectInvalid(
          mutated((d) => (at(d, 'reference', 0, 'calls', 0, 'usage')['cacheRead'] = bad)),
          'reference[0].calls[0].usage.cacheRead',
        );
      }
      const zero = parseRateTable(
        mutated((d) => (at(d, 'models', 2, 'bands', 0)['cacheRead'] = -0)),
      );
      expect(Object.is(zero.models[2]?.bands[0]?.cacheRead, 0)).toBe(true);
    });
  });
});

describe('creditsForUsage', () => {
  it('rounds half up once over the whole operation', () => {
    // 1,500,000 tokens at 1,000 millicredits per million is 1.5 credits: rounds to 2.
    const one = parseRateTable(
      mutated((d) => {
        at(d, 'models', 1, 'bands', 0)['input'] = 1_000;
      }),
    );
    expect(creditsForUsage(one, [{ modelId: 'fixture-mid', usage: usage(1_500_000, 0) }])).toBe(2);
    expect(creditsForUsage(one, [{ modelId: 'fixture-mid', usage: usage(1_499_999, 0) }])).toBe(1);
    expect(creditsForUsage(one, [{ modelId: 'fixture-mid', usage: usage(2_499_999, 0) }])).toBe(2);
    expect(creditsForUsage(one, [{ modelId: 'fixture-mid', usage: usage(2_500_000, 0) }])).toBe(3);
    // Three calls of 0.5 credits each are 1.5 together, so 2, not three times 1.
    const half = { modelId: 'fixture-mid', usage: usage(500_000, 0) };
    expect(creditsForUsage(one, [half, half, half])).toBe(2);
  });

  it('charges at least one credit, even for no tokens', () => {
    expect(creditsForUsage(table, [{ modelId: 'fixture-small', usage: usage(0, 0) }])).toBe(1);
  });

  it('prices every token class at its own rate', () => {
    const only = (name: string, rate: number): RateTable =>
      parseRateTable(
        mutated((d) => {
          const band = at(d, 'models', 1, 'bands', 0);
          for (const key of ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']) {
            band[key] = key === name ? rate : 0;
          }
        }),
      );
    const all = { input: 1e6, cacheWrite5m: 2e6, cacheWrite1h: 3e6, cacheRead: 4e6, output: 5e6 };
    for (const [name, tokens] of Object.entries(all)) {
      expect(creditsForUsage(only(name, 7_000), [{ modelId: 'fixture-mid', usage: all }])).toBe(
        (7 * tokens) / 1e6,
      );
    }
  });

  it('uses the first band up to 100,000 prompt tokens and the second from 100,001', () => {
    const at100k = creditsForUsage(table, [{ modelId: 'fixture-small', usage: usage(100_000, 0) }]);
    const over = creditsForUsage(table, [{ modelId: 'fixture-small', usage: usage(100_001, 0) }]);
    // 100,000 x 16,667 is 1.67 credits; 100,001 x 83,334 is 8.33 credits.
    expect(at100k).toBe(2);
    expect(over).toBe(8);
  });

  it('counts cache reads and writes toward the band', () => {
    const split = {
      input: 50_000,
      cacheWrite5m: 20_000,
      cacheWrite1h: 10_000,
      cacheRead: 20_001,
      output: 0,
    };
    const second = creditsForUsage(table, [{ modelId: 'fixture-small', usage: split }]);
    const first = creditsForUsage(table, [
      { modelId: 'fixture-small', usage: { ...split, cacheRead: 20_000 } },
    ]);
    expect(second).toBeGreaterThan(first * 3);
  });

  it('refuses an unknown model with RATE_MODEL_UNKNOWN and its path', () => {
    for (const modelId of ['nope', 'FIXTURE-MID', '', 7, undefined]) {
      const result = failure(() =>
        creditsForUsage(table, [
          { modelId: 'fixture-mid', usage: usage(1, 1) },
          { modelId, usage: usage(1, 1) } as ModelCall,
        ]),
      );
      expect(result).toEqual({
        code: 'RATE_MODEL_UNKNOWN',
        path: 'calls[1].modelId',
        message: 'model is not in the rate table at calls[1].modelId',
      });
    }
  });

  it('refuses negative, fractional or unsafe token counts with RATE_USAGE_INVALID', () => {
    for (const bad of [-1, 0.5, 2 ** 53, Number.NaN, '1', null, undefined]) {
      for (const name of ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']) {
        const result = failure(() =>
          creditsForUsage(table, [
            { modelId: 'fixture-mid', usage: { ...usage(1, 1), [name]: bad } },
          ]),
        );
        expect(result.code).toBe('RATE_USAGE_INVALID');
        expect(result.path).toBe(`calls[0].usage.${name}`);
      }
    }
  });

  it('refuses a malformed call list', () => {
    const tooMany = Array.from({ length: 65 }, () => ({
      modelId: 'fixture-mid',
      usage: usage(1, 1),
    }));
    for (const calls of [[], tooMany, null, 'calls']) {
      expect(failure(() => creditsForUsage(table, calls as never))).toMatchObject({
        code: 'RATE_USAGE_INVALID',
        path: 'calls',
      });
    }
    for (const call of [null, 'call', []]) {
      expect(failure(() => creditsForUsage(table, [call] as never))).toMatchObject({
        code: 'RATE_USAGE_INVALID',
        path: 'calls[0]',
      });
    }
    expect(
      failure(() =>
        creditsForUsage(table, [
          { modelId: 'fixture-mid', usage: { ...usage(1, 1), extra: 1 } } as ModelCall,
        ]),
      ),
    ).toMatchObject({ code: 'RATE_USAGE_INVALID', path: 'calls[0].usage' });
  });

  it('refuses a charge past the safe integer range instead of rounding it', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const steep = parseRateTable(mutated((d) => (at(d, 'models', 2, 'bands', 0)['output'] = big)));
    const result = failure(() =>
      creditsForUsage(steep, [{ modelId: 'fixture-large', usage: usage(0, big) }]),
    );
    expect(result).toMatchObject({ code: 'RATE_USAGE_INVALID', path: 'calls' });
  });

  it('never puts a token count or model id in its message', () => {
    const result = failure(() =>
      creditsForUsage(table, [{ modelId: 'secret-model-x', usage: usage(1, 1) }]),
    );
    expect(result.message).not.toContain('secret-model-x');
    const counts = failure(() =>
      creditsForUsage(table, [{ modelId: 'fixture-mid', usage: usage(-987_654, 1) }]),
    );
    expect(counts.message).not.toContain('987');
  });
});

describe('estimateCredits', () => {
  const plan = (
    modelId: string,
    maxPromptTokens: number,
    maxOutputTokens: number,
  ): PlannedCall => ({
    modelId,
    maxPromptTokens,
    maxOutputTokens,
  });

  it('rounds up and charges at least one credit', () => {
    // 1 output token on the middle model is 0.0017 credits.
    expect(estimateCredits(table, [plan('fixture-mid', 0, 1)])).toBe(1);
    expect(estimateCredits(table, [plan('fixture-mid', 0, 0)])).toBe(1);
    // 20,000 x 666,667 (the dearest prompt rate) + 2,000 x 1,666,667 = 16.67, so 17.
    expect(estimateCredits(table, [plan('fixture-mid', 20_000, 2_000)])).toBe(17);
  });

  it('takes the second band once the largest prompt may pass 100,000 tokens', () => {
    const first = estimateCredits(table, [plan('fixture-small', 100_000, 0)]);
    const second = estimateCredits(table, [plan('fixture-small', 100_001, 0)]);
    // 100,000 x 33,334 is 3.33 credits, rounded up; 100,001 x 166,667 is 16.67, rounded up.
    expect(first).toBe(4);
    expect(second).toBe(17);
  });

  it('includes every planned call, such as the check', () => {
    // The check adds 60,000 x 33,334 + 4,000 x 83,334, 2.33 credits, to the 16.67 above:
    // 19.00005 in all, which rounds up to 20.
    const main = estimateCredits(table, [plan('fixture-mid', 20_000, 2_000)]);
    const both = estimateCredits(table, [
      plan('fixture-mid', 20_000, 2_000),
      plan('fixture-small', 60_000, 4_000),
    ]);
    expect(main).toBe(17);
    expect(both).toBe(20);
  });

  it('refuses an unknown model and bad counts by path', () => {
    expect(failure(() => estimateCredits(table, [plan('nope', 1, 1)]))).toMatchObject({
      code: 'RATE_MODEL_UNKNOWN',
      path: 'calls[0].modelId',
    });
    expect(failure(() => estimateCredits(table, [plan('fixture-mid', -1, 1)]))).toMatchObject({
      code: 'RATE_USAGE_INVALID',
      path: 'calls[0].maxPromptTokens',
    });
    expect(failure(() => estimateCredits(table, [plan('fixture-mid', 1, 1.5)]))).toMatchObject({
      code: 'RATE_USAGE_INVALID',
      path: 'calls[0].maxOutputTokens',
    });
    expect(failure(() => estimateCredits(table, [null] as never))).toMatchObject({
      code: 'RATE_USAGE_INVALID',
      path: 'calls[0]',
    });
    expect(failure(() => estimateCredits(table, []))).toMatchObject({
      code: 'RATE_USAGE_INVALID',
      path: 'calls',
    });
  });
});

describe('estimateMonthlyRuns', () => {
  it('is undefined with no reference profile for the operation', () => {
    expect(estimateMonthlyRuns(table, credits(1_000), 'generation', 'fixture-mid')).toBeUndefined();
    const bare = parseRateTable(mutated((d) => (d['reference'] = [])));
    expect(estimateMonthlyRuns(bare, credits(1_000), 'stale_draft', 'fixture-mid')).toBeUndefined();
  });

  it('is the floor of monthly credits over the reference charge', () => {
    // The reference draft on the middle model costs 10 credits.
    expect(estimateMonthlyRuns(table, credits(0), 'stale_draft', 'fixture-mid')).toBe(0);
    expect(estimateMonthlyRuns(table, credits(9), 'stale_draft', 'fixture-mid')).toBe(0);
    expect(estimateMonthlyRuns(table, credits(10), 'stale_draft', 'fixture-mid')).toBe(1);
    expect(estimateMonthlyRuns(table, credits(1_999), 'stale_draft', 'fixture-mid')).toBe(199);
    expect(
      estimateMonthlyRuns(table, credits(Number.MAX_SAFE_INTEGER), 'stale_draft', 'fixture-mid'),
    ).toBe(900_719_925_474_099);
  });

  it('runs the check calls on the check model whatever the main model is', () => {
    // Small main and small check: the 1 credit minimum.
    expect(estimateMonthlyRuns(table, credits(1_000), 'stale_draft', 'fixture-small')).toBe(1_000);
  });

  it('refuses an unknown model, operation or monthly amount', () => {
    expect(
      failure(() => estimateMonthlyRuns(table, credits(1), 'stale_draft', 'nope')),
    ).toMatchObject({ code: 'RATE_MODEL_UNKNOWN', path: 'modelId' });
    expect(
      failure(() => estimateMonthlyRuns(table, credits(1), 'sms' as AiOperation, 'fixture-mid')),
    ).toMatchObject({ code: 'RATE_USAGE_INVALID', path: 'operation' });
    expect(
      failure(() => estimateMonthlyRuns(table, -1 as never, 'stale_draft', 'fixture-mid')),
    ).toMatchObject({ code: 'CREDIT_AMOUNT_INVALID' });
  });
});

describe('RateTableError', () => {
  it('has a name, a code, a path and a fixed message per code', () => {
    const error = new RateTableError('RATE_MODEL_UNKNOWN', 'calls[0].modelId');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RateTableError');
    expect(error.code).toBe('RATE_MODEL_UNKNOWN');
    expect(error.path).toBe('calls[0].modelId');
    expect(new RateTableError('RATE_USAGE_INVALID', 'calls').message).toBe(
      'model call or token usage is invalid at calls',
    );
  });
});

// Model names and figures belong in the hosted rate file, never in the open core.
describe('source scan', () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = readdirSync(src).map((name) => join(src, name));

  // Parsed, not scanned, so the digits inside a regular expression are not read as numbers.
  function numbers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) out.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  it('names no model or model family anywhere in src', () => {
    const names = /claude|haiku|sonnet|opus|gpt|gemini|llama|mistral|anthropic|openai|deepseek/i;
    for (const file of files) {
      const match = names.exec(readFileSync(file, 'utf8'));
      expect(match?.[0], `${file} names '${match?.[0] ?? ''}'`).toBeUndefined();
    }
  });

  // The budget contract suite feeds fractional amounts on purpose, so it is left out.
  it('holds no fractional figure in src', () => {
    for (const file of files.filter((path) => !path.endsWith('testing.ts'))) {
      for (const text of numbers(file)) expect(text, file).not.toMatch(/[.eE]/);
    }
  });

  it('uses only structural numbers in the rate code', () => {
    // Bounds, the unit conversion and small loop constants; a rate would be none of these.
    const allowed = new Set(['0', '1', '16', '64', '256', '0n', '1n', '2n', '1_000_000_000n']);
    for (const text of numbers(join(src, 'rates.ts'))) {
      expect(allowed.has(text), `rates.ts holds ${text}`).toBe(true);
    }
  });
});
