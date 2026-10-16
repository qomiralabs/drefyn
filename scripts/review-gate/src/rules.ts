import { readFileSync } from 'node:fs';
import { KNOWN_REVIEWERS, type PathRule } from './gate.ts';

// Read from the checked out base, so a PR cannot loosen the rules it is judged by.
export const DEFAULT_RULES_PATH = new URL('../rules.json', import.meta.url);

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

export function parseRules(raw: unknown): PathRule[] {
  if (typeof raw !== 'object' || raw === null) fail('the file must hold an object');
  const { rules } = raw as Record<string, unknown>;
  if (!Array.isArray(rules)) fail('"rules" must be a list');
  return rules.map((item, i): PathRule => {
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
}

export function loadRules(path: string | URL): PathRule[] {
  return parseRules(JSON.parse(readFileSync(path, 'utf8')));
}
