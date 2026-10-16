import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkLicenses, type Exception, type LicenseReport, type Policy } from './policy.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `usage: license-policy --input <pnpm-licenses.json> [--policy <policy.json>]

  Feed it the output of \`pnpm licenses list --json\`.
exit codes: 0 all allowed, 1 violations, 2 usage or input error
`;

const DEFAULT_POLICY = new URL('../policy.json', import.meta.url);

class PolicyError extends Error {
  constructor(detail: string) {
    super(`invalid policy: ${detail}`);
  }
}

function readException(raw: unknown, index: number): Exception {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { name, pattern, license, reason } = value;
  const where = `exceptions[${index}]`;
  if (typeof license !== 'string' || license === '')
    throw new PolicyError(`${where} needs a license`);
  if (typeof reason !== 'string' || reason === '') throw new PolicyError(`${where} needs a reason`);
  if (typeof name === 'string' && pattern === undefined) return { name, license, reason };
  if (typeof pattern === 'string' && name === undefined) {
    // Unanchored patterns are how an exception quietly grows to cover other packages.
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      throw new PolicyError(`${where} pattern must be anchored with ^ and $`);
    }
    return { pattern, license, reason };
  }
  throw new PolicyError(`${where} needs exactly one of name or pattern`);
}

function readPolicy(path: string | URL): Policy {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { allow, exceptions } = value;
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) {
    throw new PolicyError('"allow" must be a list of license ids');
  }
  if (!Array.isArray(exceptions)) throw new PolicyError('"exceptions" must be a list');
  return { allow, exceptions: exceptions.map(readException) };
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
      const note = v.expected === undefined ? '' : ` (the exception covers ${v.expected} only)`;
      io.err(`${v.name}@${v.versions.join(',')}: ${v.license} is not allowed${note}\n`);
    }
    for (const label of result.unusedExceptions) {
      io.err(`exception ${label} matched no package; remove it\n`);
    }
    io.out(
      `licenses: ${result.checked} packages checked, ${result.excepted.length} by exception${
        result.excepted.length > 0 ? ` (${result.excepted.join(', ')})` : ''
      }, ${result.violations.length} violations\n`,
    );
    return result.violations.length === 0 && result.unusedExceptions.length === 0 ? 0 : 1;
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
