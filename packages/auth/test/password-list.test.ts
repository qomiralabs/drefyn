import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_COMMAND_USAGE, runAuthCommand } from '../src/command.ts';
import {
  BREACHED_RECORD_BYTES,
  PasswordListError,
  buildPasswordList,
  openBreachedPasswordFile,
} from '../src/index.ts';

let dir: string;
let serial = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drefyn-password-list-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha1 = (text: string) => createHash('sha1').update(text, 'utf8').digest('hex').toUpperCase();

// Hashes in ascending order, the order the downloader writes.
const ascending = (...texts: string[]) => texts.map(sha1).sort();

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

const lines = (entries: readonly (readonly [string, number])[]) =>
  entries.map(([h, c]) => `${h}:${String(c)}\n`).join('');

const recordsOf = (bytes: Buffer) =>
  Array.from({ length: bytes.length / BREACHED_RECORD_BYTES }, (_, i) =>
    bytes
      .subarray(i * BREACHED_RECORD_BYTES, (i + 1) * BREACHED_RECORD_BYTES)
      .toString('hex')
      .toUpperCase(),
  );

// Anything in the folder that is not a test's own input or output: a temp file left over.
async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => !/^(in|out)-[0-9]+\.(txt|bin)$/.test(name));
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

const run = async (argv: readonly string[]) => {
  const stdout = sink();
  const stderr = sink();
  const code = await runAuthCommand({ argv, env: {}, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

const build = (p: { from: string; out: string }, minCount = '1') =>
  run([
    'auth',
    'password-list',
    'build',
    '--from',
    p.from,
    '--min-count',
    minCount,
    '--out',
    p.out,
  ]);

describe('buildPasswordList', () => {
  it('writes fixed width records in order and drops entries under the minimum count', async () => {
    const [a, b, c, d] = ascending('zebra', 'apple', 'mango', 'kiwi') as [
      string,
      string,
      string,
      string,
    ];
    const p = await input(
      lines([
        [a, 40],
        [b, 3],
        [c, 2],
        [d, 10],
      ]),
    );
    const summary = await buildPasswordList({ ...p, minCount: 3 });
    const bytes = await readFile(p.out);
    expect(bytes.length).toBe(3 * BREACHED_RECORD_BYTES);
    expect(recordsOf(bytes)).toEqual([a, b, d]);
    expect(summary).toEqual({ lines: 4, records: 3, belowMinCount: 1 });
  });

  it('reads CRLF line ends, either case of hex, a final empty line and no final newline', async () => {
    const [a, b] = ascending('one', 'two') as [string, string];
    for (const text of [`${a}:5\r\n${b.toLowerCase()}:5`, `${a}:5\n${b}:5\n\n`]) {
      const p = await input(text);
      const summary = await buildPasswordList({ ...p, minCount: 1 });
      expect(recordsOf(await readFile(p.out))).toEqual([a, b]);
      expect(summary.records).toBe(2);
    }
  });

  it('a count past any safe integer still counts', async () => {
    const p = await input(`${sha1('a')}:123456789012345678901234567890\n`);
    await expect(buildPasswordList({ ...p, minCount: 9_007_199_254_740_991 })).resolves.toEqual({
      lines: 1,
      records: 1,
      belowMinCount: 0,
    });
  });

  it.each([
    ['a short hash', (h: string) => `${h.slice(1)}:4`],
    ['an NTLM hash', () => `${'A'.repeat(32)}:4`],
    ['a missing count', (h: string) => h],
    ['an empty count', (h: string) => `${h}:`],
    ['a negative count', (h: string) => `${h}:-4`],
    ['a non hex character', (h: string) => `${h.slice(1)}G:4`],
    ['an empty line before the end', () => ''],
    ['spaces around the line', (h: string) => ` ${h}:4`],
    ['a password in clear', () => 'hunter2'],
    ['a repeated hash', (_h: string, previous: string) => `${previous}:4`],
    ['a hash out of order', () => `${'0'.repeat(40)}:4`],
  ])('refuses %s with its line number and never echoes the line', async (_name, bad) => {
    const [first, second, third, last] = ascending('w', 'x', 'y', 'z') as [
      string,
      string,
      string,
      string,
    ];
    // The bad line sits where `third` would go, after `second`.
    const p = await input(`${first}:4\n${second}:4\n${bad(third, second)}\n${last}:4\n`);
    const error = await buildPasswordList({ ...p, minCount: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasswordListError);
    expect(error).toMatchObject({ line: 3, kind: 'input' });
    const message = (error as Error).message;
    expect(message).toMatch(/^line 3: /);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(second.slice(0, 10));
    await expect(stat(p.out)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it('names the problem: shape, or order', async () => {
    const [a, b] = ascending('a', 'b') as [string, string];
    const shape = await input(`${'A'.repeat(32)}:4\n`);
    await expect(buildPasswordList({ ...shape, minCount: 1 })).rejects.toThrow(
      'line 1: expected a 40 character SHA-1 and a count',
    );
    const order = await input(`${b}:4\n${a}:4\n`);
    await expect(buildPasswordList({ ...order, minCount: 1 })).rejects.toThrow(
      'line 2: hashes must be in strictly ascending order; sort the input with LC_ALL=C sort',
    );
  });

  it('checks the order of dropped lines too', async () => {
    const [a, b] = ascending('a', 'b') as [string, string];
    const p = await input(`${b}:1\n${a}:9\n`);
    await expect(buildPasswordList({ ...p, minCount: 5 })).rejects.toMatchObject({ line: 2 });
  });

  it('matches a filter over the same lines, for any ascending input', async () => {
    const hash = fc
      .uint8Array({ minLength: 20, maxLength: 20 })
      .map((b) => Buffer.from(b).toString('hex').toUpperCase());
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(hash, fc.integer({ min: 0, max: 9 })), {
          selector: ([h]) => h,
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 9 }),
        fc.boolean(),
        async (entries, minCount, lower) => {
          const sorted = [...entries].sort(([x], [y]) => (x < y ? -1 : 1));
          const want = sorted.filter(([, c]) => c >= minCount).map(([h]) => h);
          const p = await input(
            lines(sorted.map(([h, c]) => [lower ? h.toLowerCase() : h, c] as const)),
          );
          const built = await buildPasswordList({ ...p, minCount }).catch((e: unknown) => e);
          if (want.length === 0) {
            expect(built).toMatchObject({ kind: 'input' });
            await expect(stat(p.out)).rejects.toThrow();
            return;
          }
          expect(built).toEqual({
            lines: sorted.length,
            records: want.length,
            belowMinCount: sorted.length - want.length,
          });
          expect(recordsOf(await readFile(p.out))).toEqual(want);
        },
      ),
      { numRuns: 120 },
    );
    expect(await leftovers()).toEqual([]);
  });

  it('a result with no records is refused and writes nothing', async () => {
    const p = await input(`${sha1('a')}:1\n`);
    await expect(buildPasswordList({ ...p, minCount: 2 })).rejects.toMatchObject({
      kind: 'input',
      message: 'no line has a count of at least --min-count 2; nothing was written',
    });
    await expect(stat(p.out)).rejects.toThrow();
  });

  it('replaces an earlier list in one step, readable by everyone, and it opens as a list', async () => {
    const p = await input(`${sha1('new one')}:9\n`);
    await writeFile(p.out, Buffer.alloc(BREACHED_RECORD_BYTES * 3));
    await buildPasswordList({ ...p, minCount: 1 });
    expect((await stat(p.out)).mode & 0o777).toBe(0o644);
    const file = await openBreachedPasswordFile(p.out);
    try {
      expect(file.records).toBe(1);
      await expect(file.isBreached('new one', new AbortController().signal)).resolves.toBe(true);
    } finally {
      await file.close();
    }
    expect(await leftovers()).toEqual([]);
  });

  it('a failed build leaves an existing list byte for byte as it was, with no temp file', async () => {
    const [a, b] = ascending('a', 'b') as [string, string];
    const p = await input(`${a}:4\n${b}:4\nbroken\n`);
    const before = Buffer.from('an earlier list, twenty bytes long....');
    await writeFile(p.out, before);
    await expect(buildPasswordList({ ...p, minCount: 1 })).rejects.toMatchObject({ line: 3 });
    expect(await readFile(p.out)).toEqual(before);
    expect(await leftovers()).toEqual([]);
  });

  it('refuses --out naming the --from file, by path or by a second link, and writes nothing', async () => {
    const text = `${sha1('a')}:9\n`;
    const p = await input(text);
    await expect(
      buildPasswordList({ from: p.from, out: p.from, minCount: 1 }),
    ).rejects.toMatchObject({ kind: 'input', message: '--out must not be the --from file' });
    await link(p.from, p.out);
    await expect(buildPasswordList({ ...p, minCount: 1 })).rejects.toMatchObject({
      message: '--out must not be the --from file',
    });
    expect(await readFile(p.from, 'utf8')).toBe(text);
    expect(await leftovers()).toEqual([]);
  });

  it('a missing input or an output folder that does not exist is a file system failure', async () => {
    const p = paths();
    await expect(buildPasswordList({ ...p, minCount: 1 })).rejects.toMatchObject({
      kind: 'files',
      message: 'cannot read --from: ENOENT',
    });
    const q = await input(`${sha1('a')}:9\n`);
    await expect(
      buildPasswordList({ from: q.from, out: join(dir, 'no-such-folder', 'x.bin'), minCount: 1 }),
    ).rejects.toMatchObject({ kind: 'files', message: 'cannot write --out: ENOENT' });
  });
});

describe('drefyn auth password-list build', () => {
  it('builds the list and prints one summary line', async () => {
    const [a, b, c] = ascending('a', 'b', 'c') as [string, string, string];
    const p = await input(`${a}:5\n${b}:1\n${c}:7\n`);
    const result = await build(p, '2');
    expect(result).toEqual({
      code: 0,
      stdout: `password-list: read 3 lines, wrote 2 records to ${p.out}, dropped 1 under --min-count 2\n`,
      stderr: '',
    });
    expect(recordsOf(await readFile(p.out))).toEqual([a, c]);
  });

  it('a bad line exits 2 naming the line and not echoing it', async () => {
    const p = await input(`${sha1('a')}:5\nnot a hash line\n`);
    const result = await build(p);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'password-list: line 2: expected a 40 character SHA-1 and a count\n',
    );
  });

  it('a result with nothing in it exits 2', async () => {
    const p = await input(`${sha1('a')}:1\n`);
    const result = await build(p, '5');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('nothing was written');
  });

  it('a missing input exits 5 without a stack', async () => {
    const result = await build(paths());
    expect(result).toEqual({
      code: 5,
      stdout: '',
      stderr: 'password-list: cannot read --from: ENOENT\n',
    });
  });

  it('reads no environment', async () => {
    const p = await input(`${sha1('a')}:5\n`);
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error('read the environment');
        },
      },
    );
    const code = await runAuthCommand({
      argv: [
        'auth',
        'password-list',
        'build',
        '--from',
        p.from,
        '--min-count',
        '1',
        '--out',
        p.out,
      ],
      env,
      stdout: sink(),
      stderr: sink(),
    });
    expect(code).toBe(0);
  });

  it.each([
    [[]],
    [['auth']],
    [['auth', 'password-list']],
    [['auth', 'password-list', 'check']],
    [['auth', 'link']],
    [['migrate', 'up']],
    [['auth', 'password-list', 'build', '--out', '/x', '--min-count', '1']],
    [['auth', 'password-list', 'build', '--from', '/a', '--min-count', '1']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '0']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '01']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '1e3']],
    [
      [
        'auth',
        'password-list',
        'build',
        '--from',
        '/a',
        '--out',
        '/b',
        '--min-count',
        '99999999999999999999',
      ],
    ],
    [['auth', 'password-list', 'build', '--from', '/a', '--from', '/c', '--out', '/b']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count']],
    [['auth', 'password-list', 'build', '--from', '', '--out', '/b', '--min-count', '1']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--min-count', '2', 'x']],
    [['auth', 'password-list', 'build', '--from', '/a', '--out', '/b', '--force']],
  ])('refuses %j with the usage line and exit 2', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.endsWith(`${AUTH_COMMAND_USAGE}\n`)).toBe(true);
    expect(AUTH_COMMAND_USAGE.split('\n')[0]).toBe(
      'usage: drefyn auth password-list build --from <file> --min-count <n> --out <file>',
    );
  });
});
