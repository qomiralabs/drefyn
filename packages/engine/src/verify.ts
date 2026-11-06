import { createHash } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  rawOf,
  validateTree,
  type MdxBlock,
  type MdxIssue,
  type MdxLimits,
  type MdxRoot,
  type TreeProblem,
} from '@drefyn/mdx';
import type { ParseClient, ParseClientRequest } from '@drefyn/mdx/client';
import type { TenantRef } from '@drefyn/tenancy';
import type { EngineConfig } from './config.ts';
import { astVersionOf } from './content.ts';
import { refuse, type EngineIssue, type EngineResult } from './errors.ts';
import type { EngineLogger } from './ports.ts';
import type { NodeId } from './types.ts';

export type ParsePolicy = Omit<ParseClientRequest['policy'], 'limits' | 'components'> & {
  readonly components: Iterable<string>;
};

export interface VerifyDeps {
  readonly parse: Pick<ParseClient, 'parse'>;
  readonly parsePolicy: ParsePolicy;
  readonly config: EngineConfig;
  readonly logger: EngineLogger;
}

export interface VerifiedContent {
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

// The bytes a tree claims to be. The parser wrote gap, raw and tail so that they join back into
// the page, which is what makes parsing them again a fair test of the tree.
function sourceText(root: MdxRoot): EngineResult<string> {
  let text = '';
  for (const [index, block] of root.children.entries()) {
    const { source } = block;
    // TODO(#279): print a new or edited block in the host instead of refusing it.
    if (source === undefined) {
      return refuse('engine.validation_failed', [
        { path: `content.children.${index}.source`, code: 'engine.block_not_printed' },
      ]);
    }
    text += source.gapBefore + source.raw;
  }
  return { ok: true, value: text + root.tail };
}

function sameBlock(sent: MdxBlock, parsed: MdxBlock): boolean {
  return (
    sent.source?.raw === parsed.source?.raw &&
    sent.source?.gapBefore === parsed.source?.gapBefore &&
    rawOf(sent) === rawOf(parsed)
  );
}

// Compares trees and recomputes hashes, as a hash in a submitted tree proves nothing: it has no
// key, so whoever forged the raw text can compute a matching one.
function firstDifference(sent: MdxRoot, parsed: MdxRoot): string | null {
  if (sent.eol !== parsed.eol) return 'content.eol';
  if (sent.tail !== parsed.tail) return 'content.tail';
  const count = Math.max(sent.children.length, parsed.children.length);
  for (let index = 0; index < count; index += 1) {
    const left = sent.children[index];
    const right = parsed.children[index];
    if (left === undefined || right === undefined || !sameBlock(left, right)) {
      return `content.children.${index}`;
    }
  }
  return null;
}

const hashesHold = (root: MdxRoot) =>
  root.children.every((block) => block.source?.rawOf === rawOf(block));

// Everything a tree has to pass before it may be stored. It holds no lock: the parse is a
// network call and can take seconds. What gets stored is the tree the host parsed from the
// bytes, never the one sent, so a forged tree that slips a check still cannot reach the column.
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

  const text = sourceText(sent.value);
  if (!text.ok) return text;
  if (Buffer.byteLength(text.value, 'utf8') > maxNodeBytes) {
    return refuse('engine.too_large', [{ path: 'content', code: 'engine.source_too_large' }]);
  }

  const answer = await deps.parse.parse({
    tenant,
    path: `nodes/${nodeId}`,
    source: text.value,
    dialect: sent.value.dialect,
    policy: {
      ...deps.parsePolicy,
      components: new Set(deps.parsePolicy.components),
      limits: { ...DEFAULT_LIMITS, maxBytes: maxNodeBytes },
    },
  });
  if (!answer.ok) return pageRefusal(answer.error);

  // Hostile pages run on that host, so its answer gets no more trust than a client's. A page can
  // parse into far more than the tree sent for it, which is the page's fault and not the host's.
  const parsed = validateTree(answer.value.ast, treeLimits);
  if (!parsed.ok && parsed.error.some(({ code }) => OVERSIZED_TREE.has(code))) {
    return treeRefusal(parsed.error);
  }
  if (!parsed.ok || !hashesHold(parsed.value)) {
    deps.logger.warn('engine.parse_answer_refused', {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: nodeId,
    });
    return refuse('engine.unavailable', [{ path: 'content', code: 'engine.parse_answer_invalid' }]);
  }

  const path = firstDifference(sent.value, parsed.value);
  if (path !== null) {
    return refuse('engine.validation_failed', [{ path, code: 'engine.tree_mismatch' }]);
  }

  const json = JSON.stringify(parsed.value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxTreeBytes) {
    return refuse('engine.too_large', [{ path: 'content', code: 'engine.tree_too_large' }]);
  }
  return {
    ok: true,
    value: {
      json,
      sha256: createHash('sha256').update(json).digest(),
      astVersion: astVersionOf(parsed.value),
      bytes,
    },
  };
}
