import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import type { TypesenseAnswer, TypesenseCall, TypesenseClient } from '../src/client.ts';
import type { LogFields, SearchLogger } from '../src/log.ts';
import { parseSearchPin, type SearchPin } from '../src/pin.ts';

export function pinOf(version: string, locale: string): SearchPin {
  const pin = parseSearchPin({ version, locale });
  if (pin === null) throw new Error(`bad pin in test: ${version} ${locale}`);
  return pin;
}

export const TENANT_A: TenantRef = Object.freeze({
  organizationId: organizationId('0190a3c4-1111-7000-8000-00000000000a'),
  projectId: projectId('0190a3c4-2222-7000-8000-00000000000a'),
});

export const TENANT_B: TenantRef = Object.freeze({
  organizationId: organizationId('0190a3c4-1111-7000-8000-00000000000b'),
  projectId: projectId('0190a3c4-2222-7000-8000-00000000000b'),
});

export const NODE_1 = '0190a3c4-3333-7000-8000-000000000001';
export const VERSION_1 = '0190a3c4-4444-7000-8000-000000000001';

export interface ScriptedClient extends TypesenseClient {
  readonly calls: TypesenseCall[];
}

// Answers each call from the script in order, and records what was asked.
export function scriptedClient(
  ...answers: (TypesenseAnswer | Error | ((call: TypesenseCall) => TypesenseAnswer))[]
): ScriptedClient {
  const calls: TypesenseCall[] = [];
  return {
    calls,
    call(request) {
      calls.push(request);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('no scripted answer left'));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(typeof next === 'function' ? next(request) : next);
    },
  };
}

export interface CapturedLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
}

export function captureLogger(): SearchLogger & { readonly lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const at =
    (level: CapturedLine['level']) =>
    (event: string, fields: LogFields = {}) => {
      lines.push({ level, event, fields });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

// What a scoped key carries, read back the way Typesense does.
export function decodeScopedKey(key: string): { digest: string; prefix: string; params: unknown } {
  const raw = Buffer.from(key, 'base64').toString('utf8');
  return { digest: raw.slice(0, 44), prefix: raw.slice(44, 48), params: JSON.parse(raw.slice(48)) };
}

export const json = (status: number, body: unknown): TypesenseAnswer => ({
  status,
  text: JSON.stringify(body),
});
