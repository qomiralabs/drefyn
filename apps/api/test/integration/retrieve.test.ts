import { createApiKeyFailureLimiter, createApiKeyVerifier, parseApiAuthConfig } from '@drefyn/auth';
import type { FlagClient } from '@drefyn/flags';
import { createRetrieval, DEFAULT_RETRIEVAL_CONFIG, publishedReader } from '@drefyn/retrieval';
import { toPublicId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type ApiDeps, type ApiEnv } from '../../src/app.ts';
import { createJsonLogger } from '../../src/log.ts';
import { mountRetrieval } from '../../src/retrieve.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import { seedDocs, type SeededChunks } from './support/pages.ts';

const fresh = harness();
let h: Harness;
let app: Hono<ApiEnv>;

let orgA: OrganizationId;
let orgB: OrganizationId;
let docsA: ProjectId;
let docsA2: ProjectId;
let emptyA: ProjectId;
let studioA: ProjectId;
let docsB: ProjectId;
let seededA: SeededChunks;
let seededB: SeededChunks;

let readA: string;
let publishOnlyA: string;
let studioReadA: string;
let listedA: string;
let revokedA: string;
let expiredA: string;
let readB: string;

let flagOn = true;
const lines: string[] = [];

// Words that sit on exactly one kind of page, so a hit names where it came from.
const SHARED = 'gateway';
const PROTECTED = 'membersonlyword';
const DRAFT = 'unpublishedword';
const OLD = 'replacedword';
// The question canary: in a query, never in a log.
const QUESTION = 'canaryquestion';

let addresses = 0;
function nextIp(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

interface Hit {
  readonly chunkId: string;
  readonly text: string;
}

async function retrieve(project: ProjectId, query: string, key?: string) {
  const response = await app.request(
    `/v1/projects/${toPublicId('prj', project)}/retrieve${query}`,
    { headers: key === undefined ? {} : { authorization: `Bearer ${key}` } },
    { incoming: { socket: { remoteAddress: nextIp() } } },
  );
  const body = (await response.json()) as {
    error?: { code: string };
    hits?: readonly Hit[];
    pin?: { version: string; publishedAt: string };
  };
  return { status: response.status, code: body.error?.code, body, response };
}

const q = (words: string, extra = '') => `?query=${encodeURIComponent(words)}${extra}`;

describeWithStack('/v1 retrieval against Postgres with real keys', () => {
  beforeAll(async () => {
    h = await fresh();
    orgA = await h.organization();
    orgB = await h.organization();
    docsA = await h.project(orgA, 'docs');
    docsA2 = await h.project(orgA, 'docs');
    emptyA = await h.project(orgA, 'docs');
    studioA = await h.project(orgA, 'studio');
    docsB = await h.project(orgB, 'docs');

    seededA = await seedDocs(h.sql, h.db, orgA, docsA, [
      {
        slug: 'install',
        versions: [
          { state: 'old', bodies: [`${OLD} ${SHARED} earlier install text`] },
          { state: 'current', bodies: [`${SHARED} install with docker`, `${SHARED} ports`] },
        ],
      },
      {
        slug: 'members',
        versions: [
          { state: 'current', visibility: 'protected', bodies: [`${PROTECTED} ${SHARED} keys`] },
        ],
      },
      {
        slug: 'next',
        versions: [
          { state: 'current', bodies: [`${SHARED} upgrade notes`] },
          { state: 'draft', bodies: [`${DRAFT} ${SHARED} not yet`] },
        ],
      },
    ]);
    await seedDocs(h.sql, h.db, orgA, docsA2, [
      { slug: 'sibling', versions: [{ state: 'current', bodies: [`${SHARED} sibling text`] }] },
    ]);
    seededB = await seedDocs(h.sql, h.db, orgB, docsB, [
      { slug: 'theirs', versions: [{ state: 'current', bodies: [`${SHARED} their text`] }] },
    ]);

    readA = await h.key(orgA, ['docs:pages.read']);
    publishOnlyA = await h.key(orgA, ['docs:pages.publish']);
    studioReadA = await h.key(orgA, ['studio:content.read']);
    listedA = await h.key(orgA, ['docs:pages.read'], [docsA2]);
    revokedA = await h.key(orgA, ['docs:pages.read']);
    expiredA = await h.key(orgA, ['docs:pages.read']);
    readB = await h.key(orgB, ['docs:pages.read']);
    await h.sql(
      `update app.api_keys set revoked_at = now() where display_suffix = '${revokedA.slice(-4)}';
       update app.api_keys set expires_at = now() - interval '1 minute'
        where display_suffix = '${expiredA.slice(-4)}';`,
    );

    const env = h.env;
    const logger = createJsonLogger((line) => lines.push(line));
    const failures = createApiKeyFailureLimiter({ db: h.db, config: parseApiAuthConfig(env) });
    const flags: FlagClient = {
      isOn: () => Promise.resolve(flagOn),
      evaluate: () =>
        Promise.resolve({ value: flagOn, reason: 'STATIC', flagKey: 'retrieval.v1' } as never),
      close: () => Promise.resolve(),
    };
    const deps: ApiDeps = {
      db: h.db,
      published: h.published,
      keys: createApiKeyVerifier(env, { db: h.db, limiter: failures, logger }),
      failures,
      flags,
      logger,
      config: { hops: 0, viewerHeader: false, maxBodyBytes: 1024 },
    };
    app = createApp(deps);
    mountRetrieval(
      app,
      deps,
      createRetrieval({
        reader: publishedReader(h.published),
        config: DEFAULT_RETRIEVAL_CONFIG,
        flags,
        logger,
      }),
    );
  });

  it('answers with ranked public text from the key project, pinned to latest', async () => {
    const result = await retrieve(docsA, q(`${SHARED} install`), readA);
    expect(result.status).toBe(200);
    expect(result.response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(result.body.pin?.version).toBe('latest');
    const ids = (result.body.hits ?? []).map((hit) => hit.chunkId);
    expect(ids.length).toBe(seededA.current.length);
    expect([...ids].sort()).toEqual([...seededA.current].sort());
    for (const hit of result.body.hits ?? []) expect(hit.text).not.toMatch(/[<>]/);
  });

  it('honours the limit', async () => {
    const result = await retrieve(docsA, q(SHARED, '&limit=1'), readA);
    expect(result.status).toBe(200);
    expect(result.body.hits).toHaveLength(1);
  });

  describe('protected pages, drafts and replaced versions', () => {
    it('are never returned, even when asked for by their own words', async () => {
      for (const word of [PROTECTED, DRAFT, OLD]) {
        const result = await retrieve(docsA, q(word), readA);
        expect(result.status, word).toBe(200);
        expect(result.body.hits, word).toEqual([]);
      }
      const all = await retrieve(docsA, q(`${SHARED} ${PROTECTED} ${DRAFT} ${OLD}`), readA);
      for (const hit of all.body.hits ?? []) {
        expect(seededA.other).not.toContain(hit.chunkId);
        expect(hit.text).not.toMatch(new RegExp(`${PROTECTED}|${DRAFT}|${OLD}`));
      }
    });
  });

  describe('keys', () => {
    it('a key without the docs read scope gets 403', async () => {
      for (const key of [publishOnlyA, studioReadA]) {
        const result = await retrieve(docsA, q(SHARED), key);
        expect(result.status).toBe(403);
        expect(result.code).toBe('auth.api_key_scope');
      }
    });

    it('a key listed for another project of its organization gets 403', async () => {
      expect((await retrieve(docsA2, q(SHARED), listedA)).status).toBe(200);
      const result = await retrieve(docsA, q(SHARED), listedA);
      expect(result.status).toBe(403);
      expect(result.code).toBe('auth.api_key_scope');
    });

    it('a key for another organization gets 404, the same as a missing project', async () => {
      const foreign = await retrieve(docsB, q(SHARED), readA);
      expect(foreign.status).toBe(404);
      expect(foreign.code).toBe('api.not_found');
      const back = await retrieve(docsA, q(SHARED), readB);
      expect(back.status).toBe(404);
      const missing = await retrieve(
        '01a14984-4476-77ce-9335-2c3c3a59ffff' as ProjectId,
        q(SHARED),
        readA,
      );
      expect(missing.body).toEqual(foreign.body);
    });

    it('a studio project of the same organization gets 404', async () => {
      expect((await retrieve(studioA, q(SHARED), readA)).status).toBe(404);
    });

    it('revoked and expired keys get 401', async () => {
      for (const key of [revokedA, expiredA]) {
        const result = await retrieve(docsA, q(SHARED), key);
        expect(result.status).toBe(401);
        expect(result.code).toBe('auth.api_key_invalid');
      }
    });

    it('counts every refusal against the client', async () => {
      const before = await h.failures();
      await retrieve(docsA, q(SHARED), publishOnlyA);
      await retrieve(docsB, q(SHARED), readA);
      await retrieve(docsA, q(SHARED), revokedA);
      expect(await h.failures()).toBe(before + 3);
    });
  });

  describe('tenancy across two organizations', () => {
    it('each key reads only its own project, never the other organization', async () => {
      const a = await retrieve(docsA, q(SHARED, '&limit=20'), readA);
      const b = await retrieve(docsB, q(SHARED, '&limit=20'), readB);
      const aIds = (a.body.hits ?? []).map((hit) => hit.chunkId);
      const bIds = (b.body.hits ?? []).map((hit) => hit.chunkId);
      expect([...aIds].sort()).toEqual([...seededA.current].sort());
      expect([...bIds].sort()).toEqual([...seededB.current].sort());
    });
  });

  describe('versions', () => {
    it('an unknown version is 404 retrieval.version_not_found', async () => {
      const result = await retrieve(docsA, q(SHARED, '&version=v9'), readA);
      expect(result.status).toBe(404);
      expect(result.code).toBe('retrieval.version_not_found');
    });

    it('a project with nothing published has no latest: 404 retrieval.version_not_found', async () => {
      const result = await retrieve(emptyA, q(SHARED), readA);
      expect(result.status).toBe(404);
      expect(result.code).toBe('retrieval.version_not_found');
    });
  });

  describe('request validation', () => {
    it('refuses bad parameters with 400 retrieval.bad_input', async () => {
      for (const query of [
        '',
        '?query=',
        q(SHARED, '&limit=0'),
        q(SHARED, '&limit=21'),
        q(SHARED, '&limit=x'),
        q('a'.repeat(513)),
        q(SHARED, '&unknown=1'),
      ]) {
        const result = await retrieve(docsA, query, readA);
        expect(result.status, query.slice(0, 40)).toBe(400);
        expect(result.code).toBe('retrieval.bad_input');
      }
    });

    it('a question of only punctuation has no hits, not an error', async () => {
      const result = await retrieve(docsA, q('?!'), readA);
      expect(result.status).toBe(200);
      expect(result.body.hits).toEqual([]);
    });
  });

  describe('plan', () => {
    it('Free gets 403 api.not_entitled, Growth is served', async () => {
      await h.sql(
        `update app.organizations set plan_tier = 'free' where organization_id = '${orgA}';`,
      );
      try {
        const refused = await retrieve(docsA, q(SHARED), readA);
        expect(refused.status).toBe(403);
        expect(refused.code).toBe('api.not_entitled');
        await h.sql(
          `update app.organizations set plan_tier = 'growth' where organization_id = '${orgA}';`,
        );
        expect((await retrieve(docsA, q(SHARED), readA)).status).toBe(200);
      } finally {
        await h.sql(
          `update app.organizations set plan_tier = 'self_hosted' where organization_id = '${orgA}';`,
        );
      }
    });
  });

  describe('release flag', () => {
    it('off is 404 api.not_found, on is served', async () => {
      flagOn = false;
      try {
        const off = await retrieve(docsA, q(SHARED), readA);
        expect(off.status).toBe(404);
        expect(off.code).toBe('api.not_found');
      } finally {
        flagOn = true;
      }
      expect((await retrieve(docsA, q(SHARED), readA)).status).toBe(200);
    });
  });

  it('answers 503 retrieval.unavailable when the reader cannot reach Postgres', async () => {
    const restore = await h.cutOff('reader');
    try {
      const result = await retrieve(docsA, q(SHARED), readA);
      expect(result.status).toBe(503);
      expect(result.code).toBe('retrieval.unavailable');
      expect(result.response.headers.get('retry-after')).toBe('1');
    } finally {
      await restore();
    }
  });

  it('logs ids, never the question or any page text', async () => {
    await retrieve(docsA, q(`${QUESTION} ${SHARED}`), readA);
    await retrieve(docsA, q(QUESTION, '&version=v9'), readA);
    await retrieve(docsA, q(QUESTION), publishOnlyA);
    expect(lines.length).toBeGreaterThan(0);
    const leaks = [QUESTION, SHARED, PROTECTED, DRAFT, OLD, 'install', 'docker'];
    for (const line of lines) {
      for (const word of leaks) expect(line).not.toContain(word);
    }
    const retrievalLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['event'] === 'retrieval.request');
    expect(retrievalLines.length).toBeGreaterThan(0);
    const known = new Set<string>([orgA, orgB, docsA, docsA2, emptyA, docsB]);
    for (const line of retrievalLines) {
      expect(known).toContain(line['organizationId']);
      expect(known).toContain(line['projectId']);
    }
  });
});
