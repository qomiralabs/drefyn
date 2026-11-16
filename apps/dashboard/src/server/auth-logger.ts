import type { AuthLogger } from '@drefyn/auth';
import { logInfo, logWarn, type LogContext } from './log.ts';

// Auth passes ids and outcome codes; a value of any other shape stays out of the log.
function plainFields(fields: Readonly<Record<string, unknown>>): LogContext {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      kept[key] = value as string | number | boolean;
    }
  }
  return kept;
}

export const authLogger: AuthLogger = {
  info: (event, fields) => {
    logInfo(event, plainFields(fields));
  },
  warn: (event, fields) => {
    logWarn(event, plainFields(fields));
  },
};
