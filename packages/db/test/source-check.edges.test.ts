import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extensionDdlProblems,
  repoSourceProblems,
  runCheckSources,
  sessionSettingProblems,
} from '../src/source-check.ts';

// Assembled at run time: the repository scan reads this file too.
const SET = 'set';
const SET_CONFIG = ['set', 'config'].join('_');

const migration = (up: string) => `-- Up Migration\n${up}\n\n-- Down Migration\nselect 1;\n`;
const bad = (up: string) => extensionDdlProblems('f.sql', migration(up)).length > 0;

describe('the extension DDL check reads SQL the way Postgres does', () => {
  it.each([
    ['a nested block comment', 'create /* a /* nested */ b */ extension pg_trgm;'],
    ['an unterminated do body', "do $$ begin execute 'create extension pg_trgm'"],
    [
      'a tagged body with a dollar inside',
      "do $x$ begin execute 'drop extension vector'; end $x$;",
    ],
    ['a second name in a drop list', 'drop function app.f(int), extensions.g();'],
    [
      'a grant on an object in extensions',
      'grant execute on function extensions.f() to drefyn_app;',
    ],
    ['a comment on an object in extensions', "comment on table extensions.t is 'x';"],
    ['an index on a table in extensions', 'create index on extensions.t (id);'],
    ['a policy on a table in extensions', 'create policy p on extensions.t using (true);'],
    ['drop schema if exists', 'drop schema if exists extensions;'],
    ['plpgsql DDL without execute', 'do $$ begin create extension pg_trgm; end $$;'],
  ])('fails on %s', (_label, sql) => {
    expect(bad(sql)).toBe(true);
  });

  it.each([
    ['text in an escape string', "select E'it\\'s create extension pg_trgm';"],
    ['text in a lower case escape string', "select e'drop extension vector';"],
    ['a doubled quote in a string', "select 'it''s; create extension pg_trgm';"],
    ['a doubled quote in a quoted name', 'create table app."odd""name" (id int);'],
    ['a trailing line comment with no newline', 'select 1; -- create extension pg_trgm'],
    ['an unterminated string', "select 'create extension pg_trgm"],
    ['an unterminated block comment', 'select 1; /* create extension pg_trgm'],
    ['a positional parameter', 'select $1;'],
    ['a drop list of app tables', 'drop table app.a, app.b cascade;'],
    ['a grant with no object', 'grant drefyn_app to drefyn_owner;'],
    ['a create with no name', 'create table ('],
    ['an unbalanced drop', 'drop function app.f(int, (x'],
    ['an index on an app table', 'create unique index t_idx on app.t (organization_id, slug);'],
    ['a column named on typed extensions.vector', 'create table app.t (on extensions.vector(3));'],
  ])('passes %s', (_label, sql) => {
    expect(extensionDdlProblems('f.sql', migration(sql))).toEqual([]);
  });

  it('trims a long statement to one line of at most 200 characters', () => {
    const [problem] = extensionDdlProblems(
      'f.sql',
      migration(`create extension pg_trgm\n  ${'-- x\n'.repeat(3)}schema ${'a'.repeat(300)};`),
    );
    expect(problem?.statement.length).toBe(200);
    expect(problem?.statement.endsWith('...')).toBe(true);
    expect(problem?.statement).not.toContain('\n');
  });
});

describe('the session setting check', () => {
  it('reads past escaped quotes inside a call', () => {
    // A double quoted argument holding an escaped quote, as in a TypeScript string.
    const text = `${SET_CONFIG}('drefyn.x', "a\\"b", false)`;
    expect(sessionSettingProblems('a.ts', text)).toHaveLength(1);
  });

  it('accepts a cast to boolean on the flag', () => {
    expect(
      sessionSettingProblems('a.sql', `select ${SET_CONFIG}('drefyn.x', $1, 'off'::boolean)`),
    ).toHaveLength(1);
  });

  it('ignores a call cut off before its third argument', () => {
    expect(
      sessionSettingProblems('a.sql', `select ${SET_CONFIG}('drefyn.organization_id', $1`),
    ).toEqual([]);
  });

  it('finds a session SET at the very end of a file', () => {
    const [problem] = sessionSettingProblems('a.sql', `${SET} drefyn.organization_id = 1`);
    expect(problem?.statement).toBe(`${SET} drefyn.organization_id = 1`);
  });

  it('reports problems in line order', () => {
    const text = [
      `${SET} drefyn.organization_id = 1;`,
      `select ${SET_CONFIG}('drefyn.project_id', $1, false);`,
      `${SET} session drefyn.project_id = 2;`,
    ].join('\n');
    expect(sessionSettingProblems('a.sql', text).map((p) => p.line)).toEqual([1, 2, 3]);
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the repository scan', () => {
  it('skips tracked files that are gone, binary, too large or not files', () => {
    const root = mkdtempSync(join(tmpdir(), 'drefyn-db-scan-'));
    temps.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root,
        stdio: 'pipe',
      });
    git('init', '-q');
    const leak = `${SET} drefyn.organization_id = 1;\n`;
    writeFileSync(join(root, 'gone.sql'), leak);
    writeFileSync(join(root, 'binary.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(leak)]));
    writeFileSync(join(root, 'huge.sql'), `${leak}${'-- padding\n'.repeat(900_000)}`);
    mkdirSync(join(root, 'dir'));
    symlinkSync('dir', join(root, 'link'));
    writeFileSync(join(root, 'kept.sql'), leak);
    git('add', '-A');
    rmSync(join(root, 'gone.sql'));
    expect(repoSourceProblems(root).map((p) => p.file)).toEqual(['kept.sql']);
  });
});

describe('check:sources arguments', () => {
  it.each([
    [['--nope'], /unknown argument --nope/],
    [['--root'], /--root needs a value/],
    [['--root', ''], /--root needs a value/],
    [['--root', '.', '--root', '.'], /--root given twice/],
  ])('refuses %j with exit 1', (argv, reason) => {
    let err = '';
    const code = runCheckSources({
      argv,
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string) => {
          err += chunk;
          return true;
        },
      },
    });
    expect(code).toBe(1);
    expect(err).toMatch(reason);
  });
});
