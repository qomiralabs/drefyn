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

export const wireRequestSchema = z.object({
  tenant,
  path: z.string(),
  source: z.string(),
  dialect: z.enum(['mdx', 'md']),
  policy,
});

export const wirePrintSchema = z.object({ tenant, path: z.string(), tree: z.string(), policy });

export type WireRequest = z.infer<typeof wireRequestSchema>;
export type WirePrint = z.infer<typeof wirePrintSchema>;

// Every escape in JSON is at most six bytes for one, and the frame around it is small.
export const maxBodyBytes = (maxBytes: number) => maxBytes * 6 + 65_536;

// A stored tree holds the page twice, as values and as raw text, plus its nodes: about 4 times
// the page on real files, and JSON escapes can double that.
export const maxTreeBytes = (maxBytes: number) => maxBytes * 16;
