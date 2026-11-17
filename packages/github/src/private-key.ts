import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GitHubConfigError } from './config.ts';
import type { AppSigner } from './types.ts';

const KEY = 'DREFYN_GITHUB_PRIVATE_KEY_FILE';
const MIN_BITS = 2048;

// The App key mints tokens for every repository of every customer who installed the App, so
// it is read here and nowhere else, and only the broker imports this file. The key object
// stays in this closure: the signer hands out signatures, never the key or its bytes.
export function loadAppSigner(file: string): AppSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(file));
  } catch {
    // Neither the path nor the parser's message: either can quote part of the file.
    throw new GitHubConfigError(KEY, 'is not a readable private key');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== 'rsa' || bits < MIN_BITS) {
    throw new GitHubConfigError(KEY, `must be an RSA key of at least ${String(MIN_BITS)} bits`);
  }
  return Object.freeze({ sign: (data: string) => sign('RSA-SHA256', Buffer.from(data), key) });
}
