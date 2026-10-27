import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrate, type Output } from '../src/run.ts';
import { migrationText, migrationsDir } from './support.ts';

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

// Port 1 refuses connections, so a run that got as far as connecting says so. A stray file
// must be refused before that, and never executed: the script below leaves a marker if run.
describe('runMigrate refuses stray files in the migrations folder', () => {
  it.each(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json', '.sql.js', '.SQL', '.txt'])(
    'refuses a %s file before connecting and never runs it',
    async (ext) => {
      const markerDir = migrationsDir({});
      const marker = join(markerDir, `ran${ext}`);
      const stray = `1760000000002_stray${ext}`;
      const dir = migrationsDir({
        '1760000000001_a.sql': migrationText('select 1;', 'select 1;'),
        [stray]: `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nexport const up = () => undefined;\n`,
      });
      const stdout = capture();
      const stderr = capture();
      const code = await runMigrate({
        argv: ['migrate', 'up', '--migrations-dir', dir],
        env: {
          DREFYN_MIGRATION_DATABASE_URL: `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:1/drefyn`,
          DREFYN_DATABASE_SSL: 'disable',
        },
        stdout,
        stderr,
      });
      expect(code).toBe(1);
      expect(stderr.text()).toContain(stray);
      expect(stdout.text() + stderr.text()).not.toMatch(/ECONNREFUSED/);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('warns about a .DS_Store on stderr and otherwise runs as if it were not there', async () => {
    const valid = { '1760000000001_a.sql': migrationText('select 1;', 'select 1;') };
    const run = async (dir: string) => {
      const stdout = capture();
      const stderr = capture();
      const code = await runMigrate({
        argv: ['migrate', 'status', '--migrations-dir', dir],
        env: {
          DREFYN_MIGRATION_DATABASE_URL: `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:1/drefyn`,
          DREFYN_DATABASE_SSL: 'disable',
        },
        stdout,
        stderr,
      });
      // The folder path differs between the two runs and is not what is compared.
      return { code, stdout: stdout.text(), stderr: stderr.text().replaceAll(dir, '<dir>') };
    };
    const without = await run(migrationsDir(valid));
    const withStore = await run(
      migrationsDir({ ...valid, '.DS_Store': new Uint8Array([0x00, 0x00, 0x00, 0x01, 0xff]) }),
    );
    expect(withStore.stderr).toContain('.DS_Store');
    expect(withStore.stdout).not.toContain('.DS_Store');
    // Same refused connection, so the folder was accepted.
    expect(withStore.code).toBe(without.code);
    const rest = withStore.stderr
      .split('\n')
      .filter((line) => !line.includes('.DS_Store'))
      .join('\n');
    expect(rest).toBe(without.stderr);
  });
});
