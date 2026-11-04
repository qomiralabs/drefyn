import { checkDashboardConfig } from './auth.ts';
import { checkStart } from './boot.ts';
import { logError } from './log.ts';
import { clientIpWrapperRunning } from './wrapper-marker.ts';

// Node only, kept out of instrumentation.ts, which Next also compiles for the edge.
export function runStartCheck(): void {
  checkStart({
    runtime: process.env['NEXT_RUNTIME'],
    // Inlined at build, so an env var cannot turn a production build into a dev start.
    production: process.env.NODE_ENV === 'production',
    wrapperRunning: clientIpWrapperRunning(),
    env: process.env,
    checkConfig: checkDashboardConfig,
    exit: (code) => process.exit(code),
    log: (event, context) => {
      logError(event, context);
    },
  });
}
