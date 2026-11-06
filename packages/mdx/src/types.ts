import type { RootContent } from 'mdast';
// Brings the MDX node types into the mdast unions.
import type {} from 'remark-mdx';

export type Dialect = 'mdx' | 'md';

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type MdastBlock = RootContent;

export interface BlockSource {
  // Exact source of the block, including its leading indent.
  readonly raw: string;
  // Exact source since the previous block. Ends at a line start, or at that block.
  readonly gapBefore: string;
  // sha256 of the canonical tree. A block prints its raw text only while this still matches.
  readonly rawOf: string;
  // sha256 over rawOf, gapBefore and raw, so the printed bytes are bound to that tree.
  readonly sourceOf: string;
}

// New blocks have no source until something prints them.
export type MdxBlock = MdastBlock & { source?: BlockSource };

export const AST_VERSION = 1;

export interface MdxRoot {
  readonly type: 'root';
  readonly astVersion: typeof AST_VERSION;
  readonly dialect: Dialect;
  // The ending a reprinted block has to use to match the file.
  readonly eol: 'lf' | 'crlf';
  readonly children: readonly MdxBlock[];
  // Everything after the last block.
  readonly tail: string;
  readonly tailOf: string;
}

export type MdxIssueCode =
  | 'mdx.parse_failed'
  | 'mdx.too_large'
  | 'mdx.too_deep'
  | 'mdx.too_many_nodes'
  | 'mdx.esm_inert'
  | 'mdx.expression_inert'
  | 'mdx.unknown_component'
  | 'mdx.prop_not_literal'
  | 'mdx.frontmatter_invalid'
  | 'mdx.dialect_mismatch'
  | 'mdx.parse_timeout'
  | 'mdx.out_of_memory'
  | 'mdx.queue_full'
  | 'mdx.organization_limit'
  | 'mdx.project_limit'
  | 'mdx.parse_unavailable'
  | 'mdx.block_not_printable'
  | 'mdx.print_changed_meaning';

// Codes and places only: an issue can reach a log, and customer text must not.
export interface MdxIssue {
  readonly code: MdxIssueCode;
  readonly severity: 'error' | 'warning';
  readonly line: number;
  readonly column: number;
}

// A Set of names is enough to parse; the renderer can hand in a Map of its components.
export interface ComponentRegistry {
  has(name: string): boolean;
}

export interface MdxLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface RenderPolicy {
  // Stored on each published snapshot.
  readonly version: number;
  readonly components: ComponentRegistry;
  readonly rawHtml: 'sanitize' | 'drop';
  readonly remoteImages: 'allow' | 'proxy' | 'block';
  readonly linkProtocols: readonly ('https' | 'http' | 'mailto')[];
  readonly limits: MdxLimits;
}

// The bytes, and the tree they parse to. Store that tree and not the one sent: only this one is
// known to agree with what git will hold.
export type PrintResult = Result<
  {
    readonly text: string;
    readonly ast: MdxRoot;
    readonly issues: readonly MdxIssue[];
  },
  readonly MdxIssue[]
>;

export type ParseResult = Result<
  { readonly ast: MdxRoot; readonly issues: readonly MdxIssue[] },
  readonly MdxIssue[]
>;
