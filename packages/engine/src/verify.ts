import { createHash } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  rawOf,
  validateTree,
  type MdxIssue,
  type MdxLimits,
  type MdxRoot,
  type TreeProblem,
} from '@drefyn/mdx';
import type { ParseClient, PrintClientRequest } from '@drefyn/mdx/client';
import type { TenantRef } from '@drefyn/tenancy';
import type { EngineConfig } from './config.ts';
import { astVersionOf } from './content.ts';
import { refuse, type EngineIssue, type EngineResult } from './errors.ts';
import type { EngineLogger, EngineTracer } from './ports.ts';
import type { NodeId } from './types.ts';

export type ParsePolicy = Omit<PrintClientRequest['policy'], 'limits' | 'components'> & {
  readonly components: Iterable<string>;
};

export interface VerifyDeps {
  readonly parse: Pick<ParseClient, 'print'>;
  readonly parsePolicy: ParsePolicy;
  readonly config: EngineConfig;
  readonly logger: EngineLogger;
  readonly tracer: EngineTracer;
}

export interface VerifiedContent {
  readonly tree: MdxRoot;
  readonly json: string;
  readonly sha256: Buffer;
  readonly astVersion: number;
  readonly bytes: number;
}

const OVERSIZED_TREE: ReadonlySet<TreeProblem['code']> = new Set([
  'tree.too_deep',
  'tree.too_many_nodes',
  'tree.too_large',
]);

const OVERSIZED_PAGE: ReadonlySet<MdxIssue['code']> = new Set([
  'mdx.too_large',
  'mdx.too_deep',
  'mdx.too_many_nodes',
  'mdx.parse_timeout',
  'mdx.out_of_memory',
]);

// None of these is a verdict on the page.
const BUSY_HOST: ReadonlySet<MdxIssue['code']> = new Set([
  'mdx.queue_full',
  'mdx.organization_limit',
  'mdx.project_limit',
  'mdx.parse_unavailable',
]);

const atContent = (path: string) => (path === '' ? 'content' : `content.${path}`);

function treeRefusal<T>(problems: readonly TreeProblem[]): EngineResult<T> {
  const issues = problems.map(({ path, code }) => ({ path: atContent(path), code }));
  return problems.some(({ code }) => OVERSIZED_TREE.has(code))
    ? refuse('engine.too_large', issues)
    : refuse('engine.validation_failed', issues);
}

function pageRefusal<T>(found: readonly MdxIssue[]): EngineResult<T> {
  const issues: EngineIssue[] = found.map(({ code, line, column }) => ({
    path: 'content',
    code,
    line,
    column,
  }));
  if (found.some(({ code }) => BUSY_HOST.has(code))) return refuse('engine.unavailable', issues);
  if (found.some(({ code }) => OVERSIZED_PAGE.has(code))) return refuse('engine.too_large', issues);
  return refuse('engine.validation_failed', issues);
}

const joinedSource = (root: MdxRoot) =>
  root.children.reduce(
    (text, { source }) => text + (source?.gapBefore ?? '') + (source?.raw ?? ''),
    '',
  ) + root.tail;

// The answer has to hold together on its own: every hash fresh, and the blocks joining back
// into the bytes it says it printed.
const answerHolds = (root: MdxRoot, text: string) =>
  root.children.every((block) => block.source?.rawOf === rawOf(block)) &&
  joinedSource(root) === text;

// Everything a tree has to pass before it may be stored. It holds no lock, as printing is a
// network call and can take seconds. The host prints the tree and parses what it printed, and
// refuses when the bytes do not mean what the nodes say, which is what catches a forged raw:
// hashes in a submitted tree prove nothing, since they have no key. What gets stored is the tree
// that parse gave, never the one sent.
export async function verifyContent(
  content: unknown,
  tenant: TenantRef,
  nodeId: NodeId,
  deps: VerifyDeps,
): Promise<EngineResult<VerifiedContent>> {
  const { maxNodeBytes, maxTreeBytes } = deps.config;
  const treeLimits: MdxLimits = { ...DEFAULT_LIMITS, maxBytes: maxTreeBytes };
  const sent = validateTree(content, treeLimits);
  if (!sent.ok) return treeRefusal(sent.error);

  const answer = await deps.parse.print({
    tenant,
    path: `nodes/${nodeId}`,
    root: sent.value,
    // Someone is waiting on a save, so it goes ahead of this organization's own sync.
    priority: 'interactive',
    policy: {
      ...deps.parsePolicy,
      components: new Set(deps.parsePolicy.components),
      limits: { ...DEFAULT_LIMITS, maxBytes: maxNodeBytes },
    },
  });
  if (!answer.ok) return pageRefusal(answer.error);

  // Hostile pages run on that host, so its answer gets no more trust than a client's. A tree can
  // print and parse into far more than was sent, which is the page's fault and not the host's.
  const { timing } = answer.value;
  if (timing !== undefined) {
    const fields = {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: nodeId,
    };
    deps.tracer.record('engine.save.host.queue', fields, timing.waitedMs ?? 0);
    deps.tracer.record('engine.save.host.thread', fields, timing.threadMs ?? 0);
    deps.tracer.record('engine.save.host.decode', fields, timing.decodeMs);
    deps.tracer.record('engine.save.host.print', fields, timing.printMs);
    deps.tracer.record('engine.save.host.reparse', fields, timing.reparseMs);
    deps.tracer.record('engine.save.host.compare', fields, timing.compareMs);
  }

  const parsed = validateTree(answer.value.ast, treeLimits);
  if (!parsed.ok && parsed.error.some(({ code }) => OVERSIZED_TREE.has(code))) {
    return treeRefusal(parsed.error);
  }
  if (!parsed.ok || !answerHolds(parsed.value, answer.value.text)) {
    deps.logger.warn('engine.parse_answer_refused', {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: nodeId,
    });
    return refuse('engine.unavailable', [{ path: 'content', code: 'engine.parse_answer_invalid' }]);
  }

  const json = JSON.stringify(parsed.value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxTreeBytes) {
    return refuse('engine.too_large', [{ path: 'content', code: 'engine.tree_too_large' }]);
  }
  return {
    ok: true,
    value: {
      tree: parsed.value,
      json,
      sha256: createHash('sha256').update(json).digest(),
      astVersion: astVersionOf(parsed.value),
      bytes,
    },
  };
}
