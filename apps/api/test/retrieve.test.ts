import type * as DbModule from '@drefyn/db';
import { flags as registry } from '@drefyn/flags';
import { toPublicId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonLogger } from '../src/log.ts';
import {
  parseRetrieveQuery,
  RETRIEVE_SCOPE,
  retrievalError,
  retrieveBody,
} from '../src/retrieve.ts';
import {
  DOCS_KEY,
  DOCS_LISTED,
  fakeRetrieval,
  PUBLISH_ONLY,
  RESULT,
  retrievalApp,
  STUDIO_KEY,
} from './retrieval-support.ts';
import { DOCS_PROJECT, KEY_ID, ORG, OTHER_PROJECT, PROJECT, socketEnv } from './support.ts';

// Projects as RLS shows them to ORG, and the plan each organization is on.
const PROJECTS = new Map<string, string>([
  [`${ORG}:${DOCS_PROJECT}`, 'docs'],
  [`${ORG}:${OTHER_PROJECT}`, 'docs'],
  [`${ORG}:${PROJECT}`, 'studio'],
]);
let tier: string | undefined = 'growth';
let planFails = false;

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    withOrganization: (
      _db: unknown,
      org: { organizationId: OrganizationId },
      work: (tx: unknown) => Promise<unknown>,
    ) => {
      let table = '';
      let id = '' as ProjectId;
      const chain = {
        selectFrom: (name: string) => {
          table = name;
          return chain;
        },
        select: () => chain,
        where: (column: string, _op: string, value: string) => {
          if (column === 'id') id = value as ProjectId;
          return chain;
        },
        executeTakeFirst: () => {
          if (table === 'organizations') {
            if (planFails) return Promise.reject(new Error('connection terminated'));
            return Promise.resolve(tier === undefined ? undefined : { plan_tier: tier });
          }
          const product = PROJECTS.get(`${org.organizationId}:${id}`);
          return Promise.resolve(product === undefined ? undefined : { product });
        },
      };
      return work(chain);
    },
  };
});

beforeEach(() => {
  tier = 'growth';
  planFails = false;
});

const DOCS_PUBLIC = toPublicId('prj', DOCS_PROJECT);
const path = (query: string, project = DOCS_PUBLIC) => `/v1/projects/${project}/retrieve${query}`;

async function get(
  app: ReturnType<typeof retrievalApp>['app'],
  url: string,
  // Null sends no key at all.
  key: string | null = DOCS_KEY,
) {
  const response = await app.request(
    url,
    { headers: key === null ? {} : { authorization: key } },
    socketEnv(),
  );
  const body = (await response.json()) as { error?: { code: string } } & Record<string, unknown>;
  return { status: response.status, code: body.error?.code, body, response };
}

const params = (text: string) => new URLSearchParams(text);

describe('parseRetrieveQuery', () => {
  it('reads query, version and limit', () => {
    expect(parseRetrieveQuery(params('query=install&version=latest&limit=5'))).toEqual({
      query: 'install',
      version: 'latest',
      limit: 5,
    });
    expect(parseRetrieveQuery(params('query=how%20do%20I%20install'))).toEqual({
      query: 'how do I install',
    });
  });

  it('refuses a missing, empty or overlong query', () => {
    expect(parseRetrieveQuery(params(''))).toBeNull();
    expect(parseRetrieveQuery(params('query='))).toBeNull();
    expect(parseRetrieveQuery(params(`query=${'a'.repeat(2049)}`))).toBeNull();
    expect(parseRetrieveQuery(params(`query=${'a'.repeat(2048)}`))).not.toBeNull();
  });

  it('refuses a limit that is not a whole number from 1 to 20', () => {
    for (const limit of ['0', '21', '-1', '1.5', '1e1', '0x5', ' 5', '05', '', 'five', '100']) {
      expect(parseRetrieveQuery(params(`query=a&limit=${encodeURIComponent(limit)}`)), limit).toBe(
        null,
      );
    }
    for (const limit of [1, 9, 10, 20]) {
      expect(parseRetrieveQuery(params(`query=a&limit=${String(limit)}`))?.limit).toBe(limit);
    }
  });

  it('refuses an empty or overlong version', () => {
    expect(parseRetrieveQuery(params('query=a&version='))).toBeNull();
    expect(parseRetrieveQuery(params(`query=a&version=${'v'.repeat(101)}`))).toBeNull();
    expect(parseRetrieveQuery(params(`query=a&version=${'v'.repeat(100)}`))?.version).toBe(
      'v'.repeat(100),
    );
  });

  // A repeated or unknown parameter is a client bug; guessing which one it meant hides it.
  it('refuses repeated and unknown parameters', () => {
    expect(parseRetrieveQuery(params('query=a&query=b'))).toBeNull();
    expect(parseRetrieveQuery(params('query=a&limit=2&limit=3'))).toBeNull();
    expect(parseRetrieveQuery(params('query=a&pathPrefix=/guides'))).toBeNull();
    expect(parseRetrieveQuery(params('query=a&q=b'))).toBeNull();
  });

  it('never throws, and anything it accepts fits the library input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('query', 'version', 'limit', 'other'),
            fc.string({ maxLength: 40 }),
          ),
          { maxLength: 4 },
        ),
        (pairs) => {
          const parsed = parseRetrieveQuery(new URLSearchParams(pairs));
          if (parsed === null) return;
          expect(parsed.query.length).toBeGreaterThan(0);
          if (parsed.limit !== undefined) {
            expect(Number.isInteger(parsed.limit)).toBe(true);
            expect(parsed.limit).toBeGreaterThanOrEqual(1);
            expect(parsed.limit).toBeLessThanOrEqual(20);
          }
        },
      ),
    );
  });
});

describe('retrievalError', () => {
  it('maps each library code to one status and code', () => {
    const mapped = Object.fromEntries(
      (
        [
          'retrieval.bad_input',
          'retrieval.version_not_found',
          'retrieval.not_found',
          'retrieval.busy',
          'retrieval.unavailable',
        ] as const
      ).map((code) => {
        const error = retrievalError(code);
        return [code, `${String(error.status)} ${error.code}`];
      }),
    );
    expect(mapped).toEqual({
      'retrieval.bad_input': '400 retrieval.bad_input',
      'retrieval.version_not_found': '404 retrieval.version_not_found',
      // The library says not_found when its flag is off: the route then does not exist.
      'retrieval.not_found': '404 api.not_found',
      'retrieval.busy': '503 retrieval.busy',
      'retrieval.unavailable': '503 retrieval.unavailable',
    });
  });
});

describe('retrieveBody', () => {
  it('copies the public fields only, so nothing internal can ride along', () => {
    const [hit] = RESULT.hits;
    if (hit === undefined) throw new Error('fixture has a hit');
    const widened = {
      ...RESULT,
      coverage: 0.9,
      hits: [{ ...hit, score: 12.5, body: '<p>html</p>' }],
    };
    expect(retrieveBody(widened)).toEqual(RESULT);
  });
});

describe('GET /v1/projects/:projectId/retrieve', () => {
  it('answers a docs read key with the hits as JSON, never HTML', async () => {
    const { app, calls } = retrievalApp();
    const result = await get(app, path('?query=install&limit=3'));
    expect(result.status).toBe(200);
    expect(result.body).toEqual(RESULT);
    expect(result.response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual([
      {
        tenant: { organizationId: ORG, projectId: DOCS_PROJECT },
        input: { query: 'install', limit: 3 },
      },
    ]);
  });

  it('checks the docs read scope', () => {
    expect(RETRIEVE_SCOPE).toBe('docs:pages.read');
  });

  it('refuses a key without the scope with 403 and never reads', async () => {
    const { app, retrieve, reserve } = retrievalApp();
    for (const key of [PUBLISH_ONLY, STUDIO_KEY]) {
      const result = await get(app, path('?query=install'), key);
      expect(result.status, key).toBe(403);
      expect(result.code, key).toBe('auth.api_key_scope');
    }
    expect(retrieve).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('refuses a key listed for another project with 403', async () => {
    const { app, retrieve } = retrievalApp();
    expect(
      (await get(app, path('?query=a', toPublicId('prj', OTHER_PROJECT)), DOCS_LISTED)).status,
    ).toBe(200);
    const result = await get(app, path('?query=a'), DOCS_LISTED);
    expect(result.status).toBe(403);
    expect(result.code).toBe('auth.api_key_scope');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a studio project, a missing project and a malformed id', async () => {
    const { app, retrieve } = retrievalApp();
    for (const project of [
      toPublicId('prj', PROJECT),
      toPublicId('prj', '01a14984-4476-77ce-9335-2c3c3a59ffff' as ProjectId),
      'prj_nope',
    ]) {
      const result = await get(app, path('?query=a', project));
      expect(result.status, project).toBe(404);
      expect(result.code, project).toBe('api.not_found');
    }
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('refuses a missing or bad key with 401', async () => {
    const { app } = retrievalApp();
    expect((await get(app, path('?query=a'), null)).code).toBe('auth.api_key_invalid');
    expect((await get(app, path('?query=a'), 'Bearer nope')).code).toBe('auth.api_key_invalid');
  });

  it('refuses bad parameters with 400 retrieval.bad_input after the key, before the read', async () => {
    const { app, retrieve } = retrievalApp();
    for (const query of ['', '?query=', '?query=a&limit=0', '?query=a&limit=21', '?query=a&x=1']) {
      const result = await get(app, path(query));
      expect(result.status, query).toBe(400);
      expect(result.code, query).toBe('retrieval.bad_input');
    }
    expect(retrieve).not.toHaveBeenCalled();
    // Without a key, the parameters are never looked at.
    expect((await get(app, path(''), null)).status).toBe(401);
  });

  it('answers a library refusal with its own status and code', async () => {
    const cases = [
      ['retrieval.bad_input', 400, 'retrieval.bad_input'],
      ['retrieval.version_not_found', 404, 'retrieval.version_not_found'],
      ['retrieval.not_found', 404, 'api.not_found'],
      ['retrieval.busy', 503, 'retrieval.busy'],
      ['retrieval.unavailable', 503, 'retrieval.unavailable'],
    ] as const;
    for (const [error, status, code] of cases) {
      const { app } = retrievalApp({}, fakeRetrieval({ ok: false, error }));
      const result = await get(app, path('?query=a&version=v9'));
      expect(result.status, error).toBe(status);
      expect(result.code, error).toBe(code);
      if (status === 503) expect(result.response.headers.get('retry-after'), error).toBe('1');
    }
  });

  it('answers 500 when the library throws, which it should never do', async () => {
    const thrown = fakeRetrieval();
    thrown.retrieve.mockRejectedValueOnce(new Error('bug'));
    const { app, logs } = retrievalApp({}, thrown);
    const result = await get(app, path('?query=a'));
    expect(result.status).toBe(500);
    expect(result.code).toBe('api.internal');
    expect(logs.find((l) => l.event === 'api.unhandled_error')?.fields).toEqual({ error: 'Error' });
  });

  describe('release flag', () => {
    it('off answers 404 as if the route did not exist, and never reads', async () => {
      const { app, isOn, retrieve } = retrievalApp();
      isOn.mockResolvedValue(false);
      const off = await get(app, path('?query=a'));
      expect(off.status).toBe(404);
      expect(off.code).toBe('api.not_found');
      expect(isOn).toHaveBeenCalledWith('retrieval.v1', {
        organizationId: ORG,
        projectId: DOCS_PROJECT,
      });
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('on serves the route', async () => {
      const { app, isOn } = retrievalApp();
      isOn.mockResolvedValue(true);
      expect((await get(app, path('?query=a'))).status).toBe(200);
    });

    it('a flag source that fails reads as off', async () => {
      const { app, isOn } = retrievalApp();
      isOn.mockRejectedValue(new Error('flagd down'));
      expect((await get(app, path('?query=a'))).status).toBe(404);
    });

    // Production reads the safe value until someone turns it on there.
    it('is a release flag whose safe value is off', () => {
      const flag = registry.find((f) => f.name === 'retrieval.v1');
      expect(flag?.kind).toBe('release');
      expect(flag?.safeValue).toBe(false);
    });
  });

  describe('plan', () => {
    it('serves Growth and above, and a self host', async () => {
      for (const plan of ['growth', 'scale', 'enterprise', 'self_hosted']) {
        tier = plan;
        const { app } = retrievalApp();
        expect((await get(app, path('?query=a'))).status, plan).toBe(200);
      }
    });

    it('refuses Free and Starter with 403 api.not_entitled, and never reads', async () => {
      for (const plan of ['free', 'starter']) {
        tier = plan;
        const { app, retrieve } = retrievalApp();
        const result = await get(app, path('?query=a'));
        expect(result.status, plan).toBe(403);
        expect(result.code, plan).toBe('api.not_entitled');
        expect(retrieve).not.toHaveBeenCalled();
      }
    });

    it('fails closed with 503 when the plan cannot be read or is unknown', async () => {
      for (const setup of [
        () => {
          planFails = true;
        },
        () => {
          tier = 'platinum';
        },
        () => {
          tier = undefined;
        },
      ]) {
        setup();
        const { app, retrieve, logs } = retrievalApp();
        const result = await get(app, path('?query=a'));
        expect(result.status).toBe(503);
        expect(result.code).toBe('api.unavailable');
        expect(retrieve).not.toHaveBeenCalled();
        expect(logs.some((l) => l.event === 'api.entitlement_failed')).toBe(true);
        planFails = false;
        tier = 'growth';
      }
    });
  });
});

describe('retrieval logs', () => {
  // Words only a careless line would carry.
  const QUESTION = 'canaryquestion about installing';
  const VERSION = 'canaryversion';

  const ALLOWED = new Set([
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

  it('carry ids only, never the question, the version label or the hit text', async () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    for (const answer of [
      { ok: true, value: RESULT } as const,
      { ok: false, error: 'retrieval.version_not_found' } as const,
      { ok: false, error: 'retrieval.busy' } as const,
    ]) {
      const { app } = retrievalApp({ logger }, fakeRetrieval(answer));
      await get(app, path(`?query=${encodeURIComponent(QUESTION)}&version=${VERSION}&limit=2`));
      await get(app, path(`?query=${encodeURIComponent(QUESTION)}&limit=99`));
    }
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const hitText = RESULT.hits[0]?.text ?? '';
    for (const line of lines) {
      expect(line).not.toContain('canary');
      expect(line).not.toContain(hitText);
      expect(line).not.toContain('install');
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const field of Object.keys(parsed)) expect(ALLOWED, field).toContain(field);
      expect(parsed['route']).toBe('/v1/projects/:projectId/retrieve');
      expect(parsed['organizationId']).toBe(toPublicId('org', ORG));
      expect(parsed['projectId']).toBe(DOCS_PUBLIC);
      expect(parsed['keyId']).toBe(toPublicId('key', KEY_ID));
    }
  });
});
