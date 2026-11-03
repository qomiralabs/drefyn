import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as db from '../src/index.ts';

const root = join(import.meta.dirname, '..');

interface Manifest {
  name: string;
  bin?: Record<string, string>;
  exports: Record<string, string>;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

describe('package shape', () => {
  it('is @drefyn/db with the context bound entry and the migrate command entry', () => {
    expect(manifest.name).toBe('@drefyn/db');
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './command': './src/command.ts',
      './package.json': './package.json',
    });
  });

  // @drefyn/cli owns the drefyn binary; db hands it the migrate command as a function.
  it('declares no binary and exports exactly the migrate command', async () => {
    expect(manifest.bin).toBeUndefined();
    expect(existsSync(join(root, 'src', 'cli.ts'))).toBe(false);
    const command = await import('../src/command.ts');
    expect(Object.keys(command).sort()).toEqual(['MIGRATE_USAGE', 'runMigrate']);
    expect(command.MIGRATE_USAGE).toBe(
      'usage: drefyn migrate up | down [n] | status [--migrations-dir <dir>]',
    );
  });

  it('has the integration and type drift tasks', () => {
    expect(manifest.scripts['test:integration']).toBeDefined();
    expect(manifest.scripts['check:types']).toBeDefined();
  });

  // Exact pins, each with a licence on the allow list and a reason in the Decisions log.
  it('pins the database dependencies exactly', () => {
    expect(manifest.dependencies).toMatchObject({
      pg: '8.23.1',
      'node-pg-migrate': '9.0.0',
      kysely: '0.29.7',
      '@drefyn/tenancy': 'workspace:*',
    });
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (name.startsWith('@drefyn/')) expect(version, name).toBe('workspace:*');
      else expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // Every way in needs a tenant, a user, the published reader or the auth pool: nothing here hands out a pool, a
  // client, a Kysely instance or a transaction without context.
  it('exports only context bound access, the config parsers and the helpers', () => {
    expect(Object.keys(db).sort()).toEqual(
      [
        'API_KEY_EXPIRY_RULES',
        'AUTH_EXPIRY_RULES',
        'DbError',
        'closeDatabase',
        'createExpiryCleanup',
        'deleteExpired',
        'reserveApiKeyFailureWindows',
        'reserveAuthRateWindows',
        'withApiKeyLimiter',
        'createAuthDatabase',
        'createDatabase',
        'createPublishedDatabase',
        'newId',
        'parseAuthDatabaseConfig',
        'parseDatabaseConfig',
        'parseMigrationConfig',
        'parsePublishedReaderConfig',
        'toSafeInteger',
        'withAuth',
        'withOrganization',
        'withPublishedReader',
        'withTenant',
        'withUser',
      ].sort(),
    );
  });

  it('runs the catalog and source checks as package tasks', () => {
    expect(manifest.scripts['check:catalog']).toBe('node src/check-catalog.ts');
    expect(manifest.scripts['check:sources']).toBe('node src/check-sources.ts');
  });

  it('runs the catalog check in e2e.yml against the migrated database', () => {
    const workflow = readFileSync(
      join(root, '..', '..', '.github', 'workflows', 'e2e.yml'),
      'utf8',
    );
    expect(workflow).toMatch(/pnpm --filter @drefyn\/db check:catalog/);
  });

  it('documents every exit code in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).not.toContain('One or two sentences on what this package does');
    for (const line of [
      /\b0\b.*done/i,
      /\b1\b.*(other|anything else)/i,
      /\b2\b.*lock/i,
      /\b3\b.*checksum/i,
      /\b4\b.*prerequisite/i,
    ]) {
      expect(readme).toMatch(line);
    }
    expect(readme).toContain('DREFYN_MIGRATION_DATABASE_URL');
  });

  it('keeps every src file TypeScript', () => {
    for (const file of readdirSync(join(root, 'src'))) expect(file).toMatch(/\.ts$/);
  });
});

// A conflict on a guessed id would tell a caller the id exists in another tenant, which is
// why ids are exempt from the organization_id rule on unique keys.
describe('README rules for callers', () => {
  it('says no insert path accepts a client chosen id', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/no insert (path )?accepts a client chosen `?id`?/i);
  });
});
