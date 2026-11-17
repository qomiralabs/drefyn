import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export interface TestKeys {
  readonly dir: string;
  readonly privateKeyFile: string;
  readonly privateKeyPem: string;
  readonly publicKey: KeyObject;
  // Writes a file next to the key, for secrets and broken keys.
  write(name: string, content: string | Uint8Array): string;
}

// A throwaway App key per test file, so no test needs the real App or its secrets.
export function testKeys(): TestKeys {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-github-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const write = (name: string, content: string | Uint8Array) => {
    const file = join(dir, name);
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  };
  return { dir, privateKeyFile: write('app.pem', privateKeyPem), privateKeyPem, publicKey, write };
}
