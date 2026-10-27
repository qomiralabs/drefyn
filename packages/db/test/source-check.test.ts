import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMigrationsDir } from '../src/constants.ts';
import {
  extensionDdlProblems,
  migrationDirProblems,
  repoSourceProblems,
  runCheckSources,
  sessionSettingProblems,
} from '../src/source-check.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

function files(dir: string): [string, string][] {
  return readdirSync(dir)
    .sort()
    .map((name) => [name, readFileSync(join(dir, name), 'utf8')]);
}

const extensionBad = files(join(fixtures, 'extension-ddl', 'bad'));
const extensionGood = files(join(fixtures, 'extension-ddl', 'good'));
const settingsBad = files(join(fixtures, 'session-settings', 'bad'));
const settingsGood = files(join(fixtures, 'session-settings', 'good'));

// The statement each bad extension fixture must be reported for, as the check prints it.
const EXPECTED_STATEMENT: Record<string, RegExp> = {
  'create_extension.sql': /create extension pg_trgm/i,
  'alter_extension_update.sql': /alter extension vector update/i,
  'drop_extension.sql': /drop extension vector/i,
  'comment_on_extension.sql': /comment on extension vector/i,
  'alter_schema_owner.sql': /alter schema extensions owner to/i,
  'grant_create_on_schema.sql': /grant create on schema extensions/i,
  'create_function_in_extensions.sql': /create function extensions\.f\(\)/i,
  'create_table_in_extensions.sql': /create table extensions\.t/i,
  'set_schema_extensions.sql': /alter function app\.f\(\) set schema extensions/i,
  'do_block_execute.sql': /create extension pg_trgm/i,
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-db-sources-'));
  temps.push(dir);
  return dir;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function gitRepo(tracked: Record<string, string>): string {
  const root = tempDir();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  for (const [path, text] of Object.entries(tracked)) write(root, path, text);
  git('add', '-A');
  return root;
}

function output() {
  let text = '';
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe('extension DDL check', () => {
  it('has every fixture the criteria name', () => {
    const names = extensionBad.map(([name]) => name);
    for (const name of Object.keys(EXPECTED_STATEMENT)) expect(names).toContain(name);
  });

  it.each(extensionBad)('fails on %s, naming the file and statement', (name, sql) => {
    const problems = extensionDdlProblems(name, sql);
    expect(problems.length, name).toBeGreaterThan(0);
    for (const problem of problems) expect(problem.file).toBe(name);
    const expected = EXPECTED_STATEMENT[name];
    if (expected !== undefined) {
      expect(problems.map((p) => p.statement).join('\n')).toMatch(expected);
    }
  });

  it('gives the line the statement starts on', () => {
    const [problem] = extensionDdlProblems(
      'x.sql',
      '-- Up Migration\nselect 1;\n\ncreate extension pg_trgm;\n\n-- Down Migration\nselect 1;\n',
    );
    expect(problem?.line).toBe(4);
  });

  it('reports each bad statement in a file', () => {
    const problems = extensionDdlProblems(
      'x.sql',
      '-- Up Migration\ncreate extension a;\ncreate table app.ok (id int);\ndrop extension b;\n\n-- Down Migration\nselect 1;\n',
    );
    expect(problems.map((p) => p.line)).toEqual([2, 4]);
  });

  it.each(extensionGood)('passes %s', (name, sql) => {
    expect(extensionDdlProblems(name, sql)).toEqual([]);
  });

  it('passes the shipped migrations', () => {
    expect(migrationDirProblems(defaultMigrationsDir)).toEqual([]);
  });

  it('fails a folder once per bad file, by file name', () => {
    const problems = migrationDirProblems(join(fixtures, 'extension-ddl', 'bad'));
    expect(new Set(problems.map((p) => p.file))).toEqual(
      new Set(extensionBad.map(([name]) => name)),
    );
  });

  it('passes a folder of good files', () => {
    expect(migrationDirProblems(join(fixtures, 'extension-ddl', 'good'))).toEqual([]);
  });
});

describe('session setting check', () => {
  it.each(settingsBad)('fails on %s', (name, text) => {
    const problems = sessionSettingProblems(name, text);
    expect(problems.length, name).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.file).toBe(name);
      expect(problem.statement).toMatch(/set|set_config/i);
    }
  });

  it.each(settingsGood)('passes %s', (name, text) => {
    expect(sessionSettingProblems(name, text)).toEqual([]);
  });

  it('gives the line of the call', () => {
    const call = readFileSync(
      join(fixtures, 'session-settings', 'bad', 'leak_project.sql'),
      'utf8',
    );
    const [problem] = sessionSettingProblems('x.ts', `const a = 1;\n\n${call}`);
    expect(problem?.line).toBe(3);
  });

  it('passes the real repository', () => {
    expect(repoSourceProblems(repoRoot)).toEqual([]);
  });

  it('scans every tracked text file, whatever its folder', () => {
    const bad = readFileSync(
      join(fixtures, 'session-settings', 'bad', 'set_organization.sql'),
      'utf8',
    );
    const root = gitRepo({
      'apps/api/src/handler.ts.txt': bad,
      'docs/guide.md': bad,
      'packages/other/test/fixtures/session-settings/x.sql': bad,
      'packages/db/README.md': '# ok\n',
    });
    const reported = repoSourceProblems(root)
      .map((p) => p.file)
      .sort();
    expect(reported).toEqual(
      [
        'apps/api/src/handler.ts.txt',
        'docs/guide.md',
        'packages/other/test/fixtures/session-settings/x.sql',
      ].sort(),
    );
  });

  it('skips only the reviewed fixture folder of this check', () => {
    const bad = readFileSync(join(fixtures, 'session-settings', 'bad', 'set_session.sql'), 'utf8');
    const root = gitRepo({
      'packages/db/test/fixtures/session-settings/bad/x.sql': bad,
      'packages/db/test/fixtures/x.sql': bad,
    });
    expect(repoSourceProblems(root).map((p) => p.file)).toEqual([
      'packages/db/test/fixtures/x.sql',
    ]);
  });
});

describe('check:sources', () => {
  it('exits 0 on the real repository and shipped migrations', () => {
    const out = output();
    const err = output();
    const code = runCheckSources({ argv: [], stdout: out.stream, stderr: err.stream });
    expect(code, err.text()).toBe(0);
  });

  it('exits 1 naming the file and statement for a bad migration folder', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, '9000000000001_bad.sql'),
      '-- Up Migration\ncreate extension pg_trgm;\n\n-- Down Migration\nselect 1;\n',
    );
    const err = output();
    const code = runCheckSources({
      argv: ['--migrations-dir', dir],
      stdout: output().stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('9000000000001_bad.sql');
    expect(err.text()).toMatch(/create extension pg_trgm/i);
  });

  it('exits 1 naming the file for a session setting in a repository', () => {
    const bad = readFileSync(
      join(fixtures, 'session-settings', 'bad', 'set_organization.sql'),
      'utf8',
    );
    const root = gitRepo({ 'src/a.sql': bad });
    const err = output();
    const code = runCheckSources({
      argv: ['--root', root],
      stdout: output().stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('src/a.sql');
  });
});
