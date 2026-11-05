import type { Nodes, Root } from 'mdast';
import { isValidFrontmatter } from './frontmatter.ts';
import { isLiteralProgram } from './literal.ts';
import type { Dialect, MdxIssue, MdxIssueCode, RenderPolicy } from './types.ts';

interface Located {
  position?: { start: { line: number; column: number } } | undefined;
}

export const issue = (
  code: MdxIssueCode,
  severity: MdxIssue['severity'],
  line = 1,
  column = 1,
): MdxIssue => ({ code, severity, line, column });

const at = (code: MdxIssueCode, severity: MdxIssue['severity'], node: Located): MdxIssue =>
  issue(code, severity, node.position?.start.line, node.position?.start.column);

// Anchored and cut short, so a hostile first line cannot make these slow.
const LOOKS_LIKE_ESM =
  /^(?:import\s+(?:[\w$*{][^\n]*\sfrom\s+)?["']|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|\{|\*))/;
export const LOOKS_LIKE_COMPONENT = /^<[A-Z]/;
const SNIFF_LENGTH = 512;

function looksLikeMdx(node: Nodes): boolean {
  if (node.type === 'html') return LOOKS_LIKE_COMPONENT.test(node.value);
  if (node.type !== 'paragraph') return false;
  const [first] = node.children;
  return first?.type === 'text' && LOOKS_LIKE_ESM.test(first.value.slice(0, SNIFF_LENGTH));
}

type JsxElement = Extract<Nodes, { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement' }>;

function hasOnlyLiteralProps(element: JsxElement): boolean {
  return element.attributes.every((attribute) => {
    if (attribute.type === 'mdxJsxExpressionAttribute') return false;
    const { value } = attribute;
    return typeof value !== 'object' || value === null || isLiteralProgram(value.data?.estree);
  });
}

function inspectElement(element: JsxElement, policy: RenderPolicy, issues: MdxIssue[]): void {
  if (element.name === null || !policy.components.has(element.name)) {
    issues.push(at('mdx.unknown_component', 'warning', element));
  } else if (!hasOnlyLiteralProps(element)) {
    issues.push(at('mdx.prop_not_literal', 'error', element));
  }
}

function inspectNode(
  node: Nodes,
  depth: number,
  dialect: Dialect,
  policy: RenderPolicy,
  issues: MdxIssue[],
): void {
  switch (node.type) {
    case 'yaml':
      if (!isValidFrontmatter(node.value)) {
        issues.push(at('mdx.frontmatter_invalid', 'warning', node));
      }
      break;
    case 'mdxjsEsm':
      issues.push(at('mdx.esm_inert', 'warning', node));
      break;
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      issues.push(at('mdx.expression_inert', 'warning', node));
      break;
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      inspectElement(node, policy, issues);
      break;
    default:
      if (dialect === 'md' && depth === 1 && looksLikeMdx(node)) {
        issues.push(at('mdx.dialect_mismatch', 'warning', node));
      }
  }
}

// Stored trees are plain JSON: parser data can be as deep as the source, and positions go
// stale the moment a block above changes.
function strip(node: Nodes): void {
  delete node.position;
  delete node.data;
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;
  for (const attribute of node.attributes) {
    delete attribute.position;
    delete attribute.data;
    if (typeof attribute.value === 'object' && attribute.value !== null) {
      delete attribute.value.data;
    }
  }
}

interface Frame {
  readonly node: Nodes;
  readonly depth: number;
}

// Runs before anything recursive touches the tree, so it keeps its own stack and stops at
// the first limit. Depth counts from the top level blocks at 1.
export function inspect(tree: Root, dialect: Dialect, policy: RenderPolicy): readonly MdxIssue[] {
  const { maxDepth, maxNodes } = policy.limits;
  const issues: MdxIssue[] = [];
  const stack: Frame[] = [];
  const pushChildren = (node: Root | Nodes, depth: number) => {
    if (!('children' in node)) return;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push({ node: child, depth });
    }
  };
  pushChildren(tree, 1);
  let nodes = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, depth } = frame;
    if (depth > maxDepth) return [at('mdx.too_deep', 'error', node)];
    nodes += 1;
    if ('attributes' in node) nodes += node.attributes.length;
    if (nodes > maxNodes) return [at('mdx.too_many_nodes', 'error', node)];
    inspectNode(node, depth, dialect, policy, issues);
    strip(node);
    pushChildren(node, depth + 1);
  }
  return issues;
}
