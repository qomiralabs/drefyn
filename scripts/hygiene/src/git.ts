import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream';

export interface IndexEntry {
  mode: string;
  oid: string;
  path: string;
}

export interface Commit {
  sha: string;
  message: string;
}

export type ObjectFormat = 'sha1' | 'sha256';

const SUBMODULE_MODE = '160000';

const OID: Record<ObjectFormat, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

// A replace ref makes git hand back a different object under the oid that was asked
// for, so hygiene would scan the replacement. GIT_NO_REPLACE_OBJECTS and
// --no-replace-objects both lose to core.useReplaceRefs=true in the repository's own
// config, and a command line -c outranks every config file. The variable stays as well
// so any git that git itself starts inherits it.
const REPLACE_OBJECTS_OFF = ['-c', 'core.useReplaceRefs=false'];

export function runGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...REPLACE_OBJECTS_OFF, ...args], {
      cwd,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const name = args[0] ?? '';
    let failed = false;
    let exitCode: number | null | undefined;
    // Stays false until stdin is flushed or has failed. When git exits, Node destroys
    // stdin, and a write still pending then fails without an error event, so only
    // finished() sees it. Settling on close or on an error listener would count a run
    // where git dropped its input as a success.
    let inputDone = input === undefined || child.stdin === null;
    let inputError: Error | undefined;

    const settle = (): void => {
      if (failed || exitCode === undefined || !inputDone) return;
      if (exitCode !== 0) {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`git ${name} failed (exit ${exitCode ?? 'signal'}): ${stderr}`));
      } else if (inputError !== undefined) {
        reject(new Error(`git ${name} closed its input early: ${inputError.message}`));
      } else {
        resolve(Buffer.concat(out));
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      failed = true;
      reject(error);
    });
    child.on('close', (code: number | null) => {
      exitCode = code;
      settle();
    });
    if (input !== undefined && child.stdin !== null) {
      // git can exit before reading all of its input, for example on a bad argument. A
      // broken pipe, a write cancelled at exit or a premature close is recorded rather
      // than thrown, so a non zero exit still reports git's own error.
      finished(child.stdin, { readable: false }, (error) => {
        inputError = error ?? undefined;
        inputDone = true;
        settle();
      });
      child.stdin.end(input);
    }
  });
}

export async function objectFormat(cwd: string): Promise<ObjectFormat> {
  const format = (await runGit(cwd, ['rev-parse', '--show-object-format'])).toString('utf8').trim();
  // A git too old for the option prints it back, which must not be taken as sha1.
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error('git rev-parse gave an unsupported object format');
  }
  return format;
}

const MODE = /^[0-7]{6}$/;
const STAGE = /^[0-3]$/;

// Reads the index rather than the working tree, so a pre-commit run sees exactly what
// is about to be committed and CI sees exactly what was pushed. Errors name the record
// by position only, because the path is repository content.
export async function listIndex(cwd: string, format: ObjectFormat): Promise<IndexEntry[]> {
  const raw = (await runGit(cwd, ['ls-files', '--stage', '-z'])).toString('utf8');
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  let position = 0;
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    position += 1;
    const where = `git ls-files record ${position}`;
    const tab = record.indexOf('\t');
    if (tab === -1) throw new Error(`${where} has no tab before the path`);
    const fields = record.slice(0, tab).split(' ');
    const [mode = '', oid = '', stage = ''] = fields;
    const path = record.slice(tab + 1);
    if (fields.length !== 3) throw new Error(`${where} does not have three fields`);
    if (!MODE.test(mode)) throw new Error(`${where} has an invalid mode`);
    if (!OID[format].test(oid)) throw new Error(`${where} has an invalid oid`);
    if (!STAGE.test(stage)) throw new Error(`${where} has an invalid stage`);
    if (path === '') throw new Error(`${where} has no path`);
    // During a merge conflict the same path appears once per stage.
    if (mode === SUBMODULE_MODE || seen.has(path)) continue;
    seen.add(path);
    entries.push({ mode, oid, path });
  }
  return entries;
}

const SIZE = /^(0|[1-9][0-9]*)$/;
const TYPE = /^[a-z]{1,16}$/;

// Header fields are echoed only when they have the shape git gives them. Anything else
// may be body bytes from a misframed stream, and bodies can hold secrets that would
// end up in CI logs.
function shown(value: string, shape: RegExp, fallback: string): string {
  return shape.test(value) ? value : fallback;
}

function hashBlob(format: ObjectFormat, body: Buffer): string {
  return createHash(format).update(`blob ${body.length}\0`).update(body).digest('hex');
}

// The gate must never pass content it did not read, so any reply that does not match
// the request exactly, record by record, is an error rather than a partial result. The
// oid is the hash of the content, so hashing each body proves it is the object that
// was asked for, whatever made git send something else.
export async function readBlobs(
  cwd: string,
  oids: string[],
  format: ObjectFormat,
): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const raw = await runGit(cwd, ['cat-file', '--batch'], oids.join('\n') + '\n');
  let offset = 0;
  let index = 0;
  while (offset < raw.length) {
    const requested = oids[index];
    if (requested === undefined) {
      throw new Error(`git cat-file returned more objects than the ${oids.length} requested`);
    }
    const headerEnd = raw.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error(`git cat-file header for ${requested} has no newline`);
    const fields = raw.subarray(offset, headerEnd).toString('utf8').split(' ');
    const [oid = '', type = '', size = ''] = fields;
    if (oid !== requested) {
      const got = oid === '' ? 'nothing' : shown(oid, OID[format], 'an invalid oid');
      throw new Error(`git cat-file returned ${got} where ${requested} was requested`);
    }
    // A missing object has no size or body, so it cannot be read as a short record.
    if (fields.length === 2 && type === 'missing') {
      throw new Error(`git cat-file reports ${oid} missing`);
    }
    if (fields.length !== 3) throw new Error(`git cat-file gave a malformed header for ${oid}`);
    if (type !== 'blob') {
      const got = type === '' ? 'nothing' : shown(type, TYPE, 'an invalid type');
      throw new Error(`git cat-file returned ${got} for ${oid}`);
    }
    // A size past the safe integer range would be rounded, so it is as invalid as a
    // malformed one rather than a sign that the body was cut short.
    const length = Number(size);
    if (!SIZE.test(size) || !Number.isSafeInteger(length)) {
      throw new Error(`git cat-file gave an invalid size for ${oid}`);
    }
    const start = headerEnd + 1;
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > raw.length) {
      throw new Error(`git cat-file body for ${oid} is truncated`);
    }
    if (raw[end] !== 0x0a) {
      throw new Error(`git cat-file body for ${oid} is not followed by a newline`);
    }
    const body = raw.subarray(start, end);
    if (hashBlob(format, body) !== oid) {
      throw new Error(`git cat-file body for ${oid} does not match its oid`);
    }
    blobs.set(oid, body);
    offset = end + 1;
    index += 1;
  }
  if (index !== oids.length) {
    throw new Error(`git cat-file returned ${index} of ${oids.length} requested objects`);
  }
  return blobs;
}

export async function listCommits(cwd: string, range: string): Promise<Commit[]> {
  const raw = (await runGit(cwd, ['log', '-z', '--format=%H%n%B', range, '--'])).toString('utf8');
  const commits: Commit[] = [];
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    commits.push({ sha: record.slice(0, newline), message: record.slice(newline + 1) });
  }
  return commits;
}
