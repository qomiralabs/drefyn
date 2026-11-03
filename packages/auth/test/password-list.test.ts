import fc from 'fast-check';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAuthCli } from '../src/auth-cli.ts';
import {
  BREACHED_RECORD_BYTES,
  PasswordListError,
  buildPasswordList,
  openBreachedPasswordFile,
} from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let dir: string;
let serial = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drefyn-password-list-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha1 = (text: string) => createHash('sha1').update(text, 'utf8').digest('hex').toUpperCase();

function paths() {
  serial += 1;
  const n = String(serial);
  return { from: join(dir, `in-${n}.txt`), out: join(dir, `out-${n}.bin`) };
}

async function input(text: string) {
  const p = paths();
  await writeFile(p.from, text);
  return p;
}

const recordsOf = (bytes: Buffer) =>
  Array.from({ length: bytes.length / BREACHED_RECORD_BYTES }, (_, i) =>
    bytes.subarray(i * BREACHED_RECORD_BYTES, (i + 1) * BREACHED_RECORD_BYTES).toString('hex'),
  );

// What the output must be, worked out the slow and obvious way.
function expected(lines: readonly (readonly [string, number])[], minCount: number): string[] {
  const kept = new Set(
    lines.filter(([, count]) => count >= minCount).map(([hash]) => hash.toLowerCase()),
  );
  return [...kept].sort();
}

function sink() {
  let text = '';
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => !/^(in|out)-[0-9]+\.(txt|bin)$/.test(name));
}

describe('buildPasswordList', () => {
  it('writes sorted, fixed width records and drops entries under the minimum count', async () => {
    const lines: [string, number][] = [
      [sha1('zebra'), 40],
      [sha1('apple'), 3],
      [sha1('mango'), 2],
      [sha1('kiwi'), 10],
    ];
    const p = await input(lines.map(([h, c]) => `${h}:${String(c)}\n`).join(''));
    const summary = await buildPasswordList({ ...p, minCount: 3 });
    const bytes = await readFile(p.out);
    expect(bytes.length % BREACHED_RECORD_BYTES).toBe(0);
    expect(recordsOf(bytes)).toEqual(expected(lines, 3));
    expect(summary).toEqual({ lines: 4, kept: 3, belowMinCount: 1, duplicates: 0 });
  });

  it('reads CRLF line ends, a byte order mark, lower case hex and no final newline', async () => {
    const p = await input(`﻿${sha1('one')}:5\r\n${sha1('two').toLowerCase()}:5`);
    const summary = await buildPasswordList({ ...p, minCount: 1 });
    expect(recordsOf(await readFile(p.out))).toEqual(
      [sha1('one'), sha1('two')].map((h) => h.toLowerCase()).sort(),
    );
    expect(summary.kept).toBe(2);
  });

  it('keeps one record for a hash listed twice, and a count past any safe integer', async () => {
    const p = await input(
      `${sha1('a')}:2\n${sha1('a')}:9\n${sha1('b')}:123456789012345678901234567890\n`,
    );
    const summary = await buildPasswordList({ ...p, minCount: 2 });
    expect(recordsOf(await readFile(p.out))).toEqual(
      expected(
        [
          [sha1('a'), 2],
          [sha1('b'), 3],
        ],
        2,
      ),
    );
    expect(summary).toMatchObject({ kept: 2, duplicates: 1 });
  });

  it('an input with nothing at or above the minimum gives an empty list', async () => {
    const p = await input(`${sha1('a')}:1\n`);
    await buildPasswordList({ ...p, minCount: 2 });
    expect((await readFile(p.out)).length).toBe(0);
  });

  it.each([
    ['a short hash', `${sha1('a').slice(1)}:4`],
    ['an NTLM hash', `${'A'.repeat(32)}:4`],
    ['a missing count', sha1('a')],
    ['an empty count', `${sha1('a')}:`],
    ['a negative count', `${sha1('a')}:-4`],
    ['a non hex character', `${sha1('a').slice(1)}G:4`],
    ['a blank line', ''],
    ['spaces around the line', ` ${sha1('a')}:4`],
    ['a password in clear', 'hunter2'],
  ])('refuses %s and names its line, writing nothing', async (_name, bad) => {
    const p = await input(`${sha1('first')}:4\n${sha1('second')}:4\n${bad}\n${sha1('last')}:4\n`);
    const error = await buildPasswordList({ ...p, minCount: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasswordListError);
    expect(error).toMatchObject({ line: 3 });
    expect(String((error as Error).message)).toMatch(/^line 3: /);
    // The line itself may be a password someone pasted by mistake.
    expect(String((error as Error).message)).not.toContain('hunter2');
    await expect(readFile(p.out)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it('sorts input in any order with runs on disk, the same as sorting in memory', async () => {
    const hash = fc
      .uint8Array({ minLength: 20, maxLength: 20 })
      .map((b) => Buffer.from(b).toString('hex'));
    // Few distinct hashes, so duplicates across runs are common.
    const pool = fc.array(hash, { minLength: 1, maxLength: 12 });
    await fc.assert(
      fc.asyncProperty(
        pool.chain((hashes) =>
          fc.tuple(
            fc.array(fc.tuple(fc.constantFrom(...hashes), fc.integer({ min: 0, max: 9 })), {
              maxLength: 60,
            }),
            fc.integer({ min: 1, max: 9 }),
            fc.integer({ min: 1, max: 8 }),
            fc.boolean(),
          ),
        ),
        async ([lines, minCount, runRecords, upper]) => {
          const text = lines
            .map(([h, c]) => `${upper ? h.toUpperCase() : h}:${String(c)}\n`)
            .join('');
          const p = await input(text);
          const summary = await buildPasswordList({ ...p, minCount, runRecords });
          const want = expected(lines, minCount);
          expect(recordsOf(await readFile(p.out))).toEqual(want);
          expect(summary.kept).toBe(want.length);
          expect(summary.lines).toBe(lines.length);
          expect(summary.kept + summary.belowMinCount + summary.duplicates).toBe(lines.length);
        },
      ),
      { numRuns: 120 },
    );
    expect(await leftovers()).toEqual([]);
  });

  it('replaces an earlier list in one step, and the result opens as a list', async () => {
    const p = await input(`${sha1('new one')}:9\n`);
    await writeFile(p.out, Buffer.alloc(BREACHED_RECORD_BYTES * 3));
    await buildPasswordList({ ...p, minCount: 1 });
    const file = await openBreachedPasswordFile(p.out);
    try {
      expect(file.records).toBe(1);
      await expect(file.isBreached('new one', new AbortController().signal)).resolves.toBe(true);
    } finally {
      await file.close();
    }
  });

  it('refuses to write over its own input, a minimum under 1 and a missing input', async () => {
    const p = await input(`${sha1('a')}:9\n`);
    await expect(buildPasswordList({ from: p.from, out: p.from, minCount: 1 })).rejects.toThrow(
      PasswordListError,
    );
    await expect(buildPasswordList({ ...p, minCount: 0 })).rejects.toThrow(PasswordListError);
    await expect(
      buildPasswordList({ from: join(dir, 'missing.txt'), out: p.out, minCount: 1 }),
    ).rejects.toThrow();
    expect(await readFile(p.from, 'utf8')).toBe(`${sha1('a')}:9\n`);
    expect(await leftovers()).toEqual([]);
  });
});

describe('drefyn auth password-list build', () => {
  const run = async (argv: readonly string[]) => {
    const stdout = sink();
    const stderr = sink();
    const code = await runAuthCli({ argv, stdout, stderr });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };

  it('builds the list and reports what it kept and dropped', async () => {
    const p = await input(`${sha1('b')}:5\n${sha1('a')}:1\n${sha1('c')}:7\n`);
    const result = await run([
      'auth',
      'password-list',
      'build',
      '--from',
      p.from,
      '--out',
      p.out,
      '--min-count',
      '2',
    ]);
    expect(result).toEqual({
      code: 0,
      stdout: `password-list: read 3 lines, kept 2 records, dropped 1 under --min-count 2 and 0 duplicates\nwrote ${p.out}\n`,
      stderr: '',
    });
    expect(recordsOf(await readFile(p.out))).toEqual(
      expected(
        [
          [sha1('b'), 5],
          [sha1('c'), 7],
        ],
        2,
      ),
    );
  });

  it('a malformed line exits 1 naming the line', async () => {
    const p = await input(`${sha1('a')}:5\nnot a hash line\n`);
    const result = await run([
      'auth',
      'password-list',
      'build',
      '--from',
      p.from,
      '--out',
      p.out,
      '--min-count',
      '1',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^password-list: line 2: /);
    expect(result.stderr).not.toContain('not a hash line');
  });

  it('a missing input exits 1 without a stack', async () => {
    const p = paths();
    const result = await run([
      'auth',
      'password-list',
      'build',
      '--from',
      p.from,
      '--out',
      p.out,
      '--min-count',
      '1',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^password-list: cannot read --from: ENOENT\n$/);
  });

  it.each([
    [[]],
    [['auth']],
    [['auth', 'password-list']],
    [['auth', 'password-list', 'check']],
    [['migrate', 'up']],
    [['auth', 'password-list', 'build', '--out', '/x', '--min-count', '1']],
    [['auth', 'password-list', 'build', '--from', '/a', '--min-count', '1']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '0']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '01']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '1e3']],
    [['auth', 'password-list', 'build', '--from', '/a', '--from', '/c', '--out', '/b']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '2', 'x']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--force']],
  ])('refuses %j with the usage line and exit 64', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(64);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'usage: drefyn auth password-list build --from <file> --out <file> --min-count <n>',
    );
  });

  it('runs as a program with node', async () => {
    const p = await input(`${sha1('a')}:5\n`);
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(root, 'src/cli.ts'),
      'auth',
      'password-list',
      'build',
      '--from',
      p.from,
      '--out',
      p.out,
      '--min-count',
      '1',
    ]);
    expect(stdout).toContain('kept 1 records');
    expect(recordsOf(await readFile(p.out))).toEqual([sha1('a').toLowerCase()]);
  });
});
