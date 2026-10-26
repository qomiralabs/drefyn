import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach } from 'vitest';

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export function migrationText(up: string, down: string): string {
  return `-- Up Migration\n${up}\n\n-- Down Migration\n${down}\n`;
}

// Throws unless fn throws; returns what it threw so the caller can look at it.
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

export async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A throwaway migrations folder, removed after the test.
export function migrationsDir(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-db-unit-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

// Everything a log line, a crash report or an error tracker could print.
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    parts.push(inspect(current, { depth: 10, showHidden: true }));
    if (current instanceof Error) {
      parts.push(current.toString(), current.message, current.stack ?? '');
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // Circular errors still had their text read above.
      }
      current = current.cause;
    } else {
      current = undefined;
    }
  }
  return parts.join('\n');
}
