import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluate, formatReport, statusDescription, type Entry, type GateInput } from './gate.ts';
import { GitHubClient, loadGateInput } from './github.ts';
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

  evaluate  read head SHA, labels, changed files and comments from a JSON file
  github    read them from the GitHub API using GITHUB_TOKEN
            (and GITHUB_API_URL and GITHUB_GRAPHQL_URL if set)
  --rules   path rules file, defaults to rules.json next to this package

exit codes: 0 gate passed, 1 gate failed, 2 usage, input or API error
`;

class InputError extends Error {}

const INPUT_KEYS = new Set(['headSha', 'labels', 'files', 'entries']);
const ENTRY_KEYS = new Set([
  'author',
  'authorAssociation',
  'createdAt',
  'body',
  'edited',
  'dismissed',
]);

// A misspelled or foreign key (say lastEditedAt instead of edited) would otherwise be
// ignored and the entry judged as if it were clean.
function rejectUnknownKeys(value: Record<string, unknown>, known: Set<string>, where: string) {
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown !== undefined) throw new InputError(`${where} has unknown key ${unknown}`);
}

function parseInput(raw: unknown): GateInput {
  if (typeof raw !== 'object' || raw === null) throw new InputError('input must be an object');
  const value = raw as Record<string, unknown>;
  rejectUnknownKeys(value, INPUT_KEYS, 'input');
  const { headSha, labels, files, entries } = value;
  if (typeof headSha !== 'string') throw new InputError('headSha must be a string');
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    throw new InputError('labels must be a list of strings');
  }
  // Without the changed files the path rules cannot run, and guessing would fail open.
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
    throw new InputError('files must be a list of changed paths');
  }
  if (!Array.isArray(entries)) throw new InputError('entries must be a list');
  const parsed = (entries as unknown[]).map((item, i): Entry => {
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    rejectUnknownKeys(e, ENTRY_KEYS, `entries[${i}]`);
    const { author, authorAssociation, createdAt, body, edited, dismissed } = e;
    if (
      typeof author !== 'string' ||
      (authorAssociation !== undefined && typeof authorAssociation !== 'string') ||
      typeof createdAt !== 'string' ||
      typeof body !== 'string' ||
      (edited !== undefined && typeof edited !== 'boolean') ||
      (dismissed !== undefined && typeof dismissed !== 'boolean')
    ) {
      throw new InputError(
        `entries[${i}] needs string author, createdAt and body; authorAssociation must be a string and edited and dismissed booleans if set`,
      );
    }
    return {
      author,
      ...(authorAssociation === undefined ? {} : { authorAssociation }),
      createdAt,
      body,
      ...(edited === undefined ? {} : { edited }),
      ...(dismissed === undefined ? {} : { dismissed }),
    };
  });
  return { headSha, labels, files, entries: parsed };
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
      input = await loadGateInput(client, values.repo, Number(values.pr));
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
