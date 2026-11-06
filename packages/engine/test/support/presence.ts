import { describe, inject } from 'vitest';

export function describeWithStack(name: string, body: () => void): void {
  const absent = inject('engineStackAbsent');
  if (absent === null) describe(name, body);
  else describe.skip(`${name} [skipped, no compose stack: ${absent}]`, body);
}
