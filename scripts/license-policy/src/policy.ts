// A package accepted despite its license, but only under the license it was reviewed
// with. Matching is by exact name, or by an anchored pattern for platform binaries.
export interface Exception {
  name?: string;
  pattern?: string;
  license: string;
  reason: string;
  // Must never reach the production dependency tree.
  devOnly?: boolean;
}

// A package refused whatever its license, matched the same way as exceptions.
export interface Forbidden {
  name?: string;
  pattern?: string;
  reason: string;
}

export interface Policy {
  allow: string[];
  exceptions: Exception[];
  forbidden: Forbidden[];
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
  // The policy's reason, set when the package is forbidden outright.
  forbidden?: string;
  // Set when a dev only exception shows up in the production tree.
  devOnly?: true;
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

export class PolicyError extends Error {
  constructor(detail: string) {
    super(`invalid policy: ${detail}`);
  }
}

type Fields = Record<string, unknown>;

function fields(raw: unknown): Fields {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Fields) : {};
}

// Exactly one of name or pattern. Unanchored patterns are how an entry quietly grows
// to cover other packages, so they are refused.
function readMatcher(value: Fields, where: string): { name: string } | { pattern: string } {
  const { name, pattern } = value;
  if (typeof name === 'string' && pattern === undefined) return { name };
  if (typeof pattern === 'string' && name === undefined) {
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      throw new PolicyError(`${where} pattern must be anchored with ^ and $`);
    }
    return { pattern };
  }
  throw new PolicyError(`${where} needs exactly one of name or pattern`);
}

function readReason(value: Fields, where: string): string {
  const { reason } = value;
  if (typeof reason !== 'string' || reason === '') throw new PolicyError(`${where} needs a reason`);
  return reason;
}

function readException(raw: unknown, index: number): Exception {
  const value = fields(raw);
  const where = `exceptions[${index}]`;
  const { license, devOnly } = value;
  if (typeof license !== 'string' || license === '')
    throw new PolicyError(`${where} needs a license`);
  const reason = readReason(value, where);
  if (devOnly !== undefined && typeof devOnly !== 'boolean') {
    throw new PolicyError(`${where} devOnly must be true or false`);
  }
  const exception: Exception = { ...readMatcher(value, where), license, reason };
  if (devOnly !== undefined) exception.devOnly = devOnly;
  return exception;
}

function readForbidden(raw: unknown, index: number): Forbidden {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyError(`forbidden[${index}] must be an object`);
  }
  const value = fields(raw);
  const where = `forbidden[${index}]`;
  return { ...readMatcher(value, where), reason: readReason(value, where) };
}

export function parsePolicy(raw: unknown): Policy {
  const { allow, exceptions, forbidden = [] } = fields(raw);
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) {
    throw new PolicyError('"allow" must be a list of license ids');
  }
  if (!Array.isArray(exceptions)) throw new PolicyError('"exceptions" must be a list');
  if (!Array.isArray(forbidden)) throw new PolicyError('"forbidden" must be a list');
  return {
    allow,
    exceptions: exceptions.map(readException),
    forbidden: forbidden.map(readForbidden),
  };
}

export function exceptionLabel(exception: Exception): string {
  return exception.name ?? exception.pattern ?? '';
}

function matches(entry: { name?: string; pattern?: string }, name: string): boolean {
  if (entry.name !== undefined) return entry.name === name;
  return entry.pattern !== undefined && new RegExp(entry.pattern).test(name);
}

function forbiddenReason(policy: Policy, name: string): string | undefined {
  return policy.forbidden.find((f) => matches(f, name))?.reason;
}

function packagesOf(report: LicenseReport): [string, PackageLicense][] {
  return Object.entries(report).flatMap(([group, packages]) => {
    if (!Array.isArray(packages)) throw new Error(`license report group ${group} is not a list`);
    return packages.map((pkg): [string, PackageLicense] => [group, pkg]);
  });
}

export function checkLicenses(report: LicenseReport, policy: Policy): CheckResult {
  const allowed = new Set(policy.allow);
  const violations: Violation[] = [];
  const excepted: string[] = [];
  const used = new Set<Exception>();
  let checked = 0;
  for (const [group, pkg] of packagesOf(report)) {
    checked += 1;
    const license = pkg.license ?? group;
    const forbidden = forbiddenReason(policy, pkg.name);
    if (forbidden !== undefined) {
      violations.push({ name: pkg.name, versions: pkg.versions, license, forbidden });
      continue;
    }
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
  // An empty listing means pnpm failed or ran in the wrong place, not that all is well.
  if (checked === 0) throw new Error('the license report lists no packages');
  excepted.sort();
  const unusedExceptions = policy.exceptions.filter((e) => !used.has(e)).map(exceptionLabel);
  return { violations, unusedExceptions, checked, excepted };
}

// Packages a dev only exception covers must not be in `pnpm licenses list --prod`.
// An empty production tree is fine, unlike the full listing.
export function checkProduction(report: LicenseReport, policy: Policy): Violation[] {
  const devOnly = policy.exceptions.filter((e) => e.devOnly === true);
  return packagesOf(report)
    .filter(([, pkg]) => devOnly.some((e) => matches(e, pkg.name)))
    .map(([group, pkg]) => ({
      name: pkg.name,
      versions: pkg.versions,
      license: pkg.license ?? group,
      devOnly: true,
    }));
}

// A mapping key on its own line: `name@version:` in pnpm 9, `/name@version:` before it,
// quoted when scoped, with a peer suffix like `(react@19.2.0)` on snapshot keys, and an
// inline `{}` when the snapshot has no fields.
const LOCK_KEY = /^\s+'?\/?((?:@[^@/\s']+\/)?[^@/\s']+)@([^\s'(]+)(?:\(.*\))?'?:\s*(?:\{\})?\s*$/;

// Every package the lockfile resolves, on any platform. The licence listing only sees
// what is installed here, so optional binaries for other systems are only visible here.
export function lockfilePackages(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const match = LOCK_KEY.exec(line);
    if (match === null) continue;
    const [, name = '', version = ''] = match;
    const versions = found.get(name) ?? [];
    if (!versions.includes(version)) versions.push(version);
    found.set(name, versions);
  }
  return found;
}

export function checkLockfile(text: string, policy: Policy): Violation[] {
  const violations: Violation[] = [];
  for (const [name, versions] of lockfilePackages(text)) {
    const forbidden = forbiddenReason(policy, name);
    if (forbidden !== undefined) violations.push({ name, versions, license: '', forbidden });
  }
  return violations;
}

// The `## <name>` sections of a notices file, each with the text under its heading.
function noticeSections(notices: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of notices.split(/^## /m).slice(1)) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    sections.set(heading, newline === -1 ? '' : part.slice(newline + 1));
  }
  return sections;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names of production packages outside the allow list that have no `## <name>` entry
// stating their licence on a `Licence: <id>` line. A mention elsewhere does not count:
// attribution has to be findable by the package name.
export function checkNotices(report: LicenseReport, policy: Policy, notices: string): string[] {
  const sections = noticeSections(notices);
  const missing: string[] = [];
  for (const [name, license] of outsideAllowList(report, policy)) {
    const body = sections.get(name);
    const stated = new RegExp(`^Licence: ${escapeRegExp(license)}\\s*$`, 'm');
    if (body === undefined || !stated.test(body)) missing.push(name);
  }
  return missing;
}

// Each package in a report whose licence is not on the allow list, with that licence.
export function outsideAllowList(report: LicenseReport, policy: Policy): Map<string, string> {
  const allowed = new Set(policy.allow);
  const found = new Map<string, string>();
  for (const [group, pkg] of packagesOf(report)) {
    const license = pkg.license ?? group;
    if (!satisfies(license, allowed)) found.set(pkg.name, license);
  }
  return found;
}
