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

// Every source file, in subfolders too, relative to src.
function sourceFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.ts') ? [`${prefix}${entry.name}`] : [];
  });
}

function specifiers(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map((f) => f.fileName);
}

describe('package layout', () => {
  it('has a server entry, the operator command entry and a pure permissions entry, and marks the last as pure', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './command': './src/command.ts',
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

  // The database is reached only through @drefyn/db's context bound functions, and only by
  // the limiter, the session files, organizations, invitations, devices, email sign in, email
  // change, password sign in, password account, OAuth and API keys. The OAuth fetch file
  // calls the platform fetch, which the egress rule scopes. Files are read only by the
  // breached list lookup and its build command, and the build command is the only writer.
  it('reaches the database only from the limiter, sessions, organizations, invitations, roles, devices, email sign in, email change, password sign in, password account, OAuth and API keys, files only from the breached list, and no network anywhere', () => {
    const database = /^(@drefyn\/db|kysely)$/;
    const files = /^node:fs\/promises$/;
    const allowed: Readonly<Record<string, RegExp>> = {
      'rate-limiter.ts': database,
      'sessions.ts': database,
      'session-support.ts': database,
      'step-up.ts': database,
      'organizations.ts': database,
      'invitations.ts': database,
      'roles.ts': database,
      'email-sign-in.ts': database,
      'email-change.ts': database,
      'devices.ts': database,
      'password-sign-in.ts': database,
      'password-account.ts': database,
      'oauth.ts': database,
      'api-keys.ts': database,
      'api-key-verifier.ts': database,
      'breached-file.ts': files,
      'password-list.ts': files,
    };
    const sources = sourceFiles(src);
    expect(sources).toContain('oauth/fetch.ts');
    for (const file of sources) {
      for (const spec of specifiers(join(src, file))) {
        if (allowed[file]?.test(spec) === true) continue;
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /^(@drefyn\/db|pg|kysely$|node:(fs|net|http|https|dns|child_process|tls))/,
        );
      }
    }
  });
});

describe('the main entry', () => {
  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual(
      [
        'ARGON2_FLOOR',
        'AUTH_CONFIG_KEYS',
        'ApiKeyReplayError',
        'AuthError',
        'BREACHED_RECORD_BYTES',
        'BREACH_CHECK_TIMEOUT_MS',
        'PasswordListError',
        'loadBreachedPasswords',
        'breachedDigest',
        'buildPasswordList',
        'openBreachedPasswordFile',
        'MANAGEMENT_PERMISSIONS',
        'SCOPE_PATTERN',
        'apiKeyErrorResponse',
        'checkApiKeyScope',
        'createApiKeyVerifier',
        'createApiKeys',
        'createScopeRegistry',
        'createOAuth',
        'DEVICES_PER_USER',
        'DEVICE_MAX_AGE_SECONDS',
        'NEW_DEVICE_AFTER_DAYS',
        'SESSIONS_PAGE_PLACEHOLDER_PATH',
        'INVITE_MAX_AGE_SECONDS',
        'KEYBOARD_ROWS',
        'KEY_PURPOSES',
        'ORG_ROLES',
        'PASSWORD_FORM_MAX_BYTES',
        'PASSWORD_MAX_BYTES',
        'PASSWORD_MAX_CHARACTERS',
        'PASSWORD_MIN_CHARACTERS',
        'PASSWORD_RAW_MAX_BYTES',
        'PASSWORD_RULES',
        'PERMISSIONS',
        'PRE_MAX_AGE_SECONDS',
        'PROJECT_ROLES',
        'RATE_BUCKETS',
        'REDACTED',
        'RESERVED_SLUGS',
        'SIGN_IN_CODE_PURPOSES',
        'SLUG_PATTERN',
        'SecretValue',
        'canAssign',
        'canChangeRole',
        'canRemove',
        'checkCommonPassword',
        'checkNewPassword',
        'constantTimeEqual',
        'cookieNames',
        'countSeats',
        'createApiKeyFailureLimiter',
        'createCodeIssuer',
        'createEmailChange',
        'createEmailSignIn',
        'createInvitations',
        'createOrganizations',
        'createRoles',
        'createPasswordAccount',
        'createPasswordHasher',
        'createPasswordSignIn',
        'createRateLimiter',
        'createSessions',
        'decodeSecret',
        'deriveAuthKeys',
        'deviceHash',
        'encodeSecret',
        'formatApiKey',
        'formatChallengeId',
        'formatInvitationToken',
        'formatPhc',
        'formatSessionToken',
        'formatVerifyFragment',
        'lengthPrefixed',
        'normalizeAddress',
        'normalizePassword',
        'parseApiAuthConfig',
        'parseApiKey',
        'parseAuthConfig',
        'parseBearer',
        'parseChallengeId',
        'parseCode',
        'parseInvitationToken',
        'parseOrganizationName',
        'parsePhc',
        'parseSessionToken',
        'parseSignInCodePurpose',
        'parseSlug',
        'parseVerifyFragment',
        'permissionsFor',
        'rateKeyForIp',
        'newDeviceNotice',
        'readPasswordSignInForm',
        'recordDevice',
        'redact',
        'redactText',
        'safeReturnTo',
        'serializeCookie',
        'sessionCookieValue',
        'sha256',
        'userAgentFamily',
      ].sort(),
    );
  });

  it('exports exactly the permission model from the pure entry', () => {
    expect(Object.keys(permissions).sort()).toEqual(
      [
        'ORG_ROLES',
        'PERMISSIONS',
        'PROJECT_ROLES',
        'canAssign',
        'canChangeRole',
        'canRemove',
        'permissionsFor',
      ].sort(),
    );
  });
});
