import type * as DbModule from '@drefyn/db';
import { toPublicId } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type ApiDeps } from '../src/app.ts';
import { guard } from '../src/guard.ts';
import { createJsonLogger } from '../src/log.ts';
import { GOOD, KEY_ID, ORG, PROJECT, PROJECT_PUBLIC, fakeDeps, socketEnv } from './support.ts';

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    withOrganization: (_db: unknown, _org: unknown, work: (tx: unknown) => Promise<unknown>) => {
      const chain = {
        selectFrom: () => chain,
        select: () => chain,
        where: () => chain,
        executeTakeFirst: () => Promise.resolve({ product: 'studio' }),
      };
      return work(chain);
    },
  };
});

// Values a careless log line would carry. None may reach a line in any form.
const KEY_TEXT = 'drf_ak_canarykeycanarykeycanarykey';
const BODY_TEXT = 'canary-body-text';
const ADDRESS = '198.51.100.77';
const EMAIL = 'person@example.com';

// Every field a request log line may hold. Anything new has to be added here on purpose.
const ALLOWED_FIELDS = new Set([
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'organizationId',
  'projectId',
  'keyId',
  'level',
  'event',
  'service',
]);

function capture() {
  const lines: string[] = [];
  const logger = createJsonLogger((line) => lines.push(line));
  const base = fakeDeps({ logger });
  const deps: ApiDeps = { ...base.deps, config: { ...base.deps.config, hops: 1 } };
  const app = createApp(deps);
  app.post('/v1/projects/:projectId/things', guard(deps, { scope: 'studio:content.read' }), (c) =>
    c.json({ ok: true }),
  );
  return { app, lines };
}

describe('request logs', () => {
  it('carry ids and request facts only, never keys, bodies, queries or addresses', async () => {
    const { app, lines } = capture();
    const requests: [string, RequestInit][] = [
      [`/v1/projects/${PROJECT_PUBLIC}/things?key=${KEY_TEXT}&email=${EMAIL}`, {}],
      [
        `/v1/projects/${PROJECT_PUBLIC}/things`,
        { headers: { authorization: `Bearer ${KEY_TEXT}` } },
      ],
      [`/v1/projects/${PROJECT_PUBLIC}/things`, { headers: { authorization: GOOD } }],
      [`/v1/unknown/${EMAIL}`, {}],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(
        path,
        {
          method: 'POST',
          body: JSON.stringify({ text: BODY_TEXT, email: EMAIL }),
          ...init,
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ADDRESS,
            ...(init.headers as Record<string, string> | undefined),
          },
        },
        socketEnv(),
      );
      await response.arrayBuffer();
    }
    expect(lines).toHaveLength(requests.length);
    const joined = lines.join('\n');
    for (const secret of [KEY_TEXT, BODY_TEXT, ADDRESS, EMAIL, 'Bearer', '?']) {
      expect(joined).not.toContain(secret);
    }
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const field of Object.keys(parsed)) expect(ALLOWED_FIELDS, field).toContain(field);
      expect(parsed['service']).toBe('api');
      expect(parsed['event']).toBe('api.request');
    }
  });

  it('name the tenant only once the key is proved, by public id', async () => {
    const { app, lines } = capture();
    await app.request(
      `/v1/projects/${PROJECT_PUBLIC}/things`,
      { method: 'POST', headers: { authorization: 'Bearer wrong' } },
      socketEnv(),
    );
    await app.request(
      `/v1/projects/${PROJECT_PUBLIC}/things`,
      { method: 'POST', headers: { authorization: GOOD } },
      socketEnv(),
    );
    const [refused, served] = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['event'] === 'api.request');
    expect(refused).toMatchObject({ status: 401, route: '/v1/projects/:projectId/things' });
    expect(refused).not.toHaveProperty('organizationId');
    expect(refused).not.toHaveProperty('projectId');
    expect(served).toMatchObject({
      status: 200,
      method: 'POST',
      route: '/v1/projects/:projectId/things',
      organizationId: toPublicId('org', ORG),
      projectId: toPublicId('prj', PROJECT),
      keyId: toPublicId('key', KEY_ID),
    });
  });
});

describe('createJsonLogger', () => {
  it('writes one JSON line per event at each level', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    logger.info('a.info', { n: 1 });
    logger.warn('a.warn');
    logger.error('a.error', { ok: true });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { n: 1, level: 'info', event: 'a.info', service: 'api' },
      { level: 'warn', event: 'a.warn', service: 'api' },
      { ok: true, level: 'error', event: 'a.error', service: 'api' },
    ]);
  });

  it('never lets a field stand in for the level, event or service', () => {
    const lines: string[] = [];
    createJsonLogger((line) => lines.push(line)).info('real', {
      level: 'error',
      event: 'fake',
      service: 'other',
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({ level: 'info', event: 'real', service: 'api' });
  });

  it('swallows a writer that throws', () => {
    const logger = createJsonLogger(() => {
      throw new Error('disk full');
    });
    expect(() => {
      logger.warn('x');
    }).not.toThrow();
  });

  it('writes to stderr by default', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createJsonLogger().info('to.stderr');
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ level: 'info', event: 'to.stderr', service: 'api' })}\n`,
    );
  });
});
