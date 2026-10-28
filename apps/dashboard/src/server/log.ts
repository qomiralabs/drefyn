// One JSON line per event on stderr, with the tenant ids in every context and never a
// content body or personal data.
export interface LogContext {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

export function logWarn(event: string, context: LogContext = {}): void {
  console.warn(JSON.stringify({ level: 'warn', event, service: 'dashboard', ...context }));
}
