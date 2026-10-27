import { describe, expect, it } from 'vitest';
import { parseMigrateArgs } from '../src/args.ts';
import { MigrateError } from '../src/outcome.ts';
import { thrown } from './support.ts';

describe('parseMigrateArgs', () => {
  it('reads up', () => {
    expect(parseMigrateArgs(['migrate', 'up'])).toEqual({
      command: 'up',
      migrationsDir: undefined,
    });
  });

  it('reads down with one step by default', () => {
    expect(parseMigrateArgs(['migrate', 'down'])).toEqual({
      command: 'down',
      count: 1,
      migrationsDir: undefined,
    });
  });

  it('reads down with a count', () => {
    expect(parseMigrateArgs(['migrate', 'down', '3'])).toEqual({
      command: 'down',
      count: 3,
      migrationsDir: undefined,
    });
  });

  it('reads status', () => {
    expect(parseMigrateArgs(['migrate', 'status'])).toEqual({
      command: 'status',
      migrationsDir: undefined,
    });
  });

  it('reads a migrations folder on any command', () => {
    expect(parseMigrateArgs(['migrate', 'up', '--migrations-dir', '/tmp/m'])).toEqual({
      command: 'up',
      migrationsDir: '/tmp/m',
    });
    expect(parseMigrateArgs(['migrate', 'down', '2', '--migrations-dir', '/tmp/m'])).toEqual({
      command: 'down',
      count: 2,
      migrationsDir: '/tmp/m',
    });
  });

  it.each([
    [[]],
    [['migrate']],
    [['up']],
    [['migrate', 'sideways']],
    [['migrate', 'UP']],
    [['migrate', 'up', '2']],
    [['migrate', 'status', 'now']],
    [['migrate', 'down', '0']],
    [['migrate', 'down', '-1']],
    [['migrate', 'down', '1.5']],
    [['migrate', 'down', 'all']],
    [['migrate', 'down', '01']],
    [['migrate', 'down', '1e2']],
    [['migrate', 'down', '9007199254740993']],
    [['migrate', 'down', '1', '2']],
    [['migrate', 'up', '--migrations-dir']],
    [['migrate', 'up', '--migrations-dir', '']],
    [['migrate', 'up', '--force']],
    [['migrate', 'up', '--migrations-dir', '/a', '--migrations-dir', '/b']],
  ])('refuses %j with the usage line', (argv) => {
    const error = thrown(() => parseMigrateArgs(argv));
    expect(error).toBeInstanceOf(MigrateError);
    expect((error as MigrateError).outcome).toBe('failed');
    expect((error as MigrateError).message).toContain('drefyn migrate up | down [n] | status');
  });
});
