import { describe, expect, it } from 'vitest';
import { stackRule } from './integration/support/presence.ts';
import { prepareRun, type RunSteps } from './integration/support/run-setup.ts';

const templates = { base: 'b', migrated: 'm', migratedError: null };

function steps(fail?: 'lock' | 'sweep' | 'build' | 'drop') {
  const calls: string[] = [];
  const step = (name: 'lock' | 'sweep' | 'build' | 'drop') => {
    calls.push(name);
    if (fail === name) throw new Error(`${name} failed`);
  };
  const run: RunSteps = {
    takeLock: () => {
      step('lock');
      return Promise.resolve({
        release: () => {
          calls.push('release');
          return Promise.resolve();
        },
      });
    },
    sweep: () => {
      step('sweep');
      return Promise.resolve(['drefyn_test_old']);
    },
    buildTemplates: () => {
      step('build');
      return Promise.resolve(templates);
    },
    dropTemplates: () => {
      step('drop');
      return Promise.resolve();
    },
  };
  return { run, calls };
}

// Integration files share the stack, so the harness rules are proved here without it.
describe('integration run setup', () => {
  it('locks, then sweeps, then builds, and holds the lock until teardown', async () => {
    const { run, calls } = steps();
    const prepared = await prepareRun(run);
    expect(prepared.swept).toEqual(['drefyn_test_old']);
    expect(prepared.templates).toBe(templates);
    expect(calls).toEqual(['lock', 'sweep', 'build']);
    await prepared.teardown();
    expect(calls).toEqual(['lock', 'sweep', 'build', 'drop', 'release']);
  });

  it('never sweeps when the lock is held elsewhere', async () => {
    const { run, calls } = steps('lock');
    await expect(prepareRun(run)).rejects.toThrow('lock failed');
    expect(calls).toEqual(['lock']);
  });

  it.each(['sweep', 'build'] as const)('releases the lock when %s fails', async (step) => {
    const { run, calls } = steps(step);
    await expect(prepareRun(run)).rejects.toThrow(`${step} failed`);
    expect(calls.at(-1)).toBe('release');
  });

  it('releases the lock even when dropping templates fails', async () => {
    const { run, calls } = steps('drop');
    const prepared = await prepareRun(run);
    await expect(prepared.teardown()).rejects.toThrow('drop failed');
    expect(calls.at(-1)).toBe('release');
  });
});

describe('the stack rule for integration tests', () => {
  it('runs whenever the stack is there', () => {
    expect(stackRule(null, {})).toBe('run');
    expect(stackRule(null, { CI: 'true' })).toBe('run');
  });

  it('skips with a reason on a laptop without the stack', () => {
    expect(stackRule('COMPOSE_PROJECT_NAME is not set', {})).toBe('skip');
    expect(stackRule('no postgres', { CI: 'false' })).toBe('skip');
    expect(stackRule('no postgres', { CI: '0' })).toBe('skip');
  });

  it('fails in CI rather than skip', () => {
    expect(stackRule('no postgres', { CI: 'true' })).toBe('fail');
    expect(stackRule('no postgres', { CI: '1' })).toBe('fail');
  });
});
