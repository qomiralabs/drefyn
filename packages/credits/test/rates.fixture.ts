// A rate table for tests only. The ids and the round rates are made up and match no real
// model or price; live rates are hosted config. The shape is a real one (a small model with
// a second band for long prompts, a middle default model, a premium large one) so the worked
// examples and the band edge exercise every rule.
export const FIXTURE_TABLE = {
  version: 'fixture.1',
  models: [
    {
      modelId: 'fixture-small',
      premium: false,
      bands: [
        {
          upToPromptTokens: 100_000,
          input: 20_000,
          cacheWrite5m: 25_000,
          cacheWrite1h: 40_000,
          cacheRead: 2_000,
          output: 100_000,
        },
        {
          upToPromptTokens: null,
          input: 100_000,
          cacheWrite5m: 125_000,
          cacheWrite1h: 200_000,
          cacheRead: 10_000,
          output: 500_000,
        },
      ],
    },
    {
      modelId: 'fixture-mid',
      premium: false,
      bands: [
        {
          upToPromptTokens: null,
          input: 300_000,
          cacheWrite5m: 375_000,
          cacheWrite1h: 600_000,
          cacheRead: 30_000,
          output: 1_500_000,
        },
      ],
    },
    {
      modelId: 'fixture-large',
      premium: true,
      bands: [
        {
          upToPromptTokens: null,
          input: 700_000,
          cacheWrite5m: 875_000,
          cacheWrite1h: 1_400_000,
          cacheRead: 70_000,
          output: 3_500_000,
        },
      ],
    },
  ],
  defaults: {
    stale_draft: 'fixture-mid',
    reader_answer: 'fixture-mid',
    translation_draft: 'fixture-mid',
    incident_draft: 'fixture-mid',
    generation: 'fixture-mid',
  },
  checkModel: 'fixture-small',
  reference: [
    {
      operation: 'stale_draft',
      calls: [
        {
          role: 'main',
          usage: { input: 20_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 2_000 },
        },
        {
          role: 'check',
          usage: { input: 6_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 400 },
        },
      ],
    },
    {
      operation: 'reader_answer',
      calls: [
        {
          role: 'main',
          usage: { input: 6_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 },
        },
      ],
    },
  ],
} as const;

export function usage(input: number, output: number) {
  return { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output };
}

// A fresh mutable copy, for tests that break one field at a time.
export function fixtureCopy(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(FIXTURE_TABLE)) as Record<string, unknown>;
}
