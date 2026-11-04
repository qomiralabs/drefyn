import { logError } from './server/log.ts';
import { redactedRequestError } from './server/request-error.ts';

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { runStartCheck } = await import('./server/start-check.ts');
    runStartCheck();
    const { warmMail } = await import('./server/start-check.ts');
    void warmMail();
  }
}

export function onRequestError(
  error: unknown,
  request: { readonly method?: string | undefined },
  context: { readonly routePath?: string | undefined; readonly routeType?: string | undefined },
): void {
  logError('dashboard.request_error', redactedRequestError(error, request, context));
}
