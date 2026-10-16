import { describe, expect, it } from 'vitest';
import { GitHubClient, loadGateInput } from '../src/github.ts';

const HEAD = 'c'.repeat(40);
const API = 'https://api.example.test';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function fakeFetch(route: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url: url.toString(), init });
    return route(url, init);
  };
  return { fn: fn satisfies typeof fetch, calls };
}

const noSleep = () => Promise.resolve();

function client(route: Route, options: { retries?: number; maxPages?: number } = {}) {
  const fake = fakeFetch(route);
  return {
    client: new GitHubClient({
      token: 'test-token',
      apiUrl: API,
      graphqlUrl: `${API}/graphql`,
      fetch: fake.fn,
      retries: options.retries ?? 2,
      sleep: noSleep,
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    }),
    calls: fake.calls,
  };
}

interface GraphQLBody {
  query: string;
  variables: { after: string | null };
}

function graphqlBody(init: RequestInit): GraphQLBody {
  return JSON.parse(typeof init.body === 'string' ? init.body : '{}') as GraphQLBody;
}

const pr = {
  head: { sha: HEAD },
  labels: [{ name: 'needs-security' }, { name: 'p0' }],
  changed_files: 0,
};

function connection(nodes: unknown[], endCursor: string | null = null) {
  return { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes };
}

function graphqlPage(conn: unknown) {
  return json({ data: { repository: { pullRequest: { reviews: conn } } } });
}

const node = (login: string | null, body: string, extra: Record<string, unknown> = {}) => ({
  author: login === null ? null : { __typename: 'User', login },
  authorAssociation: 'MEMBER',
  submittedAt: '2026-10-07T10:00:00Z',
  lastEditedAt: null,
  state: 'COMMENTED',
  body,
  ...extra,
});

// Answers the REST and GraphQL calls loadGateInput makes, with overridable pieces.
function routes(overrides: {
  pr?: () => Response;
  files?: (url: URL) => Response;
  reviews?: (after: string | null) => Response;
}): Route {
  return (url, init) => {
    if (url.pathname === '/graphql') {
      const body = graphqlBody(init);
      // Issue comments are not a marker source; asking for them is a bug.
      if (body.query.includes('comments(')) return json({ message: 'unexpected' }, { status: 400 });
      return overrides.reviews?.(body.variables.after) ?? graphqlPage(connection([]));
    }
    if (url.pathname === '/repos/o/r/pulls/7') return overrides.pr?.() ?? json(pr);
    if (url.pathname === '/repos/o/r/pulls/7/files') return overrides.files?.(url) ?? json([]);
    return json({ message: 'Not Found' }, { status: 404 });
  };
}

describe('loadGateInput', () => {
  it('collects head SHA, labels, files and reviews with edit and dismiss flags', async () => {
    const { client: gh, calls } = client(
      routes({
        pr: () => json({ ...pr, changed_files: 2 }),
        files: () =>
          json([
            { filename: 'src/a.ts' },
            { filename: 'docs/new.md', previous_filename: 'scripts/old.md' },
          ]),
        reviews: () =>
          graphqlPage(
            connection([
              node('bob', 'r1', {
                authorAssociation: 'OWNER',
                submittedAt: '2026-10-07T11:00:00Z',
              }),
              node(null, 'r2', { authorAssociation: 'NONE' }),
              node('erin', 'r3', { lastEditedAt: '2026-10-07T12:00:00Z' }),
              node('carol', 'r4', { state: 'DISMISSED', submittedAt: '2026-10-07T11:01:00Z' }),
              node('renovate', 'r5', { author: { __typename: 'Bot', login: 'renovate' } }),
              node('frank', 'r6', { author: { login: 'frank' } }),
              node('dan', 'draft', { state: 'PENDING', submittedAt: null }),
            ]),
          ),
      }),
    );

    const input = await loadGateInput(gh, 'o/r', 7);
    expect(input).toEqual({
      headSha: HEAD,
      labels: ['needs-security', 'p0'],
      files: ['src/a.ts', 'docs/new.md', 'scripts/old.md'],
      reviews: [
        {
          author: 'bob',
          authorType: 'User',
          authorAssociation: 'OWNER',
          submittedAt: '2026-10-07T11:00:00Z',
          body: 'r1',
          edited: false,
          dismissed: false,
        },
        {
          author: 'ghost',
          authorType: 'unknown',
          authorAssociation: 'NONE',
          submittedAt: '2026-10-07T10:00:00Z',
          body: 'r2',
          edited: false,
          dismissed: false,
        },
        {
          author: 'erin',
          authorType: 'User',
          authorAssociation: 'MEMBER',
          submittedAt: '2026-10-07T10:00:00Z',
          body: 'r3',
          edited: true,
          dismissed: false,
        },
        {
          author: 'carol',
          authorType: 'User',
          authorAssociation: 'MEMBER',
          submittedAt: '2026-10-07T11:01:00Z',
          body: 'r4',
          edited: false,
          dismissed: true,
        },
        {
          author: 'renovate',
          authorType: 'Bot',
          authorAssociation: 'MEMBER',
          submittedAt: '2026-10-07T10:00:00Z',
          body: 'r5',
          edited: false,
          dismissed: false,
        },
        {
          author: 'frank',
          authorType: 'unknown',
          authorAssociation: 'MEMBER',
          submittedAt: '2026-10-07T10:00:00Z',
          body: 'r6',
          edited: false,
          dismissed: false,
        },
      ],
    });
    const first = calls[0];
    expect(first?.init.headers).toMatchObject({
      authorization: 'Bearer test-token',
      accept: 'application/vnd.github+json',
    });
    expect(first?.init.signal).toBeInstanceOf(AbortSignal);
    const gql = calls.filter((c) => c.url.endsWith('/graphql'));
    expect(gql).toHaveLength(1);
    expect(gql[0]?.init.method).toBe('POST');
    expect(graphqlBody(gql[0]?.init ?? {})).toMatchObject({
      variables: { owner: 'o', name: 'r', number: 7 },
    });
    const query = graphqlBody(gql[0]?.init ?? {}).query;
    expect(query).not.toContain('comments(');
    // The type is what tells a bot from a user, since bot logins come back without [bot].
    expect(query).toContain('author { __typename login }');
  });

  it('follows REST pagination links for changed files', async () => {
    const { client: gh } = client(
      routes({
        pr: () => json({ ...pr, changed_files: 2 }),
        files: (url) =>
          url.searchParams.get('page') === '2'
            ? json([{ filename: 'b.ts' }])
            : json([{ filename: 'a.ts' }], {
                headers: {
                  link: `<${API}/repos/o/r/pulls/7/files?per_page=100&page=2>; rel="next"`,
                },
              }),
      }),
    );
    expect((await loadGateInput(gh, 'o/r', 7)).files).toEqual(['a.ts', 'b.ts']);
  });

  it('fails closed when the file list does not add up to changed_files', async () => {
    const { client: gh } = client(
      routes({
        pr: () => json({ ...pr, changed_files: 2 }),
        files: () => json([{ filename: 'a.ts' }]),
      }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(
      /listed 1 changed files, the PR has 2/,
    );
  });

  it('fails closed at 3000 changed files, where GitHub stops listing them', async () => {
    const { client: gh, calls } = client(
      routes({ pr: () => json({ ...pr, changed_files: 3000 }) }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/3000 changed files/);
    expect(calls.some((c) => c.url.includes('/files'))).toBe(false);
  });

  it('fails when the PR payload has no changed_files count', async () => {
    const { client: gh } = client(routes({ pr: () => json({ head: { sha: HEAD }, labels: [] }) }));
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/changed_files/);
  });

  it('fails on a submitted review without a timestamp', async () => {
    const { client: gh } = client(
      routes({
        reviews: () =>
          graphqlPage(
            connection([
              {
                author: { login: 'a' },
                authorAssociation: 'MEMBER',
                submittedAt: null,
                lastEditedAt: null,
                state: 'CHANGES_REQUESTED',
                body: 'x',
              },
            ]),
          ),
      }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/no timestamp/);
  });

  it('follows GraphQL cursors for reviews', async () => {
    const { client: gh } = client(
      routes({
        reviews: (after) =>
          after === null
            ? graphqlPage(connection([node('a', '1')], 'CUR1'))
            : graphqlPage(connection([node('b', '2')])),
      }),
    );
    expect((await loadGateInput(gh, 'o/r', 7)).reviews.map((e) => e.body)).toEqual(['1', '2']);
  });

  it('fails closed when REST pagination runs past the page cap', async () => {
    const loop = `<${API}/repos/o/r/pulls/7/files?page=2>; rel="next"`;
    const { client: gh } = client(
      routes({ files: () => json([{ filename: 'x' }], { headers: { link: loop } }) }),
      { maxPages: 3 },
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/more than 3 pages/);
  });

  it('fails closed when GraphQL pagination runs past the page cap', async () => {
    const { client: gh } = client(
      routes({ reviews: () => graphqlPage(connection([node('a', '1')], 'SAME')) }),
      { maxPages: 2 },
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/more than 2 pages/);
  });

  it('refuses to follow a pagination link to another host', async () => {
    const { client: gh } = client(
      routes({
        files: () => json([], { headers: { link: '<https://evil.example/steal>; rel="next"' } }),
      }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/unexpected host/);
  });

  it('fails on GraphQL errors instead of reading partial data', async () => {
    const { client: gh } = client(
      routes({ reviews: () => json({ data: null, errors: [{ message: 'Something broke' }] }) }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/Something broke/);
  });

  it('fails when GraphQL returns no pull request', async () => {
    const { client: gh } = client(
      routes({ reviews: () => json({ data: { repository: { pullRequest: null } } }) }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/no reviews connection/);
  });

  it('retries server errors with backoff and then succeeds', async () => {
    let attempts = 0;
    const { client: gh } = client(
      routes({
        pr: () => {
          attempts += 1;
          return attempts < 3 ? json({}, { status: 502 }) : json(pr);
        },
      }),
    );
    expect((await loadGateInput(gh, 'o/r', 7)).headSha).toBe(HEAD);
    expect(attempts).toBe(3);
  });

  it('retries a 429 rate limit response', async () => {
    let attempts = 0;
    const { client: gh } = client(
      routes({
        pr: () => {
          attempts += 1;
          return attempts === 1 ? json({ message: 'rate limited' }, { status: 429 }) : json(pr);
        },
      }),
    );
    await loadGateInput(gh, 'o/r', 7);
    expect(attempts).toBe(2);
  });

  it('aborts a request that hangs past the timeout, retries, then gives up', async () => {
    const fake = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const gh = new GitHubClient({
      token: 't',
      apiUrl: API,
      fetch: fake.fn,
      retries: 1,
      timeoutMs: 5,
      sleep: noSleep,
    });
    await expect(gh.getJson('/repos/o/r/pulls/7')).rejects.toThrow(/TimeoutError/);
    expect(fake.calls).toHaveLength(2);
  });

  it('retries network failures', async () => {
    let attempts = 0;
    const { client: gh } = client(
      routes({
        pr: () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('fetch failed');
          return json(pr);
        },
      }),
    );
    await loadGateInput(gh, 'o/r', 7);
    expect(attempts).toBe(2);
  });

  it('gives up after the retry budget', async () => {
    const { client: gh, calls } = client(() => json({}, { status: 503 }), { retries: 2 });
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3);
  });

  it('does not retry client errors', async () => {
    const { client: gh, calls } = client(() =>
      json({ message: 'Bad credentials' }, { status: 401 }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it('rejects a malformed repo or PR number before calling the API', async () => {
    const { client: gh, calls } = client(() => json(pr));
    await expect(loadGateInput(gh, 'o/r/../x', 7)).rejects.toThrow(/repo/);
    await expect(loadGateInput(gh, 'o/..', 7)).rejects.toThrow(/repo/);
    await expect(loadGateInput(gh, 'o/r', 0)).rejects.toThrow(/PR number/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a PR payload without a head SHA', async () => {
    const { client: gh } = client(routes({ pr: () => json({ head: {} }) }));
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/head SHA/);
  });

  it('rejects a list endpoint that does not return an array', async () => {
    const { client: gh } = client(routes({ files: () => json({ message: 'odd' }) }));
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/expected a list/);
  });
});

describe('GitHubClient', () => {
  it('needs a token', () => {
    expect(() => new GitHubClient({ token: '' })).toThrow(/token/);
  });

  it('refuses a GraphQL endpoint on another host than the API', () => {
    expect(
      () =>
        new GitHubClient({ token: 't', apiUrl: API, graphqlUrl: 'https://evil.example/graphql' }),
    ).toThrow(/same host/);
  });

  it('uses the public API and the default sleep when nothing is configured', async () => {
    let attempts = 0;
    const fake = fakeFetch(() => {
      attempts += 1;
      return attempts === 1 ? json({}, { status: 500 }) : json(pr);
    });
    const gh = new GitHubClient({ token: 't', fetch: fake.fn, retries: 1, baseDelayMs: 1 });
    await gh.getJson('/repos/o/r/pulls/1');
    expect(fake.calls[0]?.url).toBe('https://api.github.com/repos/o/r/pulls/1');
  });
});
