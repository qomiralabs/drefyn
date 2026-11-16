// A rate table for tests only. The ids are made up and the live table is hosted config that
// can differ. The rates are shaped like a real table (a small model with a second band for
// long prompts, a middle default model, a premium large one) so the worked examples and the
// band edge exercise every rule.
export const FIXTURE_TABLE = {
  version: 'fixture.1',
  models: [
    {
      modelId: 'fixture-small',
      premium: false,
      bands: [
        {
          upToPromptTokens: 100_000,
          input: 16_667,
          cacheWrite5m: 20_834,
          cacheWrite1h: 33_334,
          cacheRead: 1_667,
          output: 83_334,
        },
        {
          upToPromptTokens: null,
          input: 83_334,
          cacheWrite5m: 104_167,
          cacheWrite1h: 166_667,
          cacheRead: 8_334,
          output: 416_667,
        },
      ],
    },
    {
      modelId: 'fixture-mid',
      premium: false,
      bands: [
        {
          upToPromptTokens: null,
          input: 333_334,
          cacheWrite5m: 416_667,
          cacheWrite1h: 666_667,
          cacheRead: 16_667,
          output: 1_666_667,
        },
      ],
    },
    {
      modelId: 'fixture-large',
      premium: true,
      bands: [
        {
          upToPromptTokens: null,
          input: 666_667,
          cacheWrite5m: 833_334,
          cacheWrite1h: 1_333_334,
          cacheRead: 33_334,
          output: 3_333_334,
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
