import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refuseOutsideTests, SEED_MARKER } from '../e2e/seed-guard.ts';

const TEST_STACK = 'drefyn-dash-3-41785774373-1';
const allowed = { [SEED_MARKER]: 'real-stack-e2e', COMPOSE_PROJECT_NAME: TEST_STACK };

describe('the seed refusal', () => {
  it('passes with the marker and a test stack name', () => {
    expect(() => {
      refuseOutsideTests(allowed);
    }).not.toThrow();
  });

  it.each([
    ['no marker', { COMPOSE_PROJECT_NAME: TEST_STACK }],
    ['a marker of another value', { ...allowed, [SEED_MARKER]: '1' }],
    ['no stack name', { [SEED_MARKER]: 'real-stack-e2e' }],
    ['the default stack', { ...allowed, COMPOSE_PROJECT_NAME: 'drefyn' }],
    ['a look alike stack', { ...allowed, COMPOSE_PROJECT_NAME: `prod-${TEST_STACK}` }],
    ['a stack with a tail', { ...allowed, COMPOSE_PROJECT_NAME: `${TEST_STACK}-prod` }],
    ['a production node env', { ...allowed, NODE_ENV: 'production' }],
    ['nothing', {}],
  ])('refuses %s', (_name, env: Record<string, string>) => {
    expect(() => {
      refuseOutsideTests(env);
    }).toThrow('seed:e2e');
  });

  it('stops the script before it reads a file or opens a connection', () => {
    const script = fileURLToPath(new URL('../e2e/seed.ts', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env['PATH'] } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('seed:e2e refuses');
    expect(result.stderr).not.toContain('deploy/.env');
  }, 60_000);
});
