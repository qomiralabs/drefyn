import type { GitHubLogger, LogFields } from '../../src/index.ts';

export interface Line {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields;
}

export interface Captured {
  readonly logger: GitHubLogger;
  readonly lines: Line[];
  // Every line as JSON, for checks that a secret appears nowhere.
  text(): string;
}

export function captureLogs(): Captured {
  const lines: Line[] = [];
  return {
    logger: {
      info: (event, fields) => lines.push({ level: 'info', event, fields }),
      warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
    },
    lines,
    text: () => lines.map((line) => JSON.stringify(line)).join('\n'),
  };
}
