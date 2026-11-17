import type { AppSigner } from './types.ts';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const HEADER = encode({ alg: 'RS256', typ: 'JWT' });

// The App's own credential, good only for asking GitHub for an installation token. Issued a
// minute back for clock drift and kept under the ten minutes GitHub allows.
export function appJwt(signer: AppSigner, appId: number, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const payload = encode({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const signature = signer.sign(`${HEADER}.${payload}`).toString('base64url');
  return `${HEADER}.${payload}.${signature}`;
}
