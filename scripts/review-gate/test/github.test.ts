import { describe, expect, it } from 'vitest';
import { GitHubClient, loadGateInput } from '../src/github.ts';

const HEAD = 'c'.repeat(40);

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

function client(route: Route, retries = 2) {
  const fake = fakeFetch(route);
  return {
    client: new GitHubClient({
      token: 'test-token',
      apiUrl: 'https://api.example.test',
      fetch: fake.fn,
      retries,
      sleep: noSleep,
    }),
    calls: fake.calls,
  };
}

const pr = { head: { sha: HEAD }, labels: [{ name: 'needs-security' }, { name: 'p0' }] };

describe('loadGateInput', () => {
  it('collects head SHA, labels, comments and submitted reviews', async () => {
    const { client: gh, calls } = client((url) => {
      if (url.pathname === '/repos/o/r/pulls/7') return json(pr);
      if (url.pathname === '/repos/o/r/issues/7/comments') {
        return json([
          {
            user: { login: 'alice' },
            author_association: 'MEMBER',
            created_at: '2026-10-07T10:00:00Z',
            body: 'c1',
          },
          {
            user: null,
            author_association: 'NONE',
            created_at: '2026-10-07T10:01:00Z',
            body: null,
          },
        ]);
      }
      if (url.pathname === '/repos/o/r/pulls/7/reviews') {
        return json([
          {
            user: { login: 'bob' },
            author_association: 'OWNER',
            submitted_at: '2026-10-07T11:00:00Z',
            state: 'COMMENTED',
            body: 'r1',
          },
          {
            user: { login: 'carol' },
            author_association: 'MEMBER',
            submitted_at: '2026-10-07T11:01:00Z',
            state: 'DISMISSED',
            body: 'dismissed',
          },
          { user: { login: 'dan' }, author_association: 'MEMBER', state: 'PENDING', body: 'draft' },
        ]);
      }
      return json({ message: 'Not Found' }, { status: 404 });
    });

    const input = await loadGateInput(gh, 'o/r', 7);
    expect(input).toEqual({
      headSha: HEAD,
      labels: ['needs-security', 'p0'],
      entries: [
        {
          author: 'alice',
          authorAssociation: 'MEMBER',
          createdAt: '2026-10-07T10:00:00Z',
          body: 'c1',
        },
        { author: 'ghost', authorAssociation: 'NONE', createdAt: '2026-10-07T10:01:00Z', body: '' },
        {
          author: 'bob',
          authorAssociation: 'OWNER',
          createdAt: '2026-10-07T11:00:00Z',
          body: 'r1',
        },
      ],
    });
    const first = calls[0];
    expect(first?.init.headers).toMatchObject({
      authorization: 'Bearer test-token',
      accept: 'application/vnd.github+json',
    });
    expect(first?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows pagination links', async () => {
    const { client: gh } = client((url) => {
      if (url.pathname === '/repos/o/r/pulls/7') return json(pr);
      if (url.pathname === '/repos/o/r/issues/7/comments') {
        if (url.searchParams.get('page') === '2') {
          return json([
            {
              user: { login: 'b' },
              author_association: 'MEMBER',
              created_at: '2026-01-02T00:00:00Z',
              body: '2',
            },
          ]);
        }
        return json(
          [
            {
              user: { login: 'a' },
              author_association: 'MEMBER',
              created_at: '2026-01-01T00:00:00Z',
              body: '1',
            },
          ],
          {
            headers: {
              link: '<https://api.example.test/repos/o/r/issues/7/comments?per_page=100&page=2>; rel="next", <https://api.example.test/repos/o/r/issues/7/comments?per_page=100&page=2>; rel="last"',
            },
          },
        );
      }
      return json([]);
    });
    const input = await loadGateInput(gh, 'o/r', 7);
    expect(input.entries.map((e) => e.body)).toEqual(['1', '2']);
  });

  it('refuses to follow a pagination link to another host', async () => {
    const { client: gh } = client((url) => {
      if (url.pathname === '/repos/o/r/pulls/7') return json(pr);
      return json([], { headers: { link: '<https://evil.example/steal>; rel="next"' } });
    });
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/unexpected host/);
  });

  it('retries server errors with backoff and then succeeds', async () => {
    let attempts = 0;
    const { client: gh } = client((url) => {
      if (url.pathname === '/repos/o/r/pulls/7') {
        attempts += 1;
        return attempts < 3 ? json({}, { status: 502 }) : json(pr);
      }
      return json([]);
    });
    const input = await loadGateInput(gh, 'o/r', 7);
    expect(input.headSha).toBe(HEAD);
    expect(attempts).toBe(3);
  });

  it('retries network failures', async () => {
    let attempts = 0;
    const { client: gh } = client((url) => {
      if (url.pathname === '/repos/o/r/pulls/7') {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return json(pr);
      }
      return json([]);
    });
    await loadGateInput(gh, 'o/r', 7);
    expect(attempts).toBe(2);
  });

  it('gives up after the retry budget', async () => {
    const { client: gh, calls } = client(() => json({}, { status: 503 }), 2);
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
    await expect(loadGateInput(gh, 'o/r', 0)).rejects.toThrow(/PR number/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a PR payload without a head SHA', async () => {
    const { client: gh } = client(() => json({ head: {} }));
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/head SHA/);
  });

  it('rejects a list endpoint that does not return an array', async () => {
    const { client: gh } = client((url) =>
      url.pathname === '/repos/o/r/pulls/7' ? json(pr) : json({ message: 'odd' }),
    );
    await expect(loadGateInput(gh, 'o/r', 7)).rejects.toThrow(/expected a list/);
  });
});

describe('GitHubClient', () => {
  it('needs a token', () => {
    expect(() => new GitHubClient({ token: '' })).toThrow(/token/);
  });

  it('uses the default sleep between retries', async () => {
    let attempts = 0;
    const fake = fakeFetch(() => {
      attempts += 1;
      return attempts === 1 ? json({}, { status: 500 }) : json(pr);
    });
    const gh = new GitHubClient({
      token: 't',
      fetch: fake.fn,
      retries: 1,
      baseDelayMs: 1,
    });
    await gh.getJson('/repos/o/r/pulls/1');
    expect(fake.calls[0]?.url).toBe('https://api.github.com/repos/o/r/pulls/1');
  });
});
