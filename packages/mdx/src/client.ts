import { createHash } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { checkMerged, checkParsed, checkPrinted } from './answer.ts';
import { DEFAULT_LIMITS } from './policy.ts';
import { refused, wireResultSchema } from './result.ts';
import type { JobResult } from './result.ts';
import type { IsolatedPolicy } from './thread.ts';
import type { Dialect, MdxRoot, MergeAnswer, ParseResult, PrintResult } from './types.ts';
import { maxMergeTreesBytes, maxTreeBytes, ORGANIZATION_HEADER } from './wire.ts';
import type { WireMerge, WirePrint, WireRequest } from './wire.ts';

export type ParsePriority = 'interactive' | 'bulk';

export interface ParseClientRequest {
  readonly tenant: TenantRef;
  // Logged by the host, so it never holds page text.
  readonly path: string;
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
  // Interactive for a save a person is waiting on. Everything else is bulk.
  readonly priority?: ParsePriority;
}

export interface PrintClientRequest {
  readonly tenant: TenantRef;
  // Logged by the host, so it never holds page text.
  readonly path: string;
  readonly root: MdxRoot;
  readonly policy: IsolatedPolicy;
  readonly priority?: ParsePriority;
}

export interface MergeClientRequest {
  readonly tenant: TenantRef;
  // Logged by the host, so it never holds page text.
  readonly path: string;
  readonly base: MdxRoot;
  readonly ours: MdxRoot;
  readonly theirs: MdxRoot;
  readonly policy: IsolatedPolicy;
  readonly priority?: ParsePriority;
}

export interface ParseClient {
  // Never parses here, and has no fallback that does. Resolves with a refusal for anything
  // about the page, the load or the host, so a save keeps its last good version.
  parse(request: ParseClientRequest): Promise<ParseResult>;
  // Prints in the host and reparses what it printed, so nothing reaches git that means
  // something other than the tree. Store the tree this hands back, not the one sent.
  print(request: PrintClientRequest): Promise<PrintResult>;
  // Merges in the host. A clean outcome is not yet a version: print it and store what that hands
  // back. A conflict stops the write until a person decides.
  merge(request: MergeClientRequest): Promise<MergeAnswer>;
}

export interface ParseClientLogger {
  warn(event: string, fields: Readonly<Record<string, string | number>>): void;
}

export interface ParseClientConfig {
  readonly url: string;
  // Proves to the host that this is the app tier. The host keeps only its hash.
  readonly token: string;
  readonly logger: ParseClientLogger;
  readonly timeoutMs?: number;
  readonly maxAnswerBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const configSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  token: z.string().min(32),
  // Covers a full queue ahead of the page and its own kill.
  timeoutMs: z.int().min(1).max(600_000).default(60_000),
  maxAnswerBytes: z
    .int()
    .min(1)
    .default(64 * DEFAULT_LIMITS.maxBytes),
});

const BUSY = 429;
const UNAUTHORIZED = 401;

const wireOf = (policy: IsolatedPolicy) => ({
  ...policy,
  components: [...policy.components],
  linkProtocols: [...policy.linkProtocols],
});

interface Read {
  readonly text: string | undefined;
  readonly bytes: number;
  readonly sha256: string;
}

async function readCapped(response: Response, cap: number): Promise<Read> {
  const hash = createHash('sha256');
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let whole = reader !== undefined;
  if (reader !== undefined) {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const chunk = read.value as Uint8Array;
      bytes += chunk.byteLength;
      hash.update(chunk);
      if (bytes > cap) {
        await reader.cancel();
        whole = false;
        break;
      }
      text += decoder.decode(chunk, { stream: true });
    }
  }
  return {
    text: whole ? text + decoder.decode() : undefined,
    bytes,
    sha256: hash.digest('hex'),
  };
}

function readAnswer(text: string | undefined): JobResult | undefined {
  if (text === undefined) return undefined;
  try {
    const answer = wireResultSchema.safeParse(JSON.parse(text));
    return answer.success ? answer.data : undefined;
  } catch {
    return undefined;
  }
}

export function createParseClient(config: ParseClientConfig): ParseClient {
  const { url, token, timeoutMs, maxAnswerBytes } = configSchema.parse(config);
  const send = config.fetch ?? fetch;

  const warn = (event: string, fields: Readonly<Record<string, string | number>>) => {
    try {
      config.logger.warn(event, fields);
    } catch {
      // A log line is never worth a failed save.
    }
  };

  interface Call {
    readonly route: string;
    readonly body: string;
    readonly tenant: TenantRef;
    readonly path: string;
    readonly check: (answer: JobResult) => JobResult;
  }

  const post = async ({ route, body, tenant, path, check }: Call): Promise<JobResult> => {
    const { organizationId, projectId } = tenant;
    try {
      const response = await send(new URL(route, url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          [ORGANIZATION_HEADER]: organizationId,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === UNAUTHORIZED) {
        // Nothing about the page, and a deployment that needs a person. Not the token.
        warn('mdx.parse_host_unauthorized', { organizationId, projectId, path });
      }
      if (response.status !== 200 && response.status !== BUSY) {
        return refused('mdx.parse_unavailable');
      }
      const { text, bytes, sha256 } = await readCapped(response, maxAnswerBytes);
      const read = readAnswer(text);
      const answer = read === undefined ? refused('mdx.parse_failed') : check(read);
      // By hash: this comes from where hostile pages run, and it can quote one.
      if (answer !== read) {
        warn('mdx.parse_bad_answer', { organizationId, projectId, path, bytes, sha256 });
      }
      return answer;
    } catch {
      // Down, killed or slow: none of it is a verdict on the page.
      return refused('mdx.parse_unavailable');
    }
  };

  return {
    async parse(request) {
      const { tenant, path, source, dialect, policy, priority = 'bulk' } = request;
      if (Buffer.byteLength(source, 'utf8') > policy.limits.maxBytes) {
        return refused('mdx.too_large');
      }
      const frame: WireRequest = {
        tenant,
        path,
        source,
        dialect,
        policy: wireOf(policy),
        priority,
      };
      const body = JSON.stringify(frame);
      const check = (answer: JobResult) => checkParsed(answer, source);
      return (await post({ route: '/parse', body, tenant, path, check })) as ParseResult;
    },
    async print(request) {
      const { tenant, path, root, policy, priority = 'bulk' } = request;
      let tree: string;
      try {
        tree = JSON.stringify(root);
      } catch {
        // Only a tree far past any depth limit can overflow this.
        return refused('mdx.too_deep');
      }
      if (Buffer.byteLength(tree, 'utf8') > maxTreeBytes(policy.limits.maxBytes)) {
        return refused('mdx.too_large');
      }
      const frame: WirePrint = { tenant, path, tree, policy: wireOf(policy), priority };
      const body = JSON.stringify(frame);
      const answer = await post({ route: '/print', body, tenant, path, check: checkPrinted });
      return answer as PrintResult;
    },
    async merge(request) {
      const { tenant, path, base, ours, theirs, policy, priority = 'bulk' } = request;
      let trees: string;
      try {
        trees = JSON.stringify({ base, ours, theirs });
      } catch {
        // Only a tree far past any depth limit can overflow this.
        return refused('mdx.too_deep');
      }
      if (Buffer.byteLength(trees, 'utf8') > maxMergeTreesBytes(policy.limits.maxBytes)) {
        return refused('mdx.too_large');
      }
      const frame: WireMerge = { tenant, path, trees, policy: wireOf(policy), priority };
      const body = JSON.stringify(frame);
      const check = (answer: JobResult) => checkMerged(answer, { base, ours, theirs });
      return (await post({ route: '/merge', body, tenant, path, check })) as MergeAnswer;
    },
  };
}
