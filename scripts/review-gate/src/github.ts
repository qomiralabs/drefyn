import type { Entry, GateInput } from './gate.ts';

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Page {
  data: unknown;
  next: string | undefined;
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
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubClientOptions) {
    if (options.token === '') throw new Error('a GitHub token is required');
    this.#token = options.token;
    this.#apiUrl = new URL(options.apiUrl ?? 'https://api.github.com');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retries = options.retries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async getJson(path: string): Promise<unknown> {
    return (await this.#getPage(path)).data;
  }

  async getAll(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | undefined = path;
    while (next !== undefined) {
      const page = await this.#getPage(next);
      if (!Array.isArray(page.data)) throw new Error(`expected a list from ${path}`);
      items.push(...(page.data as unknown[]));
      next = page.next;
    }
    return items;
  }

  // Reads are idempotent, so transient failures are retried with jittered backoff.
  async #getPage(pathOrUrl: string): Promise<Page> {
    const url = new URL(pathOrUrl, this.#apiUrl);
    // The token must only ever go to the API host, even if a Link header says otherwise.
    if (url.origin !== this.#apiUrl.origin) throw new Error(`unexpected host in ${url.origin}`);
    let lastError: Error = new Error(`GET ${url.pathname} was not attempted`);
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) {
        const backoff = this.#baseDelayMs * 2 ** (attempt - 1);
        await this.#sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'drefyn-review-gate',
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        lastError = new Error(`GET ${url.pathname} failed: ${String(error)}`);
        continue;
      }
      if (response.ok) {
        return { data: await response.json(), next: nextLink(response.headers.get('link')) };
      }
      lastError = new Error(`GET ${url.pathname} failed with ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    }
    throw lastError;
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function toEntry(raw: unknown, timeField: 'created_at' | 'submitted_at'): Entry | undefined {
  if (!isRecord(raw)) return undefined;
  const createdAt = str(raw[timeField]);
  if (createdAt === undefined) return undefined;
  const user = isRecord(raw['user']) ? raw['user'] : undefined;
  return {
    // Deleted accounts come back as null users; GitHub shows them as "ghost".
    author: str(user?.['login']) ?? 'ghost',
    authorAssociation: str(raw['author_association']) ?? 'NONE',
    createdAt,
    body: str(raw['body']) ?? '',
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

  const pr = await client.getJson(`/repos/${repo}/pulls/${prNumber}`);
  const head = isRecord(pr) && isRecord(pr['head']) ? str(pr['head']['sha']) : undefined;
  if (head === undefined) throw new Error(`PR ${prNumber} payload has no head SHA`);
  const rawLabels = isRecord(pr) && Array.isArray(pr['labels']) ? (pr['labels'] as unknown[]) : [];
  const labels = rawLabels.flatMap((label) => {
    const name = isRecord(label) ? str(label['name']) : undefined;
    return name === undefined ? [] : [name];
  });

  const comments = await client.getAll(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  const reviews = await client.getAll(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);

  const entries: Entry[] = [];
  for (const comment of comments) {
    const entry = toEntry(comment, 'created_at');
    if (entry) entries.push(entry);
  }
  for (const review of reviews) {
    // A dismissed review was withdrawn on purpose; a pending one was never posted.
    const state = isRecord(review) ? str(review['state']) : undefined;
    if (state === 'DISMISSED' || state === 'PENDING') continue;
    const entry = toEntry(review, 'submitted_at');
    if (entry) entries.push(entry);
  }
  return { headSha: head, labels, entries };
}
