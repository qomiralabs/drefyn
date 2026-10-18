import { describe, expect, it } from 'vitest';
import { runMigrate, type Output } from '../src/run.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';

function capture(): Output & { text: () => string } {
  const chunks: string[] = [];
  return { write: (t: string) => void chunks.push(t), text: () => chunks.join('') };
}

describe('runMigrate without a database', () => {
  it('exits 1 with the usage line for unknown arguments', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runMigrate({ argv: ['migrate', 'sideways'], env: {}, stdout, stderr });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('drefyn migrate up | down [n] | status');
  });

  it('exits 1 with DB_CONFIG_INVALID when the migration URL is missing', async () => {
    const stderr = capture();
    const code = await runMigrate({
      argv: ['migrate', 'up'],
      env: { DREFYN_DATABASE_URL: `postgres://drefyn_app:${PASSWORD}@127.0.0.1:1/drefyn` },
      stdout: capture(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('DB_CONFIG_INVALID');
    expect(stderr.text()).toContain('DREFYN_MIGRATION_DATABASE_URL');
    expect(stderr.text()).not.toContain(PASSWORD);
  });

  it('exits 1 with DB_CONFIG_INVALID for a malformed URL and never prints it', async () => {
    const url = `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:1`;
    const stdout = capture();
    const stderr = capture();
    const code = await runMigrate({
      argv: ['migrate', 'status'],
      env: { DREFYN_MIGRATION_DATABASE_URL: url },
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('DB_CONFIG_INVALID');
    expect(stdout.text() + stderr.text()).not.toContain(PASSWORD);
    expect(stdout.text() + stderr.text()).not.toContain(url);
  });

  it('refuses a broken migrations folder before it connects', async () => {
    const stderr = capture();
    // Port 1 refuses connections; a parse error must win over a connection error.
    const code = await runMigrate({
      argv: ['migrate', 'up', '--migrations-dir', '/nonexistent/drefyn-db-migrations'],
      env: {
        DREFYN_MIGRATION_DATABASE_URL: `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:1/drefyn`,
        DREFYN_DATABASE_SSL: 'disable',
      },
      stdout: capture(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('/nonexistent/drefyn-db-migrations');
    expect(stderr.text()).not.toMatch(/ECONNREFUSED/);
  });

  it('exits 1 without the password when the server is unreachable', async () => {
    const stderr = capture();
    const stdout = capture();
    const code = await runMigrate({
      argv: ['migrate', 'status'],
      env: {
        DREFYN_MIGRATION_DATABASE_URL: `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:1/drefyn`,
        DREFYN_DATABASE_SSL: 'disable',
      },
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stdout.text() + stderr.text()).not.toContain(PASSWORD);
  });
});
