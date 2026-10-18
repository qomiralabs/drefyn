import { checkFileContent, checkMessage, checkPath, isBinary, type Finding } from './checks.ts';
import { listCommits, listIndex, readBlobs } from './git.ts';

export interface FilesResult {
  findings: Finding[];
  scanned: number;
  skippedBinary: number;
}

export interface CommitsResult {
  findings: Finding[];
  commits: number;
}

export interface PullRequestText {
  title: string;
  body?: string;
}

export async function checkTrackedFiles(cwd: string): Promise<FilesResult> {
  const entries = await listIndex(cwd);
  const blobs = await readBlobs(
    cwd,
    entries.map((entry) => entry.oid),
  );
  const findings: Finding[] = [];
  let scanned = 0;
  let skippedBinary = 0;
  for (const entry of entries) {
    findings.push(...checkPath(entry.path));
    const bytes = blobs.get(entry.oid);
    // Scanning a missing blob as empty would pass content that was never checked.
    if (bytes === undefined) throw new Error(`no blob was read for ${entry.path} (${entry.oid})`);
    if (isBinary(bytes)) {
      skippedBinary += 1;
      continue;
    }
    scanned += 1;
    findings.push(...checkFileContent(entry.path, bytes));
  }
  return { findings, scanned, skippedBinary };
}

export async function checkCommits(cwd: string, range: string): Promise<CommitsResult> {
  // A leading dash would be read by git as an option, not a revision.
  if (range === '' || range.startsWith('-')) throw new Error(`invalid commit range: ${range}`);
  const commits = await listCommits(cwd, range);
  const findings = commits.flatMap((commit) =>
    checkMessage(`commit ${commit.sha.slice(0, 12)}`, commit.message),
  );
  return { findings, commits: commits.length };
}

export function checkPullRequest(pr: PullRequestText): Finding[] {
  return [...checkMessage('pr title', pr.title), ...checkMessage('pr body', pr.body ?? '')];
}
