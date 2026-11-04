import type { MailMessage } from '../../src/index.ts';

export const FIXED_FIELDS = ['template', 'purpose', 'kind', 'provider'] as const;
const FIXED: ReadonlySet<string> = new Set(FIXED_FIELDS);

// Every string a message carries, so a test can prove none reaches a subject or preheader.
function collect(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (value instanceof URL) into.push(value.href);
  else if (value instanceof Date || typeof value !== 'object' || value === null) return;
  else {
    for (const [key, field] of Object.entries(value)) {
      if (!FIXED.has(key)) collect(field, into);
    }
  }
}

export function userText(message: MailMessage): readonly string[] {
  const out: string[] = [];
  collect(message, out);
  return out;
}
