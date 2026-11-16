import { AuthError, type ApiKeyActor, type ApiKeyVerifier, type ApiRequest } from '@drefyn/auth';
import type { Database, PublishedDatabase } from '@drefyn/db';
import type { FlagClient } from '@drefyn/flags';
import { idOf, organizationId, projectId, toPublicId } from '@drefyn/tenancy';
import { vi } from 'vitest';
import type { ApiDeps } from '../src/app.ts';
import type { LogFields } from '../src/log.ts';

export const ORG = organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b');
export const OTHER_ORG = organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8f');
export const PROJECT = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c');
export const OTHER_PROJECT = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8d');
export const DOCS_PROJECT = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8e');
// On its own line: next to the word key, a uuid reads to the secret scanner as a credential.
const ACTOR_UUID = '01a14984-4476-77ce-9335-2c3c3a59aa90';
export const KEY_ID = idOf('key', ACTOR_UUID);
export const PROJECT_PUBLIC = toPublicId('prj', PROJECT);

export const SOCKET_IP = '203.0.113.5';

export const GOOD = 'Bearer good';
export const LISTED = 'Bearer listed';

export function actor(over: Partial<ApiKeyActor> = {}): ApiKeyActor {
  return {
    kind: 'api_key',
    keyId: KEY_ID,
    organizationId: ORG,
    scopes: ['studio:content.read'],
    projectIds: 'all',
    ...over,
  };
}

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
}

// Keys answer by header: GOOD is a key for every project of ORG with read, LISTED reaches only
// OTHER_PROJECT, anything else is refused the way the verifier refuses.
export function fakeKeys(answers: Partial<Record<string, ApiKeyActor>> = {}) {
  const seen: ApiRequest[] = [];
  const table: Partial<Record<string, ApiKeyActor>> = {
    [GOOD]: actor(),
    [LISTED]: actor({ projectIds: [OTHER_PROJECT] }),
    ...answers,
  };
  const keys: ApiKeyVerifier = {
    verifyApiKey: () => Promise.reject(new Error('the guard reads whole requests')),
    verifyApiRequest: (request) => {
      seen.push(request);
      const found = request.authorization === undefined ? undefined : table[request.authorization];
      return Promise.resolve(
        found === undefined
          ? { ok: false, error: new AuthError('AUTH_API_KEY_INVALID') }
          : { ok: true, value: found },
      );
    },
  };
  return { keys, seen };
}

export function fakeDeps(over: Partial<ApiDeps> = {}) {
  const logs: LogLine[] = [];
  const reserve = vi.fn<(clientKey: string) => Promise<void>>(() => Promise.resolve());
  const isOn = vi.fn<FlagClient['isOn']>(() => Promise.resolve(true));
  const { keys, seen } = fakeKeys();
  const deps: ApiDeps = {
    db: Object.freeze({}) as Database,
    published: Object.freeze({}) as PublishedDatabase,
    keys,
    failures: { reserve },
    flags: {
      isOn,
      evaluate: () => Promise.reject(new Error('not used')),
      close: () => Promise.resolve(),
    },
    logger: {
      info: (event, fields = {}) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields = {}) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields = {}) => logs.push({ level: 'error', event, fields }),
    },
    config: { hops: 0, viewerHeader: false, maxBodyBytes: 1024 },
    ...over,
  };
  return { deps, logs, reserve, isOn, seen };
}

// What @hono/node-server hands the app as its env.
// Null stands for a socket torn down before the request was read.
export function socketEnv(remoteAddress: string | null = SOCKET_IP) {
  return { incoming: { socket: { remoteAddress: remoteAddress ?? undefined } } };
}
