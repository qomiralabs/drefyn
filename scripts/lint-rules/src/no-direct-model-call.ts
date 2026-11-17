import type { Rule } from 'eslint';
import { cachedWorkspace, isRecord, ownerOf, workspaceRootFor } from './workspace.ts';

// Model calls cost money per token, carry customer text and a provider key, and must stop
// when the kill switch is off. @drefyn/ai is where all of that is handled, so a provider
// URL, path or header anywhere else is a call that skips it. Vendor SDKs are refused
// everywhere, @drefyn/ai included: they bring their own HTTP client, which the egress
// guard cannot see. Strings built at run time are out of reach; this guards against
// honest shortcuts, not evasion, and no-raw-egress still holds every raw socket.

const HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'openai.azure.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'bedrock-runtime.',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.cohere.com',
  'api.groq.com',
  'openrouter.ai',
  'api.together.xyz',
  'api.deepseek.com',
  'api.fireworks.ai',
  'api.x.ai',
];

// The request paths and headers only a model API uses.
const MARKERS = [
  /\/v1\/messages(?![\w-])/,
  /\/chat\/completions(?![\w-])/,
  /\/v1\/completions(?![\w-])/,
  /^anthropic-(?:version|beta)$/,
];

const SDKS = [
  /^@anthropic-ai\//,
  /^openai(?:\/|$)/,
  /^@google\/(?:genai|generative-ai)(?:\/|$)/,
  /^@google-cloud\/vertexai(?:\/|$)/,
  /^@mistralai\//,
  /^cohere-ai(?:\/|$)/,
  /^groq-sdk(?:\/|$)/,
  /^ai(?:\/|$)/,
  /^@ai-sdk\//,
  /^langchain(?:\/|$)/,
  /^@langchain\//,
  /^ollama(?:\/|$)/,
  /^together-ai(?:\/|$)/,
  /^@aws-sdk\/client-bedrock-runtime(?:\/|$)/,
  /^llamaindex(?:\/|$)/,
  /^@huggingface\/inference(?:\/|$)/,
];

// The adapters, and this rule's own lists.
const EXEMPT = new Set(['@drefyn/ai', '@drefyn/lint-rules']);

const namesProvider = (text: string): boolean => {
  const lower = text.toLowerCase();
  return HOSTS.some((host) => lower.includes(host)) || MARKERS.some((m) => m.test(lower));
};

const isSdk = (source: unknown): boolean =>
  typeof source === 'string' && SDKS.some((pattern) => pattern.test(source));

function exempt(file: string, settings: unknown): boolean {
  const root = workspaceRootFor(file, settings);
  if (root === undefined) return false;
  const name = ownerOf(cachedWorkspace(root), file)?.name;
  return name !== undefined && EXEMPT.has(name);
}

interface Sourced {
  readonly source?: unknown;
}

const literalValue = (node: unknown): unknown =>
  isRecord(node) && node['type'] === 'Literal' ? node['value'] : undefined;

export const noDirectModelCall: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Model providers are reached only through @drefyn/ai' },
    schema: [],
    messages: {
      endpoint:
        'Model provider call outside @drefyn/ai. Use a ModelProvider from @drefyn/ai, which goes through the egress guard, the kill switch and key redaction.',
      sdk: 'Vendor model SDK. @drefyn/ai speaks to providers over @drefyn/egress with no SDK; use a ModelProvider.',
    },
  },
  create(context) {
    const endpoints = !exempt(context.filename, context.settings);
    const checkSource = (node: Rule.Node, source: unknown): void => {
      if (isSdk(literalValue(source))) context.report({ node, messageId: 'sdk' });
    };
    const moduleSources = new WeakSet<object>();
    const markSource = (node: Sourced): void => {
      if (isRecord(node.source)) moduleSources.add(node.source);
    };
    return {
      ImportDeclaration(node) {
        markSource(node);
        checkSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        markSource(node);
        checkSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined) return;
        markSource(node);
        checkSource(node, node.source);
      },
      ImportExpression(node) {
        markSource(node);
        checkSource(node, node.source);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'Identifier' || callee.name !== 'require') return;
        const [first] = node.arguments;
        if (isRecord(first)) moduleSources.add(first);
        checkSource(node, first);
      },
      // import x = require('y'), which the TypeScript parser gives its own node.
      TSExternalModuleReference(node: Rule.Node) {
        const expression: unknown = Reflect.get(node, 'expression');
        if (isRecord(expression)) moduleSources.add(expression);
        checkSource(node, expression);
      },
      Literal(node) {
        if (!endpoints || moduleSources.has(node) || typeof node.value !== 'string') return;
        if (namesProvider(node.value)) context.report({ node, messageId: 'endpoint' });
      },
      TemplateLiteral(node) {
        if (!endpoints) return;
        const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('\0');
        if (namesProvider(text)) context.report({ node, messageId: 'endpoint' });
      },
    };
  },
};
