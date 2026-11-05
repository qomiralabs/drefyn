import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MdxRoot } from '../src/index.ts';

export const PIN_DIR = join(import.meta.dirname, 'fixtures', 'ast');
export const pinPath = (version: number) => join(PIN_DIR, `v${String(version)}.json`);

export type Pin = Readonly<Record<string, unknown>>;

const pinSchema = z.record(z.string(), z.unknown());

export const readPin = (version: number): Pin =>
  pinSchema.parse(JSON.parse(readFileSync(pinPath(version), 'utf8')));

export const pinnedVersions = (): readonly number[] =>
  readdirSync(PIN_DIR)
    .flatMap((file) => /^v([1-9][0-9]*)\.json$/.exec(file)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b);

// jsonb is the tree's real home, so a pin compares what survives JSON and nothing else.
export const asStored = (root: MdxRoot): unknown => JSON.parse(JSON.stringify(root));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

// The path of the first thing that differs, so a failure names the field.
export function firstDifference(pinned: unknown, actual: unknown, path = ''): string | null {
  if (!isRecord(pinned) || !isRecord(actual)) {
    return pinned === actual ? null : path;
  }
  if (Array.isArray(pinned) !== Array.isArray(actual)) return path;
  const keys = [...new Set([...Object.keys(pinned), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const at = path === '' ? key : `${path}.${key}`;
    const found =
      key in pinned && key in actual ? firstDifference(pinned[key], actual[key], at) : at;
    if (found !== null) return found;
  }
  return null;
}

export interface FreezeInput {
  readonly astVersion: number;
  readonly versions: readonly number[];
  readonly pin: Pin | null;
  readonly trees: Pin;
}

// Pure, so a test can hand it a changed tree or a bumped version without touching the parser.
export function freezeProblems({ astVersion, versions, pin, trees }: FreezeInput): string[] {
  const problems: string[] = [];
  const expected = Array.from({ length: astVersion }, (_, index) => index + 1);
  for (const version of expected) {
    if (!versions.includes(version)) problems.push(`no pin for astVersion ${String(version)}`);
  }
  for (const version of versions) {
    if (!expected.includes(version)) {
      problems.push(`pin for astVersion ${String(version)} is ahead of the code`);
    }
  }
  if (pin === null) return problems;
  for (const name of Object.keys(pin)) {
    if (!(name in trees)) problems.push(`case ${name} is pinned but no longer exists`);
  }
  for (const [name, tree] of Object.entries(trees)) {
    if (!(name in pin)) {
      problems.push(`case ${name} has no pin`);
      continue;
    }
    const path = firstDifference(pin[name], tree);
    if (path !== null) {
      problems.push(`case ${name} changed at ${path} without an astVersion bump`);
    }
  }
  return problems;
}
