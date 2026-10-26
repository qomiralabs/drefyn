import { createHash } from 'node:crypto';

export type ObjectFormat = 'sha1' | 'sha256';

// Computed here rather than imported from the code under test, so a wrong hash in the
// reader cannot also make the expected oid wrong. Kept apart from helpers.ts so suites
// that mock node:child_process can import it.
export function blobOid(body: string | Uint8Array, format: ObjectFormat = 'sha1'): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
