import type { GateInput, Review } from './gate.ts';

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  graphqlUrl?: string;
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Connection {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export class GitHubClient {
  readonly #token: string;
  readonly #apiUrl: URL;
  readonly #graphqlUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxPages: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubClientOptions) {
    if (options.token === '') throw new Error('a GitHub token is required');
    this.#token = options.token;
    this.#apiUrl = new URL(options.apiUrl ?? 'https://api.github.com');
    this.#graphqlUrl = new URL(options.graphqlUrl ?? '/graphql', this.#apiUrl);
    if (this.#graphqlUrl.origin !== this.#apiUrl.origin) {
      throw new Error('the GraphQL endpoint must be on the same host as the API');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retries = options.retries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxPages = options.maxPages ?? 50;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async getJson(path: string): Promise<unknown> {
    const response = await this.#send('GET', new URL(path, this.#apiUrl));
    return response.json();
  }

  // A partial list could hide a blocking review, so running out of pages fails the gate.
  async getAll(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | undefined = path;
    for (let page = 0; next !== undefined; page += 1) {
      if (page === this.#maxPages) this.#tooManyPages(path);
      const response = await this.#send('GET', new URL(next, this.#apiUrl));
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error(`expected a list from ${path}`);
      items.push(...(data as unknown[]));
      next = nextLink(response.headers.get('link'));
    }
    return items;
  }

  async graphqlConnection(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: unknown) => Connection,
  ): Promise<unknown[]> {
    const nodes: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page === this.#maxPages) this.#tooManyPages('graphql');
      const connection = pick(await this.#graphql(query, { ...variables, after }));
      nodes.push(...connection.nodes);
      if (!connection.hasNextPage) return nodes;
      after = connection.endCursor;
    }
  }

  #tooManyPages(what: string): never {
    throw new Error(
      `more than ${this.#maxPages} pages from ${what}; refusing to evaluate a partial list`,
    );
  }

  async #graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await this.#send(
      'POST',
      this.#graphqlUrl,
      JSON.stringify({ query, variables }),
    );
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw new Error('GraphQL returned no object');
    const errors = payload['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const messages = errors.map((e) => (isRecord(e) ? str(e['message']) : undefined) ?? '?');
      throw new Error(`GraphQL error: ${messages.join('; ')}`);
    }
    return payload['data'];
  }

  // Both REST reads and GraphQL queries are idempotent, so transient failures are retried
  // with jittered backoff.
  async #send(method: 'GET' | 'POST', url: URL, body?: string): Promise<Response> {
    // The token must only ever go to the API host, even if a Link header says otherwise.
    if (url.origin !== this.#apiUrl.origin) throw new Error(`unexpected host in ${url.origin}`);
    let lastError: Error = new Error(`${method} ${url.pathname} was not attempted`);
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) {
        const backoff = this.#baseDelayMs * 2 ** (attempt - 1);
        await this.#sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'drefyn-review-gate',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        lastError = new Error(`${method} ${url.pathname} failed: ${String(error)}`);
        continue;
      }
      if (response.ok) return response;
      lastError = new Error(`${method} ${url.pathname} failed with ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    }
    throw lastError;
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_LISTED_FILES = 3000;

// Markers come only from submitted reviews: a review cannot be deleted, while an issue
// comment can vanish and take a block with it. lastEditedAt is set only when the body
// changes, unlike REST updated_at, and REST has no edit time for review bodies at all.
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { __typename login }
          authorAssociation submittedAt lastEditedAt state body
        }
      }
    }
  }
}`;

function reviewsConnection(data: unknown): Connection {
  const repository = isRecord(data) ? data['repository'] : undefined;
  const pr = isRecord(repository) ? repository['pullRequest'] : undefined;
  const conn = isRecord(pr) ? pr['reviews'] : undefined;
  const pageInfo = isRecord(conn) ? conn['pageInfo'] : undefined;
  const nodes = isRecord(conn) ? conn['nodes'] : undefined;
  if (!isRecord(pageInfo) || !Array.isArray(nodes)) {
    throw new Error('GraphQL returned no reviews connection for the PR');
  }
  return {
    nodes: nodes as unknown[],
    hasNextPage: pageInfo['hasNextPage'] === true,
    endCursor: str(pageInfo['endCursor']) ?? null,
  };
}

// A node the gate cannot place in time could be a block, so it fails the run instead of
// being dropped.
function toReview(raw: unknown): Review {
  const submittedAt = isRecord(raw) ? str(raw['submittedAt']) : undefined;
  if (!isRecord(raw) || submittedAt === undefined) {
    throw new Error('GraphQL returned a submitted review with no timestamp');
  }
  const author = isRecord(raw['author']) ? raw['author'] : undefined;
  return {
    // Deleted accounts come back as null authors; GitHub shows them as "ghost".
    author: str(author?.['login']) ?? 'ghost',
    // Anything but an explicit User, a missing type included, never counts.
    authorType: str(author?.['__typename']) ?? 'unknown',
    authorAssociation: str(raw['authorAssociation']) ?? 'NONE',
    submittedAt,
    body: str(raw['body']) ?? '',
    edited: raw['lastEditedAt'] !== null && raw['lastEditedAt'] !== undefined,
    dismissed: raw['state'] === 'DISMISSED',
  };
}

export async function loadGateInput(
  client: GitHubClient,
  repo: string,
  prNumber: number,
): Promise<GateInput> {
  if (!REPO.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`invalid repo: ${repo}`);
  }
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`invalid PR number: ${prNumber}`);
  }
  const [owner = '', name = ''] = repo.split('/');

  const pr = await client.getJson(`/repos/${repo}/pulls/${prNumber}`);
  const head = isRecord(pr) && isRecord(pr['head']) ? str(pr['head']['sha']) : undefined;
  if (head === undefined) throw new Error(`PR ${prNumber} payload has no head SHA`);
  const rawLabels = isRecord(pr) && Array.isArray(pr['labels']) ? (pr['labels'] as unknown[]) : [];
  const labels = rawLabels.flatMap((label) => {
    const labelName = isRecord(label) ? str(label['name']) : undefined;
    return labelName === undefined ? [] : [labelName];
  });
  const changedCount = isRecord(pr) ? pr['changed_files'] : undefined;
  if (typeof changedCount !== 'number')
    throw new Error(`PR ${prNumber} payload has no changed_files`);
  // The files endpoint silently stops at 3000, which would hide guarded paths past that.
  if (changedCount >= MAX_LISTED_FILES) {
    throw new Error(
      `PR ${prNumber} has ${changedCount} changed files; GitHub lists at most ${MAX_LISTED_FILES}, so the path rules cannot be checked`,
    );
  }

  // A rename counts under both names, so moving a file out of a guarded path still needs review.
  const changed = await client.getAll(`/repos/${repo}/pulls/${prNumber}/files?per_page=100`);
  if (changed.length !== changedCount) {
    throw new Error(`listed ${changed.length} changed files, the PR has ${changedCount}`);
  }
  const files = changed.flatMap((file) => {
    if (!isRecord(file)) return [];
    return [str(file['filename']), str(file['previous_filename'])].filter(
      (path): path is string => path !== undefined,
    );
  });

  const variables = { owner, name, number: prNumber };
  const nodes = await client.graphqlConnection(REVIEWS_QUERY, variables, reviewsConnection);
  const reviews: Review[] = [];
  for (const node of nodes) {
    // A pending review was never posted. Dismissed ones stay, so a block survives dismissal.
    if (isRecord(node) && node['state'] === 'PENDING') continue;
    reviews.push(toReview(node));
  }
  return { headSha: head, labels, files, reviews };
}
