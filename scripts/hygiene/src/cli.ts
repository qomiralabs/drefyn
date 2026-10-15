import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatFinding, type Finding } from './checks.ts';
import { checkCommits, checkPullRequest, checkTrackedFiles } from './run.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `usage: hygiene [--files] [--commits <range>] [--pr]
               [--pr-title-file <path>] [--pr-body-file <path>] [--cwd <dir>]

  --files            tracked files: dash characters and internal paths (the default)
  --commits <range>  commit messages in a git range, for example base..head
  --pr               PR title and body from HYGIENE_PR_TITLE and HYGIENE_PR_BODY
  --pr-title-file    read the PR title from a file instead
  --pr-body-file     read the PR body from a file instead

exit codes: 0 clean, 1 problems found, 2 usage or git error
`;

class UsageError extends Error {}

function readPullRequest(
  env: NodeJS.ProcessEnv,
  titleFile: string | undefined,
  bodyFile: string | undefined,
): { title: string; body: string } {
  const title = titleFile === undefined ? env['HYGIENE_PR_TITLE'] : readFileSync(titleFile, 'utf8');
  const body = bodyFile === undefined ? env['HYGIENE_PR_BODY'] : readFileSync(bodyFile, 'utf8');
  // An empty title means the workflow wiring broke; passing would hide that.
  if (title === undefined || title.trim() === '') {
    throw new UsageError('no PR title: set HYGIENE_PR_TITLE or pass --pr-title-file');
  }
  return { title, body: body ?? '' };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        files: { type: 'boolean' },
        commits: { type: 'string' },
        pr: { type: 'boolean' },
        'pr-title-file': { type: 'string' },
        'pr-body-file': { type: 'string' },
        cwd: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }

  const cwd = values.cwd ?? process.cwd();
  const wantsPr =
    values.pr === true ||
    values['pr-title-file'] !== undefined ||
    values['pr-body-file'] !== undefined;
  const wantsFiles = values.files === true || (values.commits === undefined && !wantsPr);

  const findings: Finding[] = [];
  const summary: string[] = [];
  try {
    if (wantsFiles) {
      const result = await checkTrackedFiles(cwd);
      findings.push(...result.findings);
      summary.push(`${result.scanned} tracked files`, `${result.skippedBinary} binary skipped`);
    }
    if (values.commits !== undefined) {
      const result = await checkCommits(cwd, values.commits);
      findings.push(...result.findings);
      summary.push(`${result.commits} commits`);
    }
    if (wantsPr) {
      const pr = readPullRequest(env, values['pr-title-file'], values['pr-body-file']);
      findings.push(...checkPullRequest(pr));
      summary.push('pull request');
    }
  } catch (error) {
    io.err(`hygiene: error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (findings.length === 0) {
    io.out(`hygiene: clean (${summary.join(', ')})\n`);
    return 0;
  }
  io.err(findings.map((finding) => formatFinding(finding) + '\n').join(''));
  io.err(`hygiene: ${findings.length} problems\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
