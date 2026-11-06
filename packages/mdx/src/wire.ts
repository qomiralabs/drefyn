import { z } from 'zod';

// One schema for both ends, so a client and a host cannot disagree on the frame. The host
// treats it as input from the network and rebuilds the policy from what passes here.
const tenant = z.object({ organizationId: z.string(), projectId: z.string() });

const policy = z.object({
  version: z.int(),
  components: z.array(z.string()),
  rawHtml: z.enum(['sanitize', 'drop']),
  remoteImages: z.enum(['allow', 'proxy', 'block']),
  linkProtocols: z.array(z.enum(['https', 'http', 'mailto'])),
  limits: z.object({ maxBytes: z.int(), maxDepth: z.int(), maxNodes: z.int() }),
});

// Bulk unless a caller says a person is waiting: a frame that says nothing earns nothing.
const priority = z.enum(['interactive', 'bulk']).default('bulk');

export const wireRequestSchema = z.object({
  tenant,
  path: z.string(),
  source: z.string(),
  dialect: z.enum(['mdx', 'md']),
  policy,
  priority,
});

export const wirePrintSchema = z.object({
  tenant,
  path: z.string(),
  tree: z.string(),
  policy,
  priority,
});

export type WireRequest = z.infer<typeof wireRequestSchema>;
export type WirePrint = z.infer<typeof wirePrintSchema>;

// Every escape in JSON is at most six bytes for one, and the frame around it is small.
export const maxBodyBytes = (maxBytes: number) => maxBytes * 6 + 65_536;

// A stored tree holds the page twice, as values and as raw text, plus its nodes: about 3 times
// the page on real files, and JSON escapes can double that.
export const maxTreeBytes = (maxBytes: number) => maxBytes * 8;

// The tree crosses as a JSON string, where only a quote or a backslash grows, and by double.
export const maxPrintBodyBytes = (treeBytes: number) => treeBytes * 2 + 65_536;

// The organization has to be known before the body, which may be refused unread.
export const ORGANIZATION_HEADER = 'x-drefyn-organization';
