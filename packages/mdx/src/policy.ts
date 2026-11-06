import { z } from 'zod';
import type { ComponentRegistry, MdxLimits } from './types.ts';

export const DEFAULT_LIMITS: MdxLimits = { maxBytes: 1_048_576, maxDepth: 64, maxNodes: 50_000 };

export const DEFAULT_MERGE_MAX_BLOCKS = 20_000;

// The tree walks recurse once the depth check has passed, so depth needs a ceiling a
// misconfigured policy cannot lift. The other two keep one parse within a worker's memory.
const CEILING: MdxLimits = { maxBytes: 16_777_216, maxDepth: 512, maxNodes: 1_000_000 };

const limit = (ceiling: number) => z.int().min(1).max(ceiling);

const registry = z.custom<ComponentRegistry>(
  (value) => typeof (value as Partial<ComponentRegistry> | null | undefined)?.has === 'function',
);

export const parseInputSchema = z.object({
  source: z.string(),
  dialect: z.enum(['mdx', 'md']),
  policy: z.object({
    version: z.int().min(0),
    components: registry,
    rawHtml: z.enum(['sanitize', 'drop']),
    remoteImages: z.enum(['allow', 'proxy', 'block']),
    linkProtocols: z.array(z.enum(['https', 'http', 'mailto'])),
    limits: z.object({
      maxBytes: limit(CEILING.maxBytes),
      maxDepth: limit(CEILING.maxDepth),
      maxNodes: limit(CEILING.maxNodes),
    }),
  }),
});
