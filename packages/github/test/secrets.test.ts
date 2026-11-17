import { generateKeyPairSync, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadAppSigner } from '../src/private-key.ts';
import { GitHubConfigError, readWebhookSecret } from '../src/index.ts';
import { testKeys } from './support/keys.ts';

const keys = testKeys();

describe('loadAppSigner', () => {
  it('signs with the App key and hands out nothing but the signing', () => {
    const signer = loadAppSigner(keys.privateKeyFile);
    const signature = signer.sign('header.payload');
    expect(verify('RSA-SHA256', Buffer.from('header.payload'), keys.publicKey, signature)).toBe(
      true,
    );
    expect(Object.keys(signer)).toEqual(['sign']);
    expect(Object.isFrozen(signer)).toBe(true);
    const shown = `${JSON.stringify(signer)} ${inspect(signer, { showHidden: true })} ${String(signer.sign)}`;
    expect(shown).not.toContain('PRIVATE KEY');
    expect(shown).not.toContain(keys.privateKeyPem.split('\n')[1] ?? 'unreachable');
  });

  it('reads a PKCS 8 key as well', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const file = keys.write('pkcs8.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(loadAppSigner(file).sign('x')).toHaveLength(256);
  });

  const refused = (file: string) => {
    try {
      loadAppSigner(file);
    } catch (error) {
      return error;
    }
    return null;
  };

  it.each([
    ['a missing file', () => `${keys.dir}/absent.pem`],
    ['a file that is not a key', () => keys.write('junk.pem', 'not a key at all')],
    [
      'an EC key',
      () =>
        keys.write(
          'ec.pem',
          generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }),
        ),
    ],
    [
      'an RSA key under 2048 bits',
      () =>
        keys.write(
          'small.pem',
          generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
            type: 'pkcs1',
            format: 'pem',
          }),
        ),
    ],
    [
      'a public key',
      () => keys.write('public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' })),
    ],
  ])('refuses %s without quoting the file', (_name, make) => {
    const error = refused(make());
    expect(error).toBeInstanceOf(GitHubConfigError);
    const failure = error as GitHubConfigError;
    expect(failure.key).toBe('DREFYN_GITHUB_PRIVATE_KEY_FILE');
    expect(failure.message).not.toContain('KEY');
    expect(failure.message).not.toContain(keys.dir);
    expect(failure.cause).toBeUndefined();
  });
});

describe('readWebhookSecret', () => {
  it('reads the bytes and drops one trailing newline', () => {
    const file = keys.write('hook', 'a-webhook-secret-of-enough-length\n');
    expect(Buffer.from(readWebhookSecret(file)).toString()).toBe(
      'a-webhook-secret-of-enough-length',
    );
    const crlf = keys.write('hook-crlf', 'a-webhook-secret-of-enough-length\r\n');
    expect(Buffer.from(readWebhookSecret(crlf)).toString()).toBe(
      'a-webhook-secret-of-enough-length',
    );
  });

  it.each([
    ['a missing file', () => `${keys.dir}/absent`],
    ['a secret under 16 bytes', () => keys.write('short', 'short-secret\n')],
    ['an empty file', () => keys.write('empty', '')],
  ])('refuses %s without quoting it', (_name, make) => {
    let caught: unknown = null;
    try {
      readWebhookSecret(make());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubConfigError);
    expect((caught as GitHubConfigError).key).toBe('DREFYN_GITHUB_WEBHOOK_SECRET_FILE');
    expect((caught as GitHubConfigError).message).not.toContain('short-secret');
  });
});
