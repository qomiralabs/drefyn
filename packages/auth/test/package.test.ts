import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';
import * as permissions from '../src/permissions.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
  drefyn?: { pureEntries?: string[] };
  dependencies?: Record<string, string>;
};

function specifiers(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map((f) => f.fileName);
}

describe('package layout', () => {
  it('has a server entry and a pure permissions entry, and marks the second as pure', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './permissions': './src/permissions.ts',
      './package.json': './package.json',
    });
    expect(manifest.drefyn?.pureEntries).toEqual(['./permissions']);
  });

  it('pins every npm dependency exactly', () => {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue;
      expect(range, name).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    }
  });

  it('keeps the permissions entry free of imports other than types', () => {
    const text = readFileSync(join(src, 'permissions.ts'), 'utf8');
    for (const spec of specifiers(join(src, 'permissions.ts'))) {
      expect(spec).not.toMatch(/^node:/);
    }
    expect(text).not.toMatch(/^import (?!type )/m);
  });

  it('has no database, network or file access anywhere in src', () => {
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      for (const spec of specifiers(join(src, file))) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /^(@drefyn\/db|pg|node:(fs|net|http|https|dns|child_process|tls))/,
        );
      }
    }
  });
});

describe('the main entry', () => {
  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual(
      [
        'AUTH_CONFIG_KEYS',
        'AuthError',
        'KEYBOARD_ROWS',
        'KEY_PURPOSES',
        'ORG_ROLES',
        'PASSWORD_RULES',
        'PERMISSIONS',
        'PROJECT_ROLES',
        'RATE_BUCKETS',
        'REDACTED',
        'SecretValue',
        'canAssign',
        'checkCommonPassword',
        'constantTimeEqual',
        'cookieNames',
        'createApiKeyFailureLimiter',
        'createRateLimiter',
        'decodeSecret',
        'deriveAuthKeys',
        'encodeSecret',
        'formatApiKey',
        'formatInvitationToken',
        'formatSessionToken',
        'formatVerifyFragment',
        'lengthPrefixed',
        'normalizeAddress',
        'parseApiAuthConfig',
        'parseApiKey',
        'parseAuthConfig',
        'parseBearer',
        'parseCode',
        'parseInvitationToken',
        'parseSessionToken',
        'parseVerifyFragment',
        'permissionsFor',
        'rateKeyForIp',
        'redact',
        'redactText',
        'safeReturnTo',
        'sha256',
      ].sort(),
    );
  });

  it('exports exactly the permission model from the pure entry', () => {
    expect(Object.keys(permissions).sort()).toEqual(
      ['ORG_ROLES', 'PERMISSIONS', 'PROJECT_ROLES', 'canAssign', 'permissionsFor'].sort(),
    );
  });
});
