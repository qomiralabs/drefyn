import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as creditsPackage from '../src/index.ts';
import config from '../vitest.config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      if (/(^|\.)(require|getBuiltinModule)$/.test(callee) || callee === 'import') {
        const [arg] = node.arguments;
        found.push(arg && ts.isStringLiteralLike(arg) ? arg.text : `<computed in ${callee}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// Code only: comments may explain what the ledger is not for.
function codeText(file: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
  scanner.setText(readFileSync(file, 'utf8'));
  const parts: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    parts.push(scanner.getTokenText());
  }
  return parts.join(' ');
}

describe('package shape', () => {
  it('depends on @drefyn/tenancy and nothing else at run time', () => {
    expect(manifest.dependencies ?? {}).toEqual({ '@drefyn/tenancy': 'workspace:*' });
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it('has one public entry point', () => {
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './package.json': './package.json' });
  });

  it('imports only @drefyn/tenancy, node:crypto and its own src files', () => {
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.ts'), `${relative(root, file)} is not TypeScript`).toBe(true);
      for (const spec of specifiers(file)) {
        if (spec === '@drefyn/tenancy' || spec === 'node:crypto') continue;
        const local = spec.startsWith('./') || spec.startsWith('../');
        expect(local, `${relative(root, file)} imports '${spec}'`).toBe(true);
        expect(resolve(dirname(file), spec).startsWith(src + sep)).toBe(true);
      }
    }
  });

  it('sets line coverage to at least 95 percent in its own vitest config', () => {
    const { test } = config as { test?: { coverage?: { thresholds?: { lines?: unknown } } } };
    const lines = test?.coverage?.thresholds?.lines;
    expect(typeof lines).toBe('number');
    expect(lines).toBeGreaterThanOrEqual(95);
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(creditsPackage).sort()).toEqual(
      ['CreditError', 'ENTRY_KINDS', 'SPEND_REASONS', 'createMemoryLedger', 'credits'].sort(),
    );
  });

  // Prices, allowance sizes, purchases and Stripe are hosted only, and sends are never credits.
  it('holds no money, pricing, billing or send code', () => {
    const banned =
      /\b(cents|price|prices|pricing|currency|stripe|invoice|allowance|sms|voice|telnyx|plivo|resend)\b/i;
    for (const file of sourceFiles(src)) {
      const match = banned.exec(codeText(file));
      expect(match?.[0], `${relative(root, file)} mentions '${match?.[0] ?? ''}'`).toBeUndefined();
    }
  });

  it('uses no floating point helpers on amounts', () => {
    const banned =
      /\b(parseFloat|toFixed|toPrecision|Math\.round|Math\.floor|Math\.ceil|Math\.trunc)\b/;
    for (const file of sourceFiles(src)) {
      const match = banned.exec(codeText(file).replaceAll(' . ', '.'));
      expect(match?.[0], `${relative(root, file)} uses '${match?.[0] ?? ''}'`).toBeUndefined();
    }
  });

  it('documents the public API, the error codes and that the ledger is AI spend only', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const name of [
      'credits',
      'Credits',
      'createMemoryLedger',
      'CreditLedger',
      'CreditEntry',
      'CreditError',
      'grant',
      'spend',
      'reverse',
      'expire',
      'idempotencyKey',
      'CREDIT_AMOUNT_INVALID',
      'CREDIT_KEY_INVALID',
      'CREDIT_REASON_INVALID',
      'CREDIT_ORGANIZATION_INVALID',
      'CREDIT_IDEMPOTENCY_CONFLICT',
      'CREDIT_ENTRY_NOT_FOUND',
      'CREDIT_NOT_REVERSIBLE',
      'CREDIT_BALANCE_OVERFLOW',
    ]) {
      expect(readme, `README mentions ${name}`).toContain(name);
    }
    expect(readme).toMatch(/AI/);
    expect(readme).toMatch(/self host/i);
    expect(readme).not.toContain('One or two sentences on what this package does');
  });
});
