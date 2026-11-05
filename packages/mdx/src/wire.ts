import { z } from 'zod';

// One schema for both ends, so a client and a host cannot disagree on the frame. The host
// treats it as input from the network and rebuilds the policy from what passes here.
export const wireRequestSchema = z.object({
  tenant: z.object({ organizationId: z.string(), projectId: z.string() }),
  path: z.string(),
  source: z.string(),
  dialect: z.enum(['mdx', 'md']),
  policy: z.object({
    version: z.int(),
    components: z.array(z.string()),
    rawHtml: z.enum(['sanitize', 'drop']),
    remoteImages: z.enum(['allow', 'proxy', 'block']),
    linkProtocols: z.array(z.enum(['https', 'http', 'mailto'])),
    limits: z.object({ maxBytes: z.int(), maxDepth: z.int(), maxNodes: z.int() }),
  }),
});

export type WireRequest = z.infer<typeof wireRequestSchema>;

// Every escape in JSON is at most six bytes for one, and the frame around it is small.
export const maxBodyBytes = (maxBytes: number) => maxBytes * 6 + 65_536;
