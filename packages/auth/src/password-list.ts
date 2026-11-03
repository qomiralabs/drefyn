import { randomBytes } from 'node:crypto';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BREACHED_RECORD_BYTES } from './breached-file.ts';

export interface PasswordListBuild {
  // Lines of `<40 hex SHA-1>:<count>` in ascending hash order, as the Pwned Passwords
  // downloader writes them in SHA-1 mode.
  readonly from: string;
  readonly out: string;
  // Entries seen fewer times than this are left out.
  readonly minCount: number;
}

export interface PasswordListSummary {
  readonly lines: number;
  readonly records: number;
  readonly belowMinCount: number;
}

// input: an argument or an input line is wrong. files: reading or writing failed.
export type PasswordListFailure = 'input' | 'files';

export class PasswordListError extends Error {
  readonly kind: PasswordListFailure;
  declare readonly line?: number;

  constructor(kind: PasswordListFailure, message: string, line?: number) {
    super(message);
    this.kind = kind;
    if (line !== undefined) this.line = line;
  }
}

Object.defineProperty(PasswordListError.prototype, 'name', {
  value: 'PasswordListError',
  enumerable: false,
});

const LINE = /^([0-9A-Fa-f]{40}):([0-9]+)\r?$/;
// 80 KiB a write, so memory stays the same whatever the size of the list.
const WRITE_RECORDS = 4096;
// Below 16 digits a count is exact as a number; past that BigInt decides.
const EXACT_DIGITS = 15;

const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';

const inputError = (message: string, line?: number) =>
  new PasswordListError('input', message, line);

function atLeast(digits: string, min: number): boolean {
  return digits.length <= EXACT_DIGITS ? Number(digits) >= min : BigInt(digits) >= BigInt(min);
}

async function sameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [left, right] = await Promise.all([stat(a), stat(b).catch(() => null)]);
  return right !== null && left.dev === right.dev && left.ino === right.ino;
}

// Streams the input once and writes as it goes, so memory stays flat. The list lands under
// --out by one rename after an fsync, so a reader never sees half of it and a failed build
// leaves the previous list as it was.
export async function buildPasswordList(build: PasswordListBuild): Promise<PasswordListSummary> {
  if (!Number.isSafeInteger(build.minCount) || build.minCount < 1) {
    throw inputError('--min-count must be a whole number of 1 or more');
  }
  const from = resolve(build.from);
  const out = resolve(build.out);
  const input = await open(from, 'r').catch((error: unknown) => {
    throw new PasswordListError('files', `cannot read --from: ${codeOf(error)}`);
  });
  const temp = `${out}.tmp-${randomBytes(4).toString('hex')}`;
  let output: FileHandle | undefined;
  try {
    if (await sameFile(from, out)) throw inputError('--out must not be the --from file');
    output = await open(temp, 'wx', 0o644).catch((error: unknown) => {
      throw new PasswordListError('files', `cannot write --out: ${codeOf(error)}`);
    });
    // The mode given to open is cut by the umask; the content is public hashes.
    await output.chmod(0o644);
    const summary = await copyRecords(input, output, build.minCount);
    await output.sync();
    await output.close();
    output = undefined;
    await rename(temp, out);
    await syncFolder(dirname(out));
    return summary;
  } catch (error) {
    await output?.close().catch(() => undefined);
    await rm(temp, { force: true });
    if (error instanceof PasswordListError) throw error;
    throw new PasswordListError('files', `cannot write --out: ${codeOf(error)}`);
  } finally {
    // The line reader may already have closed it.
    await input.close().catch(() => undefined);
  }
}

async function copyRecords(
  input: FileHandle,
  output: FileHandle,
  minCount: number,
): Promise<PasswordListSummary> {
  const pending = Buffer.alloc(WRITE_RECORDS * BREACHED_RECORD_BYTES);
  const current = Buffer.alloc(BREACHED_RECORD_BYTES);
  const previous = Buffer.alloc(BREACHED_RECORD_BYTES);
  let seen = false;
  let used = 0;
  let lines = 0;
  let records = 0;
  let belowMinCount = 0;
  let blankAt = 0;

  for await (const text of input.readLines({ encoding: 'utf8' })) {
    lines += 1;
    // An empty line is fine only as the last one.
    if (blankAt !== 0) break;
    if (text === '') {
      blankAt = lines;
      continue;
    }
    const match = LINE.exec(text);
    // The line is never quoted: it may be a password pasted in by mistake.
    if (match === null) {
      throw inputError(`line ${String(lines)}: expected a 40 character SHA-1 and a count`, lines);
    }
    current.write(match[1] ?? '', 'hex');
    if (seen && Buffer.compare(previous, current) >= 0) {
      throw inputError(
        `line ${String(lines)}: hashes must be in strictly ascending order; sort the input with LC_ALL=C sort`,
        lines,
      );
    }
    current.copy(previous);
    seen = true;
    if (!atLeast(match[2] ?? '', minCount)) {
      belowMinCount += 1;
      continue;
    }
    current.copy(pending, used * BREACHED_RECORD_BYTES);
    used += 1;
    records += 1;
    if (used === WRITE_RECORDS) {
      await output.write(pending, 0, pending.length);
      used = 0;
    }
  }
  if (blankAt !== 0 && blankAt !== lines) {
    throw inputError(`line ${String(blankAt)}: expected a 40 character SHA-1 and a count`, blankAt);
  }
  if (records === 0) {
    throw inputError(
      `no line has a count of at least --min-count ${String(minCount)}; nothing was written`,
    );
  }
  if (used > 0) await output.write(pending, 0, used * BREACHED_RECORD_BYTES);
  return { lines: blankAt === 0 ? lines : lines - 1, records, belowMinCount };
}

// So the rename itself survives a power cut. Some file systems cannot sync a folder.
async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, 'r');
  try {
    await handle.sync().catch((error: unknown) => {
      if (codeOf(error) !== 'EINVAL') throw error;
    });
  } finally {
    await handle.close();
  }
}
