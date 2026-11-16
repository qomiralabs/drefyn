import { z } from 'zod';
import { StatusError } from './errors.ts';
import { DOWN_STATES, RULE_KINDS, type RuleConfig } from './types.ts';

const ms = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const schema = z
  .strictObject({
    kind: z.enum(RULE_KINDS),
    threshold: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    minRegions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    singleRegionOptIn: z.boolean(),
    freshnessMs: ms,
    minDwellMs: ms,
    minAgreementMs: ms,
    mode: z.enum(['apply', 'propose']),
    downState: z.enum(DOWN_STATES),
  })
  .refine((cfg) => cfg.singleRegionOptIn || cfg.minRegions >= 2)
  .refine((cfg) => (cfg.kind === 'threshold') === (cfg.threshold !== undefined));

// Stored rules go through here as they are. No flag fills or changes a field, so a rule
// keeps its values when a default changes.
export function parseRuleConfig(input: unknown): RuleConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new StatusError('STATUS_RULE_INVALID');
  const { threshold, ...rest } = parsed.data;
  return threshold === undefined ? rest : { ...rest, threshold };
}
