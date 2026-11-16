import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS } from '../src/index.ts';
import { fixture, makeEslint, repoRoot, reports } from './helpers.ts';

const RULE = 'drefyn/published-reads-only';
const root = fixture('published');
const eslint = makeEslint(root, { [RULE]: 'error' });

const lintFile = async (path: string) =>
  reports(
    await eslint.lintText(readFileSync(join(root, path), 'utf8'), {
      filePath: join(root, path),
    }),
  ).filter((r) => r.ruleId === RULE);

async function lint(code: string) {
  const results = await eslint.lintText(code, {
    filePath: join(root, 'apps/docs-site/src/probe.ts'),
  });
  return reports(results).filter((r) => r.ruleId === RULE);
}

describe('published-reads-only', () => {
  it('fails the fixture that imports draft reads, once per name', async () => {
    const found = await lintFile('apps/docs-site/src/draft-read.ts');
    expect(found.map((r) => r.line)).toEqual([1, 1, 2, 3]);
    expect(found[0]?.message).toContain("'createDatabase' from '@drefyn/db'");
    expect(found[1]?.message).toContain("'withTenant'");
    expect(found[2]?.message).toContain("'createEngine' from '@drefyn/engine'");
    expect(found[3]?.message).toContain("'pg' can reach drafts");
  });

  it('passes the fixture that holds only the published reader', async () => {
    expect(await lintFile('apps/docs-site/src/published-read.ts')).toEqual([]);
  });

  it.each([
    ["import { withOrganization } from '@drefyn/db';", 'withOrganization'],
    ["import { withUser as user } from '@drefyn/db';", 'withUser'],
    ["import { databaseStore } from '@drefyn/engine';", 'databaseStore'],
    ["import { storeTypes } from '@drefyn/engine';", 'storeTypes'],
    ["import { Kysely } from 'kysely';", 'Kysely'],
    ["import { type PublishedReader, createEngine } from '@drefyn/engine';", 'createEngine'],
    ["export { withTenant } from '@drefyn/db';", 'withTenant'],
    ["import { 'withTenant' as t } from '@drefyn/db';", 'withTenant'],
    ["import { default as db } from '@drefyn/db';", 'default'],
  ])('refuses %s', async (code, name) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`'${name}'`);
  });

  it.each([
    "import * as db from '@drefyn/db';",
    "import db from '@drefyn/db';",
    "import '@drefyn/db';",
    "import { withPublishedReader } from '@drefyn/db/src/database.ts';",
    "export * from '@drefyn/engine';",
    "const db = await import('@drefyn/db');",
    'const db = await import(`@drefyn/db`);',
    "const pg = require('pg');",
    "import pg = require('pg');",
    "import { Pool } from 'pg';",
    "import postgres from 'postgres';",
    "import { Pool } from 'pg-pool';",
  ])('refuses the whole module in %s', async (code) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('can reach drafts');
  });

  it.each([
    "import { createPublishedDatabase, closeDatabase, DbError } from '@drefyn/db';",
    "import { createPublishedReader, publishedStore } from '@drefyn/engine';",
    "import type { Database, TenantSchema } from '@drefyn/db';",
    "import { type Engine } from '@drefyn/engine';",
    "export type { Engine } from '@drefyn/engine';",
    "export type * from '@drefyn/db';",
    "import type pg = require('pg');",
    "import { sql } from 'kysely';",
    "import { idOf } from '@drefyn/tenancy';",
    "import { withTenant } from './local.ts';",
    'const x = await import(name);',
    'export const a = 1; export { a as b };',
  ])('allows %s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  describe('in the configs', () => {
    const on = async (linter: ESLint, path: string) => {
      const config = (await linter.calculateConfigForFile(join(repoRoot, path))) as {
        rules?: Record<string, unknown>;
      };
      return config.rules?.[RULE];
    };
    const guard = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'scripts/lint-rules/guard.config.js'),
    });

    it('names the public paths', () => {
      expect(PUBLIC_PATHS).toEqual([
        'apps/docs-site/**',
        'apps/status-page/**',
        'apps/website/**',
        'apps/api/src/public/**',
      ]);
    });

    it.each([
      ['the root config', new ESLint({ cwd: repoRoot })],
      ['the guard', guard],
    ])('%s holds it for public paths and leaves the rest alone', async (_name, linter) => {
      expect(await on(linter, 'apps/docs-site/src/server.ts')).toEqual([2]);
      expect(await on(linter, 'apps/status-page/src/page.ts')).toEqual([2]);
      expect(await on(linter, 'apps/website/src/home.ts')).toEqual([2]);
      expect(await on(linter, 'apps/api/src/public/content.ts')).toEqual([2]);
      expect(await on(linter, 'apps/api/src/server.ts')).toBeUndefined();
      expect(await on(linter, 'apps/dashboard/src/server/auth.ts')).toBeUndefined();
      expect(await on(linter, 'packages/engine/src/engine.ts')).toBeUndefined();
    });

    it('holds every real docs site file to it, and each one passes', async () => {
      const linter = new ESLint({ cwd: repoRoot });
      const files = readdirSync(join(repoRoot, 'apps/docs-site/src'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `apps/docs-site/src/${name}`);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(await on(linter, file), file).toEqual([2]);
        const found = reports(await linter.lintFiles([join(repoRoot, file)])).filter(
          (r) => r.ruleId === RULE,
        );
        expect(found, file).toEqual([]);
      }
    });
  });
});
