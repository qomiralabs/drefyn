import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import {
  checkLicenses,
  checkLockfile,
  checkNotices,
  checkProduction,
  lockfilePackages,
  outsideAllowList,
  parsePolicy,
  type LicenseReport,
  type Policy,
  type Violation,
} from './policy.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `usage: license-policy --input <pnpm-licenses.json> [--policy <policy.json>]
                      [--lockfile <pnpm-lock.yaml>] [--prod-input <pnpm-licenses-prod.json>]
                      [--notices <THIRD_PARTY_NOTICES.md>]

  --input       output of \`pnpm licenses list --json\`; every package must have an
                allowed license or a matching exception, and every exception must match
  --lockfile    pnpm-lock.yaml; refuses forbidden packages for any platform, including
                optional binaries this machine did not install
  --prod-input  output of \`pnpm licenses list --prod --json\`; refuses packages whose
                exception is dev only
  --notices     the third party notices; every production package outside the allow
                list needs a \`## <name>\` entry with a \`Licence: <id>\` line. Needs --prod-input
  Forbidden packages (the policy's "forbidden" list) fail whatever their license.
exit codes: 0 all allowed, 1 violations, 2 usage or input error
`;

const DEFAULT_POLICY = new URL('../policy.json', import.meta.url);

// pnpm prints this line instead of JSON when the listing is empty.
const EMPTY_LISTING = 'No licenses in packages found';

function readPolicy(path: string | URL): Policy {
  return parsePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

function readProduction(path: string): LicenseReport {
  const text = readFileSync(path, 'utf8');
  if (text.trim() === EMPTY_LISTING) return {};
  return JSON.parse(text) as LicenseReport;
}

function describe(v: Violation, where: string): string {
  const versions = `${v.name}@${v.versions.join(',')}`;
  if (v.forbidden !== undefined)
    return `${versions}: forbidden in this workspace${where} (${v.forbidden})\n`;
  if (v.devOnly === true) return `${versions}: dev only exception found in the production tree\n`;
  const note = v.expected === undefined ? '' : ` (the exception covers ${v.expected} only)`;
  return `${versions}: ${v.license} is not allowed${note}\n`;
}

export function main(argv: string[], io: Io): number {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        input: { type: 'string' },
        policy: { type: 'string' },
        lockfile: { type: 'string' },
        'prod-input': { type: 'string' },
        notices: { type: 'string' },
      },
    });
    if (values.input === undefined) {
      io.err(USAGE);
      return 2;
    }
    if (values.notices !== undefined && values['prod-input'] === undefined) {
      io.err(`licenses: error: --notices needs --prod-input to know what ships\n${USAGE}`);
      return 2;
    }
    const report = JSON.parse(readFileSync(values.input, 'utf8')) as LicenseReport;
    const policy = readPolicy(values.policy ?? DEFAULT_POLICY);
    const result = checkLicenses(report, policy);
    let failed = result.violations.length > 0 || result.unusedExceptions.length > 0;
    for (const v of result.violations) io.err(describe(v, ''));
    for (const label of result.unusedExceptions) {
      io.err(`exception ${label} matched no package; remove it\n`);
    }
    io.out(
      `licenses: ${result.checked} packages checked, ${result.excepted.length} by exception${
        result.excepted.length > 0 ? ` (${result.excepted.join(', ')})` : ''
      }, ${result.violations.length} violations\n`,
    );

    if (values.lockfile !== undefined) {
      const text = readFileSync(values.lockfile, 'utf8');
      const count = lockfilePackages(text).size;
      // No keys means the file is not a pnpm lockfile, so the check proved nothing.
      if (count === 0) throw new Error(`${values.lockfile}: the lockfile lists no packages`);
      const found = checkLockfile(text, policy);
      for (const v of found) io.err(describe(v, `, found in ${basename(values.lockfile)}`));
      io.out(`lockfile: ${count} packages checked, ${found.length} forbidden\n`);
      failed ||= found.length > 0;
    }

    if (values['prod-input'] !== undefined) {
      const prod = readProduction(values['prod-input']);
      const found = checkProduction(prod, policy);
      for (const v of found) io.err(describe(v, ''));
      const count = Object.values(prod).reduce((n, list) => n + list.length, 0);
      io.out(`production: ${count} packages checked, ${found.length} dev only\n`);
      failed ||= found.length > 0;

      if (values.notices !== undefined) {
        const missing = checkNotices(prod, policy, readFileSync(values.notices, 'utf8'));
        const shipped = outsideAllowList(prod, policy);
        for (const name of missing) {
          io.err(
            `${name}: ships under ${shipped.get(name) ?? ''} with no entry in ${basename(values.notices)}\n`,
          );
        }
        const noun = shipped.size === 1 ? 'exception' : 'exceptions';
        io.out(`notices: ${shipped.size} shipped ${noun}, ${missing.length} missing\n`);
        failed ||= missing.length > 0;
      }
    }
    return failed ? 1 : 0;
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
