import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = new Set(['LazyMotion', 'm', 'MotionConfig']);
// The only dynamic import of Motion: the async feature bundle.
const FEATURES =
  /import\(\s*['"]motion\/react['"]\s*\)\s*\.then\(\s*\(?\s*\w*\s*\)?\s*=>\s*\w+\.domAnimation\s*\)/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

interface Use {
  file: string;
  text: string;
}

function scan(file: string, source: string, named: Use[], other: Use[]): void {
  {
    const statics = source.matchAll(
      /import\s+(type\s+)?([^'";]*?)\s+from\s+['"]((?:framer-)?motion(?:\/[^'"]*)?)['"]/g,
    );
    for (const [text, typeOnly, clause = '', specifier] of statics) {
      if (typeOnly !== undefined) continue;
      const names = /^\{([^}]*)\}$/.exec(clause.trim());
      if (specifier !== 'motion/react' || names === null) {
        other.push({ file, text });
        continue;
      }
      for (const raw of (names[1] ?? '').split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0] ?? '';
        if (name === '' || name.startsWith('type ')) continue;
        (ALLOWED.has(name) ? named : other).push({ file, text: name });
      }
    }
    for (const match of source.matchAll(
      /import\(\s*['"`]((?:framer-)?motion[^'"`]*)['"`]\s*\)[^;\n]*/g,
    )) {
      (FEATURES.test(match[0]) ? named : other).push({ file, text: match[0] });
    }
    for (const match of source.matchAll(/require\(\s*['"`](?:framer-)?motion[^)]*\)/g)) {
      other.push({ file, text: match[0] });
    }
  }
}

function motionUses(): { named: Use[]; other: Use[] } {
  const named: Use[] = [];
  const other: Use[] = [];
  for (const path of files(SRC))
    scan(relative(SRC, path), readFileSync(path, 'utf8'), named, other);
  return { named, other };
}

function scanText(source: string) {
  const named: Use[] = [];
  const other: Use[] = [];
  scan('fixture.tsx', source, named, other);
  return { named: named.map((u) => u.text), other: other.map((u) => u.text) };
}

describe('the Motion import scan', () => {
  it('accepts the lazy setup', () => {
    const source = [
      "import { LazyMotion, m, MotionConfig } from 'motion/react';",
      "const features = () => import('motion/react').then((mod) => mod.domAnimation);",
    ].join('\n');
    expect(scanText(source).other).toEqual([]);
    expect(scanText(source).named).toHaveLength(4);
  });

  it.each([
    ["import { motion } from 'motion/react';", 'the eager motion component'],
    ["import { AnimatePresence } from 'motion/react';", 'another named export'],
    ["import { m as motion, domAnimation } from 'motion/react';", 'features imported eagerly'],
    ["import * as M from 'motion/react';", 'a namespace import'],
    ["import Motion from 'motion';", 'the root entry'],
    ["import { m } from 'framer-motion';", 'the old package'],
    ["import { animate } from 'motion/dom';", 'another subpath'],
    ["const x = await import('motion/react');", 'a dynamic import of everything'],
    ["const x = require('motion/react');", 'a require'],
  ])('flags %s (%s)', (source) => {
    expect(scanText(source).other).not.toEqual([]);
  });

  it('ignores type only imports', () => {
    expect(scanText("import type { Transition } from 'motion/react';")).toEqual({
      named: [],
      other: [],
    });
  });
});

describe('Motion in the dashboard', () => {
  it('is imported only as LazyMotion, m, MotionConfig and the async feature bundle', () => {
    expect(motionUses().other).toEqual([]);
  });

  it('is set up once: LazyMotion with async features inside MotionConfig that follows the user', () => {
    const { named } = motionUses();
    const used = new Set(named.map((u) => (u.text.startsWith('import(') ? 'features' : u.text)));
    expect([...used].sort()).toEqual(
      expect.arrayContaining(['LazyMotion', 'MotionConfig', 'features']),
    );
    const config = files(SRC)
      .map((path) => readFileSync(path, 'utf8'))
      .filter((source) => source.includes('<MotionConfig'));
    expect(config).toHaveLength(1);
    expect(config[0]).toMatch(/<MotionConfig[^>]*reducedMotion="user"/);
    expect(config[0]).toMatch(/<LazyMotion[^>]*features=\{/);
  });
});
