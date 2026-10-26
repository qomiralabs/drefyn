import { readFileSync } from 'node:fs';
import {
  KNOWN_REVIEWERS,
  MATCHER_FIELDS,
  PATH_CLASSES,
  type GateConfig,
  type Matcher,
  type PathRules,
} from './gate.ts';

// Read from the checked out base, so a PR cannot loosen the rules it is judged by or add
// itself to the list of people allowed to sign.
export const DEFAULT_CONFIG_PATH = new URL('../rules.json', import.meta.url);

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function fail(detail: string): never {
  throw new Error(`invalid rules: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A misspelled key would match nothing and quietly move paths to a lower tier, so every
// key must be known and every field present.
function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) fail(`${where} has unknown key ${extra}`);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) fail(`${where} is missing ${missing}`);
}

function patterns(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value.map((item, i) => {
    if (typeof item !== 'string' || item === '') fail(`${where}[${i}] must be a non empty string`);
    return item;
  });
}

function parseMatcher(value: unknown, where: string): Matcher {
  if (!isObject(value)) fail(`${where} must be an object`);
  exactKeys(value, MATCHER_FIELDS, where);
  const prefixes = patterns(value['prefixes'], `${where}.prefixes`);
  // Only a whole segment may be a wildcard; a* would read as a glob it is not.
  const bad = prefixes.findIndex((p) =>
    p.split('/').some((part) => part.includes('*') && part !== '*'),
  );
  if (bad !== -1) fail(`${where}.prefixes[${bad}] may use * only as a whole path segment`);
  return {
    prefixes,
    names: patterns(value['names'], `${where}.names`),
    contains: patterns(value['contains'], `${where}.contains`),
    suffixes: patterns(value['suffixes'], `${where}.suffixes`),
  };
}

function parsePaths(value: unknown): PathRules {
  if (!isObject(value)) fail('"paths" must map path classes to matchers');
  exactKeys(value, PATH_CLASSES, 'paths');
  return {
    security: parseMatcher(value['security'], 'paths.security'),
    tests: parseMatcher(value['tests'], 'paths.tests'),
    ui: parseMatcher(value['ui'], 'paths.ui'),
    docs: parseMatcher(value['docs'], 'paths.docs'),
  };
}

function parseReviewers(value: unknown): Record<string, string[]> {
  if (!isObject(value)) fail('"reviewers" must map reviewer names to lists of logins');
  const reviewers: Record<string, string[]> = {};
  for (const [name, logins] of Object.entries(value)) {
    if (!KNOWN_REVIEWERS.has(name)) fail(`reviewers.${name} is not a known reviewer`);
    if (!Array.isArray(logins)) fail(`reviewers.${name} must be a list of logins`);
    reviewers[name] = logins.map((login, i) => {
      if (typeof login !== 'string' || !LOGIN.test(login)) {
        fail(`reviewers.${name}[${i}] is not a GitHub login`);
      }
      return login;
    });
  }
  return reviewers;
}

export function parseConfig(raw: unknown): GateConfig {
  if (!isObject(raw)) fail('the file must hold an object');
  exactKeys(raw, ['reviewers', 'paths'], 'the file');
  return { paths: parsePaths(raw['paths']), reviewers: parseReviewers(raw['reviewers']) };
}

export function loadConfig(path: string | URL): GateConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
