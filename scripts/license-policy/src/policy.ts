// A package accepted despite its license, but only under the license it was reviewed
// with. Matching is by exact name, or by an anchored pattern for platform binaries.
export interface Exception {
  name?: string;
  pattern?: string;
  license: string;
  reason: string;
}

export interface Policy {
  allow: string[];
  exceptions: Exception[];
}

export interface PackageLicense {
  name: string;
  versions: string[];
  license?: string;
}

// Shape of `pnpm licenses list --json`: packages grouped by license.
export type LicenseReport = Record<string, PackageLicense[]>;

export interface Violation {
  name: string;
  versions: string[];
  license: string;
  // Set when an exception names the package but was reviewed under another license.
  expected?: string;
}

export interface CheckResult {
  violations: Violation[];
  unusedExceptions: string[];
  checked: number;
  excepted: string[];
}

class ParseError extends Error {}

const TOKEN = /\s*(\(|\)|[A-Za-z0-9.+-]+|\S)/gy;
const IDENTIFIER = /^[A-Za-z0-9.+-]+$/;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(expression)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
  }
  return tokens;
}

// Small SPDX expression evaluator: OR needs one allowed side, AND needs both.
// Anything it cannot read, including WITH exceptions, counts as not allowed.
export function satisfies(expression: string, allowed: Set<string>): boolean {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function atom(): boolean {
    const token = take();
    if (token === '(') {
      const value = or();
      if (take() !== ')') throw new ParseError('missing )');
      return value;
    }
    if (token === undefined || !IDENTIFIER.test(token) || ['AND', 'OR', 'WITH'].includes(token)) {
      throw new ParseError(`unexpected ${token ?? 'end'}`);
    }
    if (peek() === 'WITH') {
      take();
      atom();
      return false;
    }
    return allowed.has(token);
  }

  function and(): boolean {
    let value = atom();
    while (peek() === 'AND') {
      take();
      value = atom() && value;
    }
    return value;
  }

  function or(): boolean {
    let value = and();
    while (peek() === 'OR') {
      take();
      value = and() || value;
    }
    return value;
  }

  try {
    const value = or();
    return pos === tokens.length && value;
  } catch (error) {
    if (error instanceof ParseError) return false;
    throw error;
  }
}

export function exceptionLabel(exception: Exception): string {
  return exception.name ?? exception.pattern ?? '';
}

function matches(exception: Exception, name: string): boolean {
  if (exception.name !== undefined) return exception.name === name;
  return exception.pattern !== undefined && new RegExp(exception.pattern).test(name);
}

export function checkLicenses(report: LicenseReport, policy: Policy): CheckResult {
  const allowed = new Set(policy.allow);
  const violations: Violation[] = [];
  const excepted: string[] = [];
  const used = new Set<Exception>();
  let checked = 0;
  for (const [group, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) throw new Error(`license report group ${group} is not a list`);
    for (const pkg of packages) {
      checked += 1;
      const license = pkg.license ?? group;
      if (satisfies(license, allowed)) continue;
      const exception = policy.exceptions.find((e) => matches(e, pkg.name));
      if (exception === undefined) {
        violations.push({ name: pkg.name, versions: pkg.versions, license });
        continue;
      }
      used.add(exception);
      if (exception.license === license) {
        excepted.push(pkg.name);
      } else {
        violations.push({
          name: pkg.name,
          versions: pkg.versions,
          license,
          expected: exception.license,
        });
      }
    }
  }
  // An empty listing means pnpm failed or ran in the wrong place, not that all is well.
  if (checked === 0) throw new Error('the license report lists no packages');
  excepted.sort();
  const unusedExceptions = policy.exceptions.filter((e) => !used.has(e)).map(exceptionLabel);
  return { violations, unusedExceptions, checked, excepted };
}
