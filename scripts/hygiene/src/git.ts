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

function runGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
        return;
      }
      const stderr = Buffer.concat(err).toString('utf8').trim();
      reject(new Error(`git ${args[0] ?? ''} failed (exit ${code ?? 'signal'}): ${stderr}`));
    });
    child.stdin.end(input ?? '');
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

export async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const raw = await runGit(cwd, ['cat-file', '--batch'], oids.join('\n') + '\n');
  let offset = 0;
  while (offset < raw.length) {
    const headerEnd = raw.indexOf(0x0a, offset);
    const [oid = '', type = '', size = ''] = raw.subarray(offset, headerEnd).toString().split(' ');
    if (type !== 'blob') throw new Error(`git cat-file returned ${type || 'nothing'} for ${oid}`);
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(oid, raw.subarray(start, end));
    offset = end + 1;
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
