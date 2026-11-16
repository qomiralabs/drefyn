import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATIONS,
  RateTableError,
  creditsForUsage,
  estimateCredits,
  parseRateTable,
  type ModelCall,
  type PlannedCall,
  type RateTable,
  type TokenUsage,
} from '../src/index.ts';
import { FIXTURE_TABLE } from './rates.fixture.ts';
import { PROPERTY_TIMEOUT_MS, runs } from './support.ts';

const CLASSES = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'] as const;
const PROMPT = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;
const PER_CREDIT = 1_000_000_000n;
const fixture = parseRateTable(FIXTURE_TABLE);

type Json = Record<string, unknown>;

const rateArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 5_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER) },
);

const modelIdArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,62}$/);

const bandsArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 10_000_000 }), { maxLength: 4 })
  .chain((bounds) => {
    const sorted = [...bounds].sort((a, b) => a - b);
    const limits: (number | null)[] = [...sorted, null];
    return fc.tuple(
      ...limits.map((upToPromptTokens) =>
        fc
          .record({
            input: rateArb,
            cacheWrite5m: rateArb,
            cacheWrite1h: rateArb,
            cacheRead: rateArb,
            output: rateArb,
          })
          .map((rates) => ({ upToPromptTokens, ...rates })),
      ),
    );
  });

const usageArb: fc.Arbitrary<TokenUsage> = fc.record({
  input: fc.nat({ max: 300_000 }),
  cacheWrite5m: fc.nat({ max: 50_000 }),
  cacheWrite1h: fc.nat({ max: 50_000 }),
  cacheRead: fc.nat({ max: 200_000 }),
  output: fc.nat({ max: 64_000 }),
});

// Valid tables with every key in the order the parser writes them, so serializing the
// input and the parsed table gives the same text.
const tableArb: fc.Arbitrary<Json> = fc
  .record({
    ids: fc.uniqueArray(modelIdArb, { minLength: 1, maxLength: 5 }),
    version: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  })
  .chain(({ ids, version }) =>
    fc
      .tuple(
        fc.tuple(...ids.map(() => fc.tuple(fc.boolean(), bandsArb))),
        fc.subarray([...AI_OPERATIONS]),
        fc.nat(),
        fc.array(fc.nat(), { minLength: AI_OPERATIONS.length, maxLength: AI_OPERATIONS.length }),
      )
      .chain(([shapes, profiled, checkPick, defaultPicks]) => {
        const models = ids.map((modelId, index) => {
          const [premium, bands] = shapes[index] ?? [false, []];
          // The first model is open to every plan so the defaults always have one to name.
          return { modelId, premium: index === 0 ? false : premium, bands };
        });
        const open = models.filter((model) => !model.premium).map((model) => model.modelId);
        const defaults = Object.fromEntries(
          AI_OPERATIONS.map((operation, index) => [
            operation,
            open[(defaultPicks[index] ?? 0) % open.length],
          ]),
        );
        const checkModel = ids[checkPick % ids.length];
        return fc
          .tuple(
            ...profiled.map((operation) =>
              fc
                .array(fc.record({ role: fc.constantFrom('main', 'check'), usage: usageArb }), {
                  minLength: 1,
                  maxLength: 3,
                })
                .map((calls) => ({ operation, calls })),
            ),
          )
          .map((reference) => ({ version, models, defaults, checkModel, reference }));
      }),
  );

describe('rate table properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('parses every valid table and round trips through JSON unchanged', () => {
    fc.assert(
      fc.property(tableArb, (input) => {
        const parsed = parseRateTable(input);
        expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
        expect(parseRateTable(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
        expect(parseRateTable(parsed)).toEqual(parsed);
      }),
      runs,
    );
  });

  // Each mutation breaks one field of a valid table with a value no rule accepts, and says
  // where the parser must report it.
  const marker = 'zq-9137-marker';
  const badCount = fc.constantFrom<unknown>(-7_913, 1.5, Number.NaN, 2 ** 60, marker, null, true);
  const badId = fc.constantFrom<unknown>(`${marker}-UPPER`, `-${marker}`, 4_242, null);

  interface Mutation {
    readonly path: string;
    readonly keys: readonly (string | number)[];
    readonly value: unknown;
  }

  // Sets one field by walking names and indexes from the root of a copy.
  function setAt(table: Json, keys: readonly (string | number)[], value: unknown): void {
    let node = table as Record<string | number, unknown>;
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = keys.at(-1);
    if (last === undefined) throw new Error('empty path');
    node[last] = value;
  }

  function mutationArb(input: Json): fc.Arbitrary<Mutation> {
    const models = input['models'] as Json[];
    const reference = input['reference'] as Json[];
    const options: fc.Arbitrary<Mutation>[] = [];
    options.push(
      fc.constantFrom<unknown>('', ` ${marker}`, 9_137, null).map((value) => ({
        path: 'version',
        keys: ['version'],
        value,
      })),
    );
    models.forEach((model, m) => {
      options.push(
        badId.map((value) => ({
          path: `models[${String(m)}].modelId`,
          keys: ['models', m, 'modelId'],
          value,
        })),
      );
      const bands = model['bands'] as Json[];
      bands.forEach((_band, b) => {
        options.push(
          fc.tuple(fc.constantFrom(...CLASSES), badCount).map(([name, value]) => ({
            path: `models[${String(m)}].bands[${String(b)}].${name}`,
            keys: ['models', m, 'bands', b, name],
            value,
          })),
        );
      });
    });
    options.push(
      fc
        .tuple(fc.constantFrom(...AI_OPERATIONS), fc.constantFrom<unknown>(marker, 9_137, null))
        .map(([operation, value]) => ({
          path: `defaults.${operation}`,
          keys: ['defaults', operation],
          value,
        })),
    );
    options.push(
      fc.constantFrom<unknown>(marker, 9_137, null).map((value) => ({
        path: 'checkModel',
        keys: ['checkModel'],
        value,
      })),
    );
    reference.forEach((profile, r) => {
      const calls = profile['calls'] as Json[];
      calls.forEach((_call, c) => {
        options.push(
          fc.tuple(fc.constantFrom(...CLASSES), badCount).map(([name, value]) => ({
            path: `reference[${String(r)}].calls[${String(c)}].usage.${name}`,
            keys: ['reference', r, 'calls', c, 'usage', name],
            value,
          })),
        );
      });
    });
    return fc.oneof(...options);
  }

  it('refuses every single field mutation with RATE_TABLE_INVALID, its path and no value', () => {
    fc.assert(
      fc.property(
        tableArb.chain((input) => fc.tuple(fc.constant(input), mutationArb(input))),
        ([input, mutation]) => {
          const broken = structuredClone(input);
          setAt(broken, mutation.keys, mutation.value);
          let caught: unknown;
          try {
            parseRateTable(broken);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(RateTableError);
          const error = caught as RateTableError;
          expect(error.code).toBe('RATE_TABLE_INVALID');
          expect(error.path).toBe(mutation.path);
          expect(error.message).toBe(`rate table is invalid at ${mutation.path}`);
          for (const leak of [marker, '7913', '9137', '4242', '1.5', 'NaN', 'null', '115292']) {
            expect(error.message).not.toContain(leak);
          }
        },
      ),
      runs,
    );
  });
});

// Usage generated against a plan: each call keeps its model, its prompt classes sum to at
// most the planned prompt, and its output stays under the planned cap.
const planArb = fc.array(
  fc.record({
    modelId: fc.constantFrom('fixture-small', 'fixture-mid', 'fixture-large'),
    maxPromptTokens: fc.nat({ max: 400_000 }),
    maxOutputTokens: fc.nat({ max: 64_000 }),
  }),
  { minLength: 1, maxLength: 4 },
);

function within(plan: PlannedCall): fc.Arbitrary<ModelCall> {
  return fc
    .tuple(
      fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
      fc.nat({ max: plan.maxPromptTokens }),
      fc.nat({ max: plan.maxOutputTokens }),
    )
    .map(([weights, prompt, output]) => {
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      const parts = weights.map((w) => Number((BigInt(prompt) * BigInt(w)) / BigInt(total)));
      return {
        modelId: plan.modelId,
        usage: {
          input: parts[0] ?? 0,
          cacheWrite5m: parts[1] ?? 0,
          cacheWrite1h: parts[2] ?? 0,
          cacheRead: parts[3] ?? 0,
          output,
        },
      };
    });
}

const callsArb: fc.Arbitrary<ModelCall[]> = fc.array(
  fc.record({
    modelId: fc.constantFrom('fixture-small', 'fixture-mid', 'fixture-large'),
    usage: usageArb,
  }),
  { minLength: 1, maxLength: 4 },
);

function exactSum(table: RateTable, calls: readonly ModelCall[]): bigint {
  let sum = 0n;
  for (const call of calls) {
    const model = table.models.find((m) => m.modelId === call.modelId);
    if (model === undefined) throw new Error('fixture model missing');
    const prompt = PROMPT.reduce((total, name) => total + call.usage[name], 0);
    const band =
      model.bands.find((b) => b.upToPromptTokens === null || prompt <= b.upToPromptTokens) ??
      model.bands[0];
    for (const name of CLASSES) sum += BigInt(call.usage[name]) * BigInt(band[name]);
  }
  return sum;
}

describe('credit math properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('charges at least one credit for any usage', () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        expect(creditsForUsage(fixture, calls)).toBeGreaterThanOrEqual(1);
      }),
      runs,
    );
  });

  it('is monotone: one more token of any class never lowers the charge', () => {
    fc.assert(
      fc.property(
        callsArb,
        fc.nat(),
        fc.constantFrom(...CLASSES),
        fc.integer({ min: 1, max: 50_000 }),
        (calls, pick, name, extra) => {
          const index = pick % calls.length;
          const more = calls.map((call, i) =>
            i === index
              ? { ...call, usage: { ...call.usage, [name]: call.usage[name] + extra } }
              : call,
          );
          expect(creditsForUsage(fixture, more)).toBeGreaterThanOrEqual(
            creditsForUsage(fixture, calls),
          );
        },
      ),
      runs,
    );
  });

  it('never charges more than the estimate when usage stays within the plan', () => {
    fc.assert(
      fc.property(
        planArb.chain((plan) => fc.tuple(fc.constant(plan), fc.tuple(...plan.map(within)))),
        ([plan, calls]) => {
          expect(creditsForUsage(fixture, calls)).toBeLessThanOrEqual(
            estimateCredits(fixture, plan),
          );
        },
      ),
      runs,
    );
  });

  it('never charges more than the estimate on any valid table either', () => {
    fc.assert(
      fc.property(
        tableArb.chain((input) => {
          const table = parseRateTable(input);
          const ids = table.models.map((m) => m.modelId);
          const plans = fc.array(
            fc.record({
              modelId: fc.constantFrom(...ids),
              maxPromptTokens: fc.nat({ max: 20_000_000 }),
              maxOutputTokens: fc.nat({ max: 200_000 }),
            }),
            { minLength: 1, maxLength: 3 },
          );
          return plans.chain((plan) =>
            fc.tuple(fc.constant(table), fc.constant(plan), fc.tuple(...plan.map(within))),
          );
        }),
        ([table, plan, calls]) => {
          let estimate: number;
          try {
            estimate = estimateCredits(table, plan);
          } catch (error) {
            // A rate near the safe limit can push the estimate past the range; that is refused.
            expect((error as RateTableError).code).toBe('RATE_USAGE_INVALID');
            return;
          }
          expect(creditsForUsage(table, calls)).toBeLessThanOrEqual(estimate);
        },
      ),
      runs,
    );
  });

  // A table is built so each rate is the provider rate divided by 0.6, rounded up, so the
  // provider bills at most 0.6 times the exact amount at that rate. The charge must cover it.
  it('never charges below the provider cost the fixture rates imply', () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        const charge = BigInt(creditsForUsage(fixture, calls));
        const sum = exactSum(fixture, calls);
        // charge >= 0.6 * sum / PER_CREDIT, kept in integers.
        expect(charge * PER_CREDIT * 10n >= sum * 6n).toBe(true);
      }),
      runs,
    );
  });
});
