import { TypedInMemoryProvider } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';
import { FlagError, flags, type FlagDefinition, type FlagEnv } from '../src/index.ts';
import {
  createTestFlagClient,
  releaseFlagsFromEnv,
  type InMemoryFlagConfiguration,
} from '../src/testing.ts';
import {
  EXPERIMENT,
  KILL_SAFE_OFF,
  KILL_SAFE_ON,
  PLAN,
  RELEASE,
  ctx,
  fixtureFlags,
} from './support/fixtures.ts';

// Reads a value through OpenFeature's own in memory provider, so the test does not depend
// on how the configuration object is laid out.
async function valueOf(config: InMemoryFlagConfiguration, name: string): Promise<unknown> {
  const provider = new TypedInMemoryProvider(config);
  const result = await provider.resolveBooleanEvaluation(name, false, {});
  return result.value;
}

const releaseNames = (registry: readonly FlagDefinition[]) =>
  registry.filter((flag) => flag.kind === 'release').map((flag) => flag.name);

describe('releaseFlagsFromEnv', () => {
  it('with on turns every release flag in the package registry on', async () => {
    const config = releaseFlagsFromEnv({ DREFYN_RELEASE_FLAGS: 'on' });
    expect(releaseNames(flags).length).toBeGreaterThanOrEqual(3);
    for (const name of releaseNames(flags)) expect(await valueOf(config, name), name).toBe(true);
  });

  it('with off turns every release flag off', async () => {
    const config = releaseFlagsFromEnv({ DREFYN_RELEASE_FLAGS: 'off' });
    for (const name of releaseNames(flags)) expect(await valueOf(config, name), name).toBe(false);
  });

  it('unset gives the production defaults, which keep release flags off', async () => {
    const config = releaseFlagsFromEnv({});
    for (const name of releaseNames(flags)) expect(await valueOf(config, name), name).toBe(false);
  });

  it('treats an empty value as unset', () => {
    expect(releaseFlagsFromEnv({ DREFYN_RELEASE_FLAGS: '' })).toEqual(releaseFlagsFromEnv({}));
  });

  it('defaults to process.env', () => {
    expect(releaseFlagsFromEnv()).toEqual(releaseFlagsFromEnv(process.env));
  });

  it.each(['ON', 'On', 'true', '1', 'yes', ' on', 'off ', 'enabled'])(
    'refuses %j instead of quietly running the default',
    (value) => {
      let caught: unknown;
      try {
        releaseFlagsFromEnv({ DREFYN_RELEASE_FLAGS: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FlagError);
      expect(caught).toMatchObject({ code: 'FLAG_CONFIG_INVALID', key: 'DREFYN_RELEASE_FLAGS' });
    },
  );

  describe('with a registry holding every kind', () => {
    const modes: FlagEnv[] = [{ DREFYN_RELEASE_FLAGS: 'on' }, { DREFYN_RELEASE_FLAGS: 'off' }, {}];

    it('only release flags follow the variable', async () => {
      const values = await Promise.all(
        modes.map(async (env) => {
          const config = releaseFlagsFromEnv(env, fixtureFlags);
          return {
            release: await valueOf(config, RELEASE),
            killOn: await valueOf(config, KILL_SAFE_ON),
            killOff: await valueOf(config, KILL_SAFE_OFF),
            experiment: await valueOf(config, EXPERIMENT),
          };
        }),
      );
      expect(values.map((v) => v.release)).toEqual([true, false, false]);
      // Kill switches and experiments are the same in all three modes.
      for (const key of ['killOn', 'killOff', 'experiment'] as const) {
        expect(new Set(values.map((v) => v[key])).size, key).toBe(1);
      }
      expect(values[0]?.experiment).toBe(false);
    });

    it('leaves plan flags out, since they never reach a provider', () => {
      for (const env of modes) {
        expect(Object.keys(releaseFlagsFromEnv(env, fixtureFlags))).not.toContain(PLAN);
      }
    });

    it('lists every non plan flag', () => {
      for (const env of modes) {
        expect(Object.keys(releaseFlagsFromEnv(env, fixtureFlags)).sort()).toEqual(
          [RELEASE, KILL_SAFE_ON, KILL_SAFE_OFF, EXPERIMENT].sort(),
        );
      }
    });
  });
});

// Runs under both CI jobs, `tests (release flags on)` and `tests (release flags off)`,
// and asserts what each one should see.
describe(`this run, DREFYN_RELEASE_FLAGS=${process.env['DREFYN_RELEASE_FLAGS'] ?? '(unset)'}`, () => {
  const mode = process.env['DREFYN_RELEASE_FLAGS'];
  const expected = mode === 'on';

  it('the test client follows the variable for every release flag', async () => {
    const client = createTestFlagClient();
    for (const name of releaseNames(flags)) {
      expect(await client.isOn(name as (typeof flags)[number]['name'], ctx), name).toBe(expected);
    }
    await client.close();
  });

  it('the in memory configuration follows the variable', async () => {
    const config = releaseFlagsFromEnv();
    for (const name of releaseNames(flags))
      expect(await valueOf(config, name), name).toBe(expected);
  });
});

describe('createTestFlagClient', () => {
  it('serves release flags from the given environment', async () => {
    const on = createTestFlagClient(undefined, { env: { DREFYN_RELEASE_FLAGS: 'on' } });
    const off = createTestFlagClient(undefined, { env: { DREFYN_RELEASE_FLAGS: 'off' } });
    expect(await on.isOn('product.docs', ctx)).toBe(true);
    expect(await off.isOn('product.docs', ctx)).toBe(false);
    await on.close();
    await off.close();
  });

  it('applies overrides on top, with source test_override', async () => {
    const client = createTestFlagClient(
      { 'product.docs': true, 'product.studio': false },
      { env: { DREFYN_RELEASE_FLAGS: 'on' } },
    );
    expect(await client.evaluate('product.docs', ctx)).toEqual({
      value: true,
      source: 'test_override',
    });
    expect(await client.evaluate('product.studio', ctx)).toEqual({
      value: false,
      source: 'test_override',
    });
    expect((await client.evaluate('product.status', ctx)).value).toBe(true);
    await client.close();
  });

  it('can override any kind in a given registry, plan flags included', async () => {
    const client = createTestFlagClient(
      { [PLAN]: true, [KILL_SAFE_ON]: false },
      { env: {}, registry: fixtureFlags },
    );
    expect(await client.evaluate(PLAN, ctx)).toEqual({ value: true, source: 'test_override' });
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({
      value: false,
      source: 'test_override',
    });
    await client.close();
  });

  it('refuses an override for a flag that does not exist, naming it', () => {
    let caught: unknown;
    try {
      createTestFlagClient({ 'product.website': true } as unknown as { 'product.docs': boolean });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlagError);
    expect(caught).toMatchObject({ code: 'FLAG_DEFINITION_INVALID', flag: 'product.website' });
  });

  it('keeps two test clients apart', async () => {
    const a = createTestFlagClient({ 'product.docs': true }, { env: {} });
    const b = createTestFlagClient({ 'product.docs': false }, { env: {} });
    expect(await a.isOn('product.docs', ctx)).toBe(true);
    expect(await b.isOn('product.docs', ctx)).toBe(false);
    await a.close();
    expect(await b.isOn('product.docs', ctx)).toBe(false);
    await b.close();
  });
});
