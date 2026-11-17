import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { createTypesenseClient, type TypesenseClient } from '../../../src/client.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');

function envFile(): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(join(repoRoot, 'deploy', '.env'), 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

// The compose stack's Typesense, started with COMPOSE_PROFILES=search. The admin key comes from
// the environment or deploy/.env, as scripts/selfhost.sh wrote it.
export function stack(): { url: string; adminKey: string } {
  const file = envFile();
  const port = process.env['DREFYN_TYPESENSE_PORT'] ?? file['DREFYN_TYPESENSE_PORT'] ?? '58108';
  const adminKey = process.env['DREFYN_SEARCH_ADMIN_KEY'] ?? file['DREFYN_SEARCH_ADMIN_KEY'] ?? '';
  return { url: process.env['DREFYN_TYPESENSE_URL'] ?? `http://127.0.0.1:${port}`, adminKey };
}

// Why the suite cannot run, or null when it can. In CI a missing stack fails the run instead.
export async function absence(): Promise<string | null> {
  const { url, adminKey } = stack();
  let reason: string | null = null;
  if (adminKey === '') reason = 'no DREFYN_SEARCH_ADMIN_KEY in the environment or deploy/.env';
  else {
    const client = createTypesenseClient({ url, attempts: 1 });
    try {
      const health = await client.call({
        method: 'GET',
        path: '/health',
        key: adminKey,
        idempotent: true,
      });
      if (health.status !== 200) reason = `Typesense health answered ${String(health.status)}`;
    } catch {
      reason = `Typesense is not reachable at ${url}`;
    }
  }
  if (reason !== null && process.env['CI'] !== undefined) throw new Error(reason);
  return reason;
}

export function adminClient(): TypesenseClient {
  return createTypesenseClient({ url: stack().url });
}

export function newTenant(): TenantRef {
  return { organizationId: organizationId(randomUUID()), projectId: projectId(randomUUID()) };
}

export const newKeyValue = () => randomBytes(24).toString('hex');

interface KeyRow {
  readonly id: number;
  readonly value_prefix: string;
  readonly description: string;
}

export async function keyIds(client: TypesenseClient, adminKey: string): Promise<KeyRow[]> {
  const answer = await client.call({
    method: 'GET',
    path: '/keys',
    key: adminKey,
    idempotent: true,
  });
  return (JSON.parse(answer.text) as { keys: KeyRow[] }).keys;
}

// Typesense lists only the first four characters of a key, which is enough to find the one a
// test made among keys made before it.
export async function keyIdsFor(
  client: TypesenseClient,
  adminKey: string,
  value: string,
  before: ReadonlySet<number>,
): Promise<number[]> {
  return (await keyIds(client, adminKey))
    .filter((key) => !before.has(key.id) && key.value_prefix === value.slice(0, 4))
    .map((key) => key.id);
}

export async function deleteKey(client: TypesenseClient, adminKey: string, id: number) {
  await client.call({
    method: 'DELETE',
    path: `/keys/${String(id)}`,
    key: adminKey,
    idempotent: true,
  });
}
