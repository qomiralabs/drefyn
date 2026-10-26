import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluate, formatReport, statusDescription, type Review, type GateInput } from './gate.ts';
import { GitHubClient, loadGateInput } from './github.ts';
import { carryOver } from './history.ts';
import { DEFAULT_CONFIG_PATH, loadConfig } from './rules.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = `usage: review-gate evaluate --input <file.json> [--rules <file>] [--github-output <file>] [--summary <file>]
       review-gate github --repo <owner/name> --pr <number> [--github-output <file>] [--summary <file>]

  evaluate  read head SHA, labels, changed files and reviews from a JSON file
  github    read them from the GitHub API using GITHUB_TOKEN
            (and GITHUB_API_URL and GITHUB_GRAPHQL_URL if set). With
            REVIEW_GATE_GIT_DIR set to a full history checkout holding the PR
            head, approvals carry over clean merges of origin/<base branch>
  --rules   path rules file, defaults to rules.json next to this package

exit codes: 0 gate passed, 1 gate failed, 2 usage, input or API error
`;

class InputError extends Error {}

const INPUT_KEYS = new Set(['headSha', 'labels', 'files', 'reviews', 'carry', 'carryNote']);
const REVIEW_KEYS = new Set([
  'author',
  'authorType',
  'authorAssociation',
  'submittedAt',
  'body',
  'edited',
  'dismissed',
]);

// A misspelled or foreign key (say lastEditedAt instead of edited) would otherwise be
// ignored and the review judged as if it were clean.
function rejectUnknownKeys(value: Record<string, unknown>, known: Set<string>, where: string) {
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown !== undefined) throw new InputError(`${where} has unknown key ${unknown}`);
}

function parseInput(raw: unknown): GateInput {
  if (typeof raw !== 'object' || raw === null) throw new InputError('input must be an object');
  const value = raw as Record<string, unknown>;
  rejectUnknownKeys(value, INPUT_KEYS, 'input');
  const { headSha, labels, files, reviews, carry, carryNote } = value;
  if (
    carry !== undefined &&
    (!Array.isArray(carry) || !carry.every((c) => typeof c === 'string'))
  ) {
    throw new InputError('carry must be a list of commit SHAs');
  }
  if (carryNote !== undefined && typeof carryNote !== 'string') {
    throw new InputError('carryNote must be a string');
  }
  if (typeof headSha !== 'string') throw new InputError('headSha must be a string');
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    throw new InputError('labels must be a list of strings');
  }
  // Without the changed files the path rules cannot run, and guessing would fail open.
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
    throw new InputError('files must be a list of changed paths');
  }
  if (!Array.isArray(reviews)) throw new InputError('reviews must be a list');
  const parsed = (reviews as unknown[]).map((item, i): Review => {
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    rejectUnknownKeys(e, REVIEW_KEYS, `reviews[${i}]`);
    const { author, authorType, authorAssociation, submittedAt, body, edited, dismissed } = e;
    if (
      typeof author !== 'string' ||
      typeof authorType !== 'string' ||
      (authorAssociation !== undefined && typeof authorAssociation !== 'string') ||
      typeof submittedAt !== 'string' ||
      typeof body !== 'string' ||
      (edited !== undefined && typeof edited !== 'boolean') ||
      (dismissed !== undefined && typeof dismissed !== 'boolean')
    ) {
      throw new InputError(
        `reviews[${i}] needs string author, authorType, submittedAt and body; authorAssociation must be a string and edited and dismissed booleans if set`,
      );
    }
    return {
      author,
      authorType,
      ...(authorAssociation === undefined ? {} : { authorAssociation }),
      submittedAt,
      body,
      ...(edited === undefined ? {} : { edited }),
      ...(dismissed === undefined ? {} : { dismissed }),
    };
  });
  return {
    headSha,
    labels,
    files,
    reviews: parsed,
    ...(carry === undefined ? {} : { carry }),
    ...(carryNote === undefined ? {} : { carryNote }),
  };
}

// An environment variable rather than a flag: on pull_request events the workflow file
// comes from the PR while this script comes from the base, so a new flag would make an
// older script on the base reject the whole run. An unknown variable is just ignored.
async function carryFor(
  env: NodeJS.ProcessEnv,
  head: string,
  baseRef: string | undefined,
): Promise<Pick<GateInput, 'carry' | 'carryNote'>> {
  const dir = env['REVIEW_GATE_GIT_DIR'] ?? '';
  if (dir === '') return { carryNote: 'no git directory given' };
  if (baseRef === undefined) return { carryNote: 'the PR names no base branch' };
  const result = await carryOver({ cwd: dir, head, base: `refs/remotes/origin/${baseRef}` });
  return { carry: result.carried, carryNote: result.stop };
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: Deps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        input: { type: 'string' },
        repo: { type: 'string' },
        pr: { type: 'string' },
        rules: { type: 'string' },
        'github-output': { type: 'string' },
        summary: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== 'evaluate' && command !== 'github')) {
    io.err(USAGE);
    return 2;
  }

  try {
    const config = loadConfig(values.rules ?? DEFAULT_CONFIG_PATH);
    let input: GateInput;
    if (command === 'evaluate') {
      if (values.input === undefined) throw new InputError('--input is required');
      input = parseInput(JSON.parse(readFileSync(values.input, 'utf8')));
    } else {
      if (values.repo === undefined) throw new InputError('--repo is required');
      if (values.pr === undefined || !/^[1-9][0-9]*$/.test(values.pr)) {
        throw new InputError('PR number must be a positive integer');
      }
      const token = env['GITHUB_TOKEN'] ?? '';
      if (token === '') throw new InputError('GITHUB_TOKEN is not set');
      const client = new GitHubClient({
        token,
        ...(env['GITHUB_API_URL'] === undefined ? {} : { apiUrl: env['GITHUB_API_URL'] }),
        ...(env['GITHUB_GRAPHQL_URL'] === undefined
          ? {}
          : { graphqlUrl: env['GITHUB_GRAPHQL_URL'] }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      });
      const { baseRef, ...pr } = await loadGateInput(client, values.repo, Number(values.pr));
      input = { ...pr, ...(await carryFor(env, pr.headSha, baseRef)) };
    }

    const result = evaluate(input, config);
    const report = formatReport(result);
    io.out(report);
    if (values['github-output'] !== undefined) {
      appendFileSync(
        values['github-output'],
        `state=${result.pass ? 'success' : 'failure'}\nsha=${result.headSha}\ndescription=${statusDescription(result)}\n`,
      );
    }
    if (values.summary !== undefined) {
      appendFileSync(values.summary, `## Review gate\n\n\`\`\`\n${report}\`\`\`\n`);
    }
    return result.pass ? 0 : 1;
  } catch (error) {
    io.err(`review-gate: error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
