import { spawn } from 'node:child_process';

export interface IndexEntry {
  mode: string;
  oid: string;
  path: string;
}

export interface Commit {
  sha: string;
  message: string;
}

const SUBMODULE_MODE = '160000';

export function runGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let inputError: Error | undefined;
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const name = args[0] ?? '';
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`git ${name} failed (exit ${code ?? 'signal'}): ${stderr}`));
      } else if (inputError !== undefined) {
        reject(new Error(`git ${name} closed its input early: ${inputError.message}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
    if (input !== undefined && child.stdin !== null) {
      // git can exit before reading all of its input, for example on a bad argument. The
      // exit code is the real result, so a broken pipe is recorded here, not thrown.
      child.stdin.on('error', (error) => {
        inputError = error;
      });
      child.stdin.end(input);
    }
  });
}

// Reads the index rather than the working tree, so a pre-commit run sees exactly what
// is about to be committed and CI sees exactly what was pushed.
export async function listIndex(cwd: string): Promise<IndexEntry[]> {
  const raw = (await runGit(cwd, ['ls-files', '--stage', '-z'])).toString('utf8');
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode = '', oid = ''] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    // During a merge conflict the same path appears once per stage.
    if (mode === SUBMODULE_MODE || seen.has(path)) continue;
    seen.add(path);
    entries.push({ mode, oid, path });
  }
  return entries;
}

const SIZE = /^(0|[1-9][0-9]*)$/;

// The gate must never pass content it did not read, so any reply that does not match
// the request exactly, record by record, is an error rather than a partial result.
export async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, Buffer>> {
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
      throw new Error(`git cat-file returned ${oid || 'nothing'} where ${requested} was requested`);
    }
    // A missing object has no size or body, so it cannot be read as a short record.
    if (fields.length === 2 && type === 'missing') {
      throw new Error(`git cat-file reports ${oid} missing`);
    }
    if (fields.length !== 3) throw new Error(`git cat-file gave a malformed header for ${oid}`);
    if (type !== 'blob') throw new Error(`git cat-file returned ${type || 'nothing'} for ${oid}`);
    if (!SIZE.test(size)) throw new Error(`git cat-file gave an invalid size for ${oid}: ${size}`);
    const start = headerEnd + 1;
    const end = start + Number(size);
    if (!Number.isSafeInteger(end) || end > raw.length) {
      throw new Error(`git cat-file body for ${oid} is truncated`);
    }
    if (raw[end] !== 0x0a) {
      throw new Error(`git cat-file body for ${oid} is not followed by a newline`);
    }
    blobs.set(oid, raw.subarray(start, end));
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
