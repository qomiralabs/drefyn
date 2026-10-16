import { readFileSync } from 'node:fs';
import { KNOWN_REVIEWERS, type GateConfig, type PathRule } from './gate.ts';

// Read from the checked out base, so a PR cannot loosen the rules it is judged by or add
// itself to the list of people allowed to sign.
export const DEFAULT_CONFIG_PATH = new URL('../rules.json', import.meta.url);

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function fail(detail: string): never {
  throw new Error(`invalid rules: ${detail}`);
}

function patterns(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value.map((item, i) => {
    if (typeof item !== 'string' || item === '') fail(`${where}[${i}] must be a non empty string`);
    return item;
  });
}

function parseReviewers(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('"reviewers" must map reviewer names to lists of logins');
  }
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
  if (typeof raw !== 'object' || raw === null) fail('the file must hold an object');
  const { rules, reviewers } = raw as Record<string, unknown>;
  if (!Array.isArray(rules)) fail('"rules" must be a list');
  const paths = rules.map((item, i): PathRule => {
    const rule = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { reviewer } = rule;
    if (typeof reviewer !== 'string' || !KNOWN_REVIEWERS.has(reviewer)) {
      fail(`rules[${i}].reviewer is not a known reviewer`);
    }
    return {
      reviewer,
      prefixes: patterns(rule['prefixes'], `rules[${i}].prefixes`),
      names: patterns(rule['names'], `rules[${i}].names`),
      contains: patterns(rule['contains'], `rules[${i}].contains`),
    };
  });
  return { paths, reviewers: parseReviewers(reviewers) };
}

export function loadConfig(path: string | URL): GateConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
