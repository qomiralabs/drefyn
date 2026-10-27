import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const components = join(root, 'src', 'react');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Raw design values hidden in strings: a hex colour, an rgb or hsl call, or a length or
// duration in px, rem, em, ms or s. Tailwind joins values with underscores, so a value
// counts as raw after any character but a letter or digit. Svg geometry is unitless.
const RAW = [
  { what: 'hex colour', pattern: /#[0-9a-f]{3,8}\b/i },
  { what: 'colour function', pattern: /(?<![a-z])(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i },
  { what: 'length', pattern: /(?<![a-z0-9.])\d*\.?\d+(?:px|rem|em|vh|vw)(?![a-z0-9])/i },
  { what: 'duration', pattern: /(?<![a-z0-9.])\d*\.?\d+m?s(?![a-z0-9])/i },
];

// Every string and template literal in a file, comments excluded.
function literals(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function rawValues(file: string, text: string): { what: string; literal: string }[] {
  return literals(file, text).flatMap((literal) =>
    RAW.filter(({ pattern }) => pattern.test(literal)).map(({ what }) => ({ what, literal })),
  );
}

describe('component source', () => {
  it('finds each kind of raw value it looks for', () => {
    const sample = readFileSync(join(root, 'test', 'fixtures', 'raw-values.tsx.txt'), 'utf8');
    // The literals themselves stay in the fixture, where the token lint does not look.
    const hits = rawValues('sample.tsx', sample);
    expect(hits.map((hit) => hit.what)).toEqual([
      'hex colour',
      'colour function',
      'length',
      'length',
      'duration',
    ]);
  });

  it('uses no raw colour, length or duration in any component file', () => {
    const files = sources(components);
    expect(files.length).toBeGreaterThan(1);
    const found = files.flatMap((file) =>
      rawValues(file, readFileSync(file, 'utf8')).map(
        (hit) => `${relative(root, file)}: ${hit.what} in ${hit.literal}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
