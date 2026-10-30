import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';
import * as testing from '../src/testing.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
  string,
  unknown
> & { exports: Record<string, string> };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(src);

function specifiers(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map((f) => f.fileName);
}

const dependencyNames = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
].flatMap((field) => Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}));

describe('open core', () => {
  it('has no resend package in the manifest', () => {
    expect(dependencyNames.filter((name) => /resend/i.test(name))).toEqual([]);
    expect(JSON.stringify(manifest)).not.toMatch(/resend/i);
  });

  it('has no resend import or mention in source', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(root, file)).not.toMatch(/resend/i);
    }
  });

  it('never writes raw HTML from React', () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toContain(
        'dangerouslySetInnerHTML',
      );
    }
  });

  it('keeps nodemailer to its one wrapper file', () => {
    for (const file of files) {
      const rel = relative(root, file);
      if (rel === join('src', 'smtp', 'nodemailer.ts')) continue;
      for (const spec of specifiers(file)) expect(spec, rel).not.toMatch(/^nodemailer/);
    }
  });

  it('does not depend on auth or the React UI entry', () => {
    expect(dependencyNames).not.toContain('@drefyn/auth');
    for (const file of files) {
      for (const spec of specifiers(file)) {
        expect(spec, relative(root, file)).not.toMatch(/^@drefyn\/(auth|ui\/react)/);
        expect(spec, relative(root, file)).not.toMatch(
          /^node:(net|tls|dns|http|https|http2|dgram)$/,
        );
      }
    }
  });

  it('pins every npm dependency exactly', () => {
    const deps = (manifest['dependencies'] as Record<string, string> | undefined) ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (range.startsWith('workspace:')) continue;
      expect(range, name).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    }
    expect(deps['@react-email/render']).toBe('2.1.1');
  });
});

describe('package entries', () => {
  it('has a server entry and a testing entry', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './testing': './src/testing.ts',
      './package.json': './package.json',
    });
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual(
      [
        'EMAIL_CONFIG_KEYS',
        'LINK_PROVIDERS',
        'SECURITY_NOTICE_KINDS',
        'SIGN_IN_CODE_PURPOSES',
        'createMailer',
        'isHeaderSafe',
        'logEmailConfig',
        'parseEmailConfig',
        'renderMail',
      ].sort(),
    );
    expect(Object.keys(testing)).toEqual(['createTestTransport']);
  });

  it('freezes the exported lists', () => {
    expect(Object.isFrozen(main.SIGN_IN_CODE_PURPOSES)).toBe(true);
    expect(Object.isFrozen(main.SECURITY_NOTICE_KINDS)).toBe(true);
    expect(Object.isFrozen(main.LINK_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(main.EMAIL_CONFIG_KEYS)).toBe(true);
    expect(main.SIGN_IN_CODE_PURPOSES).toHaveLength(6);
    expect(main.SECURITY_NOTICE_KINDS).toHaveLength(11);
  });
});
