import { z } from 'zod';
import { CODE_LANGUAGES } from './grammars.ts';
import type { FileExtraction } from './types.ts';

// An answer comes from the thread that read hostile code, so its shape is checked before it is
// trusted, and unknown keys are dropped.
const symbolSchema = z.object({
  language: z.enum(CODE_LANGUAGES),
  path: z.string(),
  name: z.string(),
  kind: z.enum([
    'function',
    'class',
    'interface',
    'type',
    'const',
    'method',
    'struct',
    'enum',
    'trait',
  ]),
  exported: z.boolean(),
  signature: z.string(),
  doc: z.string().nullable(),
  startLine: z.int().min(1),
});

const routeSchema = z.object({
  path: z.string(),
  method: z.string(),
  route: z.string(),
  framework: z.string(),
});

export const extractionSchema: z.ZodType<FileExtraction> = z.object({
  symbols: z.array(symbolSchema),
  routes: z.array(routeSchema),
  partial: z.boolean(),
});
