import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkLicenses, type LicenseReport, type Policy } from './policy.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `usage: license-policy --input <pnpm-licenses.json> [--policy <policy.json>]

  Feed it the output of \`pnpm licenses list --json\`.
exit codes: 0 all allowed, 1 violations, 2 usage or input error
`;

const DEFAULT_POLICY = new URL('../policy.json', import.meta.url);

function readPolicy(path: string | URL): Policy {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { allow, exceptions } = value;
  const allowOk = Array.isArray(allow) && allow.every((a) => typeof a === 'string');
  const exceptionsOk =
    typeof exceptions === 'object' &&
    exceptions !== null &&
    Object.values(exceptions).every((reason) => typeof reason === 'string');
  if (!allowOk || !exceptionsOk) {
    throw new Error('policy needs an "allow" list and an "exceptions" map of reasons');
  }
  return { allow, exceptions: exceptions as Record<string, string> };
}

export function main(argv: string[], io: Io): number {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: { input: { type: 'string' }, policy: { type: 'string' } },
    });
    if (values.input === undefined) {
      io.err(USAGE);
      return 2;
    }
    const report = JSON.parse(readFileSync(values.input, 'utf8')) as LicenseReport;
    const policy = readPolicy(values.policy ?? DEFAULT_POLICY);
    const result = checkLicenses(report, policy);
    for (const v of result.violations) {
      io.err(`${v.name}@${v.versions.join(',')}: ${v.license} is not allowed\n`);
    }
    io.out(
      `licenses: ${result.checked} packages checked, ${result.excepted.length} by exception${
        result.excepted.length > 0 ? ` (${result.excepted.join(', ')})` : ''
      }, ${result.violations.length} violations\n`,
    );
    return result.violations.length === 0 ? 0 : 1;
  } catch (error) {
    io.err(`licenses: error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
