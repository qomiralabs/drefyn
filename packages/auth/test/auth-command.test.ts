import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_COMMAND_USAGE, runAuthCommand, terminalLogger } from '../src/command.ts';
import { validEnv } from './support.ts';

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

// Database settings that are well formed but point at nothing, for cases that must stop
// before any connection.
const DB_ENV = {
  DREFYN_DATABASE_URL: 'postgres://drefyn_app:x@127.0.0.1:1/drefyn',
  DREFYN_AUTH_DATABASE_URL: 'postgres://drefyn_auth:x@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
};

async function run(argv: readonly string[], env: Record<string, string | undefined> = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runAuthCommand({ argv, env, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('drefyn auth link and revoke-sessions arguments', () => {
  it('lists every auth command in the usage text', () => {
    expect(AUTH_COMMAND_USAGE).toBe(
      [
        'usage: drefyn auth password-list build --from <file> --min-count <n> --out <file>',
        '       drefyn auth link --email <address> [--create-organization <name>]',
        '       drefyn auth revoke-sessions --email <address> | --all',
      ].join('\n'),
    );
  });

  it.each([
    [['auth', 'link']],
    [['auth', 'link', '--email']],
    [['auth', 'link', '--email', '']],
    [['auth', 'link', '--email', 'a@example.com', '--email', 'b@example.com']],
    [['auth', 'link', '--email', 'a@example.com', '--create-organization']],
    [['auth', 'link', '--email', 'a@example.com', '--all']],
    [['auth', 'link', '--email', 'a@example.com', 'extra']],
    [['auth', 'revoke-sessions']],
    [['auth', 'revoke-sessions', '--all', '--all']],
    [['auth', 'revoke-sessions', '--all', '--email', 'a@example.com']],
    [['auth', 'revoke-sessions', '--email']],
    [['auth', 'revoke-sessions', '--create-organization', 'Acme']],
    [['auth', 'revoke-session', '--all']],
  ])('refuses %j with exit 2 before reading the environment', async (argv) => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error('read the environment');
        },
        ownKeys() {
          throw new Error('read the environment');
        },
      },
    );
    const stdout = sink();
    const stderr = sink();
    const code = await runAuthCommand({ argv, env, stdout, stderr });
    expect(code).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text.endsWith(`${AUTH_COMMAND_USAGE}\n`)).toBe(true);
  });

  it('never echoes an address it was given into an error', async () => {
    const result = await run(['auth', 'link', '--email', 'secret-person@example.com', '--nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('secret-person');
  });

  it('exits 3 naming the key when DREFYN_APP_ORIGIN is unset, and prints no value', async () => {
    const env: Record<string, string | undefined> = { ...validEnv(), ...DB_ENV };
    delete env['DREFYN_APP_ORIGIN'];
    const result = await run(['auth', 'link', '--email', 'a@example.com'], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('DREFYN_APP_ORIGIN');
    expect(result.stderr).not.toContain(validEnv().DREFYN_AUTH_SECRET);
  });

  it('exits 3 naming the key when the block key is missing', async () => {
    const env: Record<string, string | undefined> = { ...validEnv(), ...DB_ENV };
    delete env['DREFYN_AUTH_INVITATION_BLOCK_KEY'];
    const result = await run(['auth', 'revoke-sessions', '--all'], env);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('DREFYN_AUTH_INVITATION_BLOCK_KEY');
  });

  it('exits 3 when a database URL is missing, naming it and never the other URL', async () => {
    const env: Record<string, string | undefined> = { ...validEnv(), ...DB_ENV };
    delete env['DREFYN_AUTH_DATABASE_URL'];
    const result = await run(['auth', 'link', '--email', 'a@example.com'], env);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('DREFYN_AUTH_DATABASE_URL');
    expect(result.stderr).not.toContain('127.0.0.1:1');
  });

  it('exits 3 when DREFYN_DATABASE_URL is missing, because both roles are needed', async () => {
    const env: Record<string, string | undefined> = { ...validEnv(), ...DB_ENV };
    delete env['DREFYN_DATABASE_URL'];
    const result = await run(['auth', 'link', '--email', 'a@example.com'], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('DREFYN_DATABASE_URL');
    expect(result.stderr).not.toContain('127.0.0.1:1');
  });

  it('writes routine events to stderr as JSON lines, and warnings too', () => {
    const stderr = sink();
    const logger = terminalLogger(stderr);
    logger.info?.('auth.cli_link_created', { userId: 'usr_1' });
    logger.warn('auth.organization_create_failed', { userId: 'usr_1' });
    expect(
      stderr.text
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { level: 'info', event: 'auth.cli_link_created', userId: 'usr_1' },
      { level: 'warn', event: 'auth.organization_create_failed', userId: 'usr_1' },
    ]);
  });

  it('exits 2 for an address the rules refuse, before any connection', async () => {
    const result = await run(['auth', 'link', '--email', 'not an address'], {
      ...validEnv(),
      ...DB_ENV,
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--email');
    expect(result.stderr).not.toContain('not an address');
  });

  it('exits 2 for an organization name the rules refuse, before any connection', async () => {
    const result = await run(
      ['auth', 'link', '--email', 'a@example.com', '--create-organization', '   '],
      { ...validEnv(), ...DB_ENV },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--create-organization');
  });

  it('exits 4 when the database cannot be reached, and prints no link', async () => {
    const result = await run(['auth', 'link', '--email', 'a@example.com'], {
      ...validEnv(randomBytes(32).toString('base64url')),
      ...DB_ENV,
      DREFYN_DATABASE_POOL_WAIT_MS: '500',
    });
    expect(result.code).toBe(4);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('postgres://');
  });
});
