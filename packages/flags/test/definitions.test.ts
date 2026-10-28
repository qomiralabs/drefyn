import { describe, expect, it } from 'vitest';
import {
  FLAG_AREAS,
  FLAG_KINDS,
  FlagError,
  defineFlags,
  type DefinitionProblem,
  type FlagDefinition,
} from '../src/index.ts';

const release = {
  name: 'status.sms',
  kind: 'release',
  owner: 'Divine572',
  description: 'SMS notifications for subscribers.',
  created: '2026-10-01',
  removeBy: '2027-03-01',
  safeValue: false,
} as const;

const killSwitch = {
  name: 'status.webhook_delivery',
  kind: 'kill_switch',
  owner: 'Divine572',
  description: 'On sends webhooks; off queues them without sending.',
  created: '2026-10-01',
  removeBy: '2027-10-01',
  safeValue: false,
} as const;

const plan = {
  name: 'docs.versioning',
  kind: 'plan',
  owner: 'Divine572',
  description: 'Versioned docs.',
  created: '2026-10-01',
  removeBy: '2027-10-01',
  feature: 'docs.versioning',
} as const;

const experiment = {
  name: 'site.hero_copy',
  kind: 'experiment',
  owner: 'Divine572',
  description: 'Second hero headline.',
  created: '2026-10-01',
  removeBy: '2027-01-01',
  safeValue: false,
  metric: 'Signups per visit over 14 days',
} as const;

// Runtime input that the types would refuse, as a bad import or a hand edited file could hold.
function define(...definitions: unknown[]): unknown {
  return defineFlags(definitions as unknown as readonly FlagDefinition[]);
}

function refusal(run: () => unknown): FlagError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FlagError);
    return error as FlagError;
  }
  throw new Error('expected defineFlags to refuse the definition');
}

function expectProblem(problem: DefinitionProblem, flag: string, ...definitions: unknown[]) {
  const error = refusal(() => define(...definitions));
  expect(error.code).toBe('FLAG_DEFINITION_INVALID');
  expect(error.problem).toBe(problem);
  expect(error.flag).toBe(flag);
}

describe('defineFlags accepts', () => {
  it('one valid definition of each kind and returns them in order', () => {
    const result = define(release, killSwitch, plan, experiment);
    expect(result).toEqual([release, killSwitch, plan, experiment]);
  });

  it('an empty registry', () => {
    expect(define()).toEqual([]);
  });

  it('every area in the area list', () => {
    const all = FLAG_AREAS.map((area) => ({ ...release, name: `${area}.feature_x` }));
    expect(define(...all)).toHaveLength(FLAG_AREAS.length);
  });

  it('names with digits and underscores after the first letter of the feature', () => {
    expect(() => define({ ...release, name: 'ai.gen_v2_beta' })).not.toThrow();
    expect(() => define({ ...release, name: 'ai.g' })).not.toThrow();
  });

  it('a kill switch whose safe value is true', () => {
    expect(() => define({ ...killSwitch, safeValue: true })).not.toThrow();
  });

  it('removeBy one day after created', () => {
    expect(() =>
      define({ ...release, created: '2026-12-31', removeBy: '2027-01-01' }),
    ).not.toThrow();
  });
});

describe('defineFlags returns a registry nobody can edit', () => {
  it('freezes the list and every definition, so a safe value cannot be flipped at run time', () => {
    const result = define(release, killSwitch) as FlagDefinition[];
    expect(Object.isFrozen(result)).toBe(true);
    for (const definition of result) expect(Object.isFrozen(definition)).toBe(true);
  });

  it('does not share objects with the caller, so editing the input later changes nothing', () => {
    const input = { ...killSwitch, safeValue: false };
    const [stored] = define(input) as FlagDefinition[];
    (input as { safeValue: boolean }).safeValue = true;
    expect(stored).toMatchObject({ safeValue: false });
  });
});

describe('defineFlags refuses a bad name', () => {
  it.each([
    'Product.docs',
    'product.Docs',
    'product',
    'product.',
    '.docs',
    'product..docs',
    'product.docs.extra',
    'product.1docs',
    'product._docs',
    'product.docs-x',
    'product.docs x',
    ' product.docs',
    'product.docs ',
    'product.docs\n',
    'product/docs',
    'product.dócs',
    '',
  ])('%j', (name) => {
    expectProblem('name_pattern', name, { ...release, name });
  });

  it('that is not a string', () => {
    for (const name of [
      undefined,
      null,
      42,
      ['product.docs'],
      { toString: () => 'product.docs' },
    ]) {
      const error = refusal(() => define({ ...release, name }));
      expect(error.code).toBe('FLAG_DEFINITION_INVALID');
      expect(error.problem).toBe('name_pattern');
    }
  });
});

describe('defineFlags refuses an unknown area', () => {
  it.each(['website.docs', 'products.docs', 'billings.plans', 'x.y', 'constructor.x', 'proto.x'])(
    '%j',
    (name) => {
      expectProblem('unknown_area', name, { ...release, name });
    },
  );
});

describe('defineFlags refuses a missing owner', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 7],
  ])('%s', (_label, owner) => {
    const definition: Record<string, unknown> = { ...release, owner };
    if (owner === undefined) delete definition['owner'];
    expectProblem('owner_missing', release.name, definition);
  });
});

describe('defineFlags refuses a missing or early removeBy', () => {
  for (const base of [release, experiment]) {
    it(`on a ${base.kind} flag when removeBy is missing`, () => {
      const definition: Record<string, unknown> = { ...base };
      delete definition['removeBy'];
      expectProblem('remove_by_missing', base.name, definition);
    });

    it(`on a ${base.kind} flag when removeBy equals created`, () => {
      expectProblem('remove_by_not_after_created', base.name, {
        ...base,
        created: '2026-10-01',
        removeBy: '2026-10-01',
      });
    });

    it(`on a ${base.kind} flag when removeBy is before created`, () => {
      expectProblem('remove_by_not_after_created', base.name, {
        ...base,
        created: '2026-10-01',
        removeBy: '2026-09-30',
      });
    });

    it(`on a ${base.kind} flag when removeBy is not zero padded, where a text compare would mislead`, () => {
      // '2026-9-30' sorts after '2026-10-01' as text; dates must be compared as dates.
      expectProblem('date_invalid', base.name, { ...base, removeBy: '2026-9-30' });
    });
  }

  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-1-01',
    '26-10-01',
    '2026/10/01',
    '2026-10-01T00:00:00Z',
    'tomorrow',
    '',
  ])('when removeBy is not a real calendar date: %j', (removeBy) => {
    expectProblem('date_invalid', release.name, { ...release, removeBy });
  });

  it.each(['2026-02-29', '2026-10-1', 'not a date'])(
    'when created is not a real calendar date: %j',
    (created) => {
      expectProblem('date_invalid', release.name, { ...release, created });
    },
  );

  it('accepts a leap day in a leap year', () => {
    expect(() =>
      define({ ...release, created: '2028-02-29', removeBy: '2028-03-01' }),
    ).not.toThrow();
  });
});

describe('defineFlags refuses an experiment without a metric', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', ' \t '],
    ['not a string', true],
  ])('%s', (_label, metric) => {
    const definition: Record<string, unknown> = { ...experiment, metric };
    if (metric === undefined) delete definition['metric'];
    expectProblem('metric_missing', experiment.name, definition);
  });
});

describe('defineFlags refuses duplicates', () => {
  it('two definitions with the same name, naming the duplicate', () => {
    expectProblem('duplicate_name', release.name, release, killSwitch, { ...release });
  });

  it('the same name under two kinds', () => {
    expectProblem('duplicate_name', 'status.sms', release, { ...killSwitch, name: 'status.sms' });
  });
});

describe('defineFlags refuses a fail open safe value', () => {
  it('a release flag with safeValue true', () => {
    expectProblem('safe_value_invalid', release.name, { ...release, safeValue: true });
  });

  it('a release flag with no safeValue', () => {
    const definition: Record<string, unknown> = { ...release };
    delete definition['safeValue'];
    expectProblem('safe_value_invalid', release.name, definition);
  });

  it('an experiment with safeValue true', () => {
    expectProblem('safe_value_invalid', experiment.name, { ...experiment, safeValue: true });
  });

  it.each([undefined, 'false', 0, 1, null])('a kill switch with safeValue %j', (safeValue) => {
    const definition: Record<string, unknown> = { ...killSwitch, safeValue };
    if (safeValue === undefined) delete definition['safeValue'];
    expectProblem('safe_value_invalid', killSwitch.name, definition);
  });
});

describe('defineFlags refuses other shapes', () => {
  it.each(['permanent', 'Release', '', undefined])('an unknown kind %j', (kind) => {
    expectProblem('unknown_kind', release.name, { ...release, kind });
  });

  it('knows exactly four kinds', () => {
    expect([...FLAG_KINDS].sort()).toEqual(['experiment', 'kill_switch', 'plan', 'release']);
  });

  it('a plan flag whose feature is not an entitlements feature', () => {
    expectProblem('feature_unknown', plan.name, { ...plan, feature: 'docs.teleport' });
    expectProblem('feature_unknown', plan.name, { ...plan, feature: 'org.seats' });
  });

  it('a definition that is not an object', () => {
    for (const value of [null, 'product.docs', 1]) {
      const error = refusal(() => define(value));
      expect(error.code).toBe('FLAG_DEFINITION_INVALID');
    }
  });

  it('reports the first broken definition, not a later valid one', () => {
    expectProblem('owner_missing', 'status.sms', { ...release, owner: '' }, killSwitch);
  });
});

describe('the area list', () => {
  it('is frozen and matches the accepted list', () => {
    expect(Object.isFrozen(FLAG_AREAS)).toBe(true);
    expect([...FLAG_AREAS].sort()).toEqual(
      [
        'product',
        'content',
        'docs',
        'studio',
        'status',
        'site',
        'search',
        'retrieval',
        'ai',
        'auth',
        'email',
        'billing',
        'github',
        'dashboard',
      ].sort(),
    );
  });
});
