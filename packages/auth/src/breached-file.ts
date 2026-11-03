import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { BreachedPasswordCheck } from './breach-check.ts';
import { AuthError } from './errors.ts';
import type { AuthLogger } from './rate-limiter.ts';
import { quietInfo } from './session-support.ts';

// One SHA-1 digest per record, sorted, with nothing else in the file.
export const BREACHED_RECORD_BYTES = 20;

export interface BreachedPasswordFile extends BreachedPasswordCheck {
  readonly records: number;
  // null when the signal fired before the search finished.
  contains(digest: Uint8Array, signal?: AbortSignal): Promise<boolean | null>;
  close(): Promise<void>;
}

// The record for a password: SHA-1 of its UTF-8 bytes, which is how Pwned Passwords lists
// them, after NFKC, which is the form auth hashes and compares.
export function breachedDigest(password: string): Buffer {
  return createHash('sha1').update(password.normalize('NFKC'), 'utf8').digest();
}

const refuse = (reason: string) =>
  new AuthError('AUTH_CONFIG_INVALID', { key: 'DREFYN_AUTH_BREACHED_PASSWORDS_FILE', reason });

// Records per block. A fence (the first record of each block) is read at open, so a lookup
// searches the fences in memory and then reads one 20 KiB block. That is one read instead of
// 26, and the fences for 50 million records take about 1 MiB.
const BLOCK_RECORDS = 1024;
// Fence reads at open, in flight at once.
const FENCE_READS = 64;
// Block buffers kept for reuse, so steady lookups allocate nothing and memory stays flat.
const SPARE_BUFFERS = 16;

export interface OpenOptions {
  // Smaller blocks in tests, so small files still cross block edges.
  readonly blockRecords?: number;
}

// The file is never read whole: only the fences at open, and one block per lookup. Each
// lookup has its own buffer, so lookups in parallel share the handle safely.
export async function openBreachedPasswordFile(
  path: string,
  options: OpenOptions = {},
): Promise<BreachedPasswordFile> {
  const blockRecords = options.blockRecords ?? BLOCK_RECORDS;
  const handle = await open(path, 'r');
  let records: number;
  let fences: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw refuse('must be a regular file');
    if (stat.size % BREACHED_RECORD_BYTES !== 0) {
      throw refuse('is not whole 20 byte records; build it with drefyn auth password-list build');
    }
    records = stat.size / BREACHED_RECORD_BYTES;
    fences = await readFences(handle, records, blockRecords);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const blocks = fences.length / BREACHED_RECORD_BYTES;
  const spare: Buffer[] = [];

  // The last block whose fence is at or below the digest, or -1 when the digest is below all.
  function blockFor(digest: Uint8Array): number {
    let low = 0;
    let high = blocks - 1;
    let found = -1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const at = middle * BREACHED_RECORD_BYTES;
      if (fences.compare(digest, 0, BREACHED_RECORD_BYTES, at, at + BREACHED_RECORD_BYTES) <= 0) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  async function contains(digest: Uint8Array, signal?: AbortSignal): Promise<boolean | null> {
    if (signal?.aborted === true) return null;
    const block = blockFor(digest);
    if (block < 0) return false;
    const first = block * blockRecords;
    const count = Math.min(blockRecords, records - first);
    const bytes = count * BREACHED_RECORD_BYTES;
    const buffer = spare.pop() ?? Buffer.alloc(blockRecords * BREACHED_RECORD_BYTES);
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytes, first * BREACHED_RECORD_BYTES);
      // Truncated under us: no answer is better than a wrong one.
      if (bytesRead !== bytes) throw new Error('breached list shrank');
      if (signal?.aborted === true) return null;
      return search(buffer, count, digest);
    } finally {
      if (spare.length < SPARE_BUFFERS) spare.push(buffer);
    }
  }

  function search(buffer: Buffer, count: number, digest: Uint8Array): boolean {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const at = middle * BREACHED_RECORD_BYTES;
      const order = buffer.compare(
        digest,
        0,
        BREACHED_RECORD_BYTES,
        at,
        at + BREACHED_RECORD_BYTES,
      );
      if (order === 0) return true;
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  }

  return Object.freeze({
    records,
    contains,
    isBreached: (password: string, signal: AbortSignal) =>
      contains(breachedDigest(password), signal),
    close: () => handle.close(),
  });
}

async function readFences(handle: FileHandle, records: number, blockRecords: number) {
  const blocks = Math.ceil(records / blockRecords);
  const fences = Buffer.alloc(blocks * BREACHED_RECORD_BYTES);
  for (let start = 0; start < blocks; start += FENCE_READS) {
    const reads: Promise<unknown>[] = [];
    for (let block = start; block < Math.min(blocks, start + FENCE_READS); block += 1) {
      reads.push(
        handle.read(
          fences,
          block * BREACHED_RECORD_BYTES,
          BREACHED_RECORD_BYTES,
          block * blockRecords * BREACHED_RECORD_BYTES,
        ),
      );
    }
    await Promise.all(reads);
  }
  return fences;
}

const ABSENT =
  'no breached password list configured; the built in rules still apply; see Breached passwords in the self host guide';

// Run once at startup. With no file configured there is no check and the operator is told
// where to read about building one; a configured file that cannot serve fails startup
// rather than quietly checking nothing.
export async function loadBreachedPasswords(
  config: { readonly passwords: { readonly breachedPasswordsFile: string | null } },
  logger: AuthLogger,
): Promise<BreachedPasswordFile | undefined> {
  const path = config.passwords.breachedPasswordsFile;
  if (path === null) {
    quietInfo(logger, 'auth.breached_list_absent', { message: ABSENT });
    return undefined;
  }
  // Errors from the file system carry the path, so none is passed on as a cause.
  const file = await openBreachedPasswordFile(path).catch((error: unknown) => {
    throw error instanceof AuthError ? error : refuse('cannot be opened');
  });
  if (file.records === 0) {
    await file.close();
    throw refuse('is empty; build it with drefyn auth password-list build');
  }
  quietInfo(logger, 'auth.breached_list_loaded', { records: file.records });
  return file;
}
