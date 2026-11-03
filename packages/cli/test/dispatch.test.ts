import { AUTH_COMMAND_USAGE, runAuthCommand } from '@drefyn/auth/command';
import { MIGRATE_USAGE, runMigrate } from '@drefyn/db/command';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDrefyn, type Commands } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const main = join(root, 'src', 'main.ts');

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

function stubs() {
  return {
    migrate: vi.fn<Commands['migrate']>(() => Promise.resolve(3)),
    auth: vi.fn<Commands['auth']>(() => Promise.resolve(5)),
  };
}

describe('runDrefyn', () => {
  it('hands migrate the full argv and its exit code back', async () => {
    const commands = stubs();
    const stdout = sink();
    const stderr = sink();
    const env = { DREFYN_MIGRATION_DATABASE_URL: 'postgres://x' };
    const argv = ['migrate', 'down', '2'];
    await expect(runDrefyn({ argv, env, stdout, stderr, commands })).resolves.toBe(3);
    expect(commands.migrate).toHaveBeenCalledWith({ argv, env, stdout, stderr });
    expect(commands.auth).not.toHaveBeenCalled();
  });

  it('hands auth the full argv and its exit code back', async () => {
    const commands = stubs();
    const stdout = sink();
    const stderr = sink();
    const argv = ['auth', 'password-list', 'build'];
    await expect(runDrefyn({ argv, env: {}, stdout, stderr, commands })).resolves.toBe(5);
    expect(commands.auth).toHaveBeenCalledWith({ argv, env: {}, stdout, stderr });
    expect(commands.migrate).not.toHaveBeenCalled();
  });

  it.each([[[]], [['nonsense']], [['--help']], [['Migrate', 'up']], [['authx']]])(
    'refuses %j with both usage lines and exit 2',
    async (argv) => {
      const commands = stubs();
      const stdout = sink();
      const stderr = sink();
      await expect(runDrefyn({ argv, env: {}, stdout, stderr, commands })).resolves.toBe(2);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(`${MIGRATE_USAGE}\n${AUTH_COMMAND_USAGE}\n`);
      expect(commands.migrate).not.toHaveBeenCalled();
      expect(commands.auth).not.toHaveBeenCalled();
    },
  );

  it('uses the real commands by default', async () => {
    const stderr = sink();
    const code = await runDrefyn({ argv: ['auth'], env: {}, stdout: sink(), stderr });
    const direct = sink();
    expect(code).toBe(
      await runAuthCommand({ argv: ['auth'], env: {}, stdout: sink(), stderr: direct }),
    );
    expect(stderr.text).toBe(direct.text);
  });
});

const exec = (args: readonly string[], env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] }) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [main, ...args], { env }, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : Number(error.code), stdout, stderr });
    });
  });

describe('the drefyn binary', () => {
  it('is declared by this package, starts with a shebang and holds no command logic', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ drefyn: './src/main.ts' });
    expect(manifest.dependencies).toEqual({
      '@drefyn/auth': 'workspace:*',
      '@drefyn/db': 'workspace:*',
    });
    expect(readFileSync(main, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  });

  it('migrate behaves exactly as runMigrate does, output and exit code', async () => {
    const stdout = sink();
    const stderr = sink();
    const env = { PATH: process.env['PATH'] };
    const code = await runMigrate({ argv: ['migrate', 'status'], env, stdout, stderr });
    const spawned = await exec(['migrate', 'status'], env);
    expect(spawned).toEqual({ code, stdout: stdout.text, stderr: stderr.text });
    expect(code).not.toBe(0);
  });

  it('builds a breached list through auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drefyn-cli-'));
    try {
      const from = join(dir, 'pwned.txt');
      const out = join(dir, 'breached.bin');
      const hash = createHash('sha1').update('password').digest('hex').toUpperCase();
      await writeFile(from, `${hash}:9\r\n`);
      const result = await exec([
        'auth',
        'password-list',
        'build',
        '--from',
        from,
        '--min-count',
        '1',
        '--out',
        out,
      ]);
      expect(result).toEqual({
        code: 0,
        stdout: `password-list: read 1 lines, wrote 1 records to ${out}, dropped 0 under --min-count 1\n`,
        stderr: '',
      });
      expect((await readFile(out)).toString('hex').toUpperCase()).toBe(hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an unknown command exits 2 with the usage lines', async () => {
    await expect(exec(['nonsense'])).resolves.toEqual({
      code: 2,
      stdout: '',
      stderr: `${MIGRATE_USAGE}\n${AUTH_COMMAND_USAGE}\n`,
    });
  });
});
