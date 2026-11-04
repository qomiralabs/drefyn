import { checkDashboardConfig } from './auth.ts';
import { checkStart } from './boot.ts';
import { warmMailer } from './auth-mailer.ts';
import { mailDeliveryEnabled } from './gate.ts';
import { logError } from './log.ts';
import { appOrigin } from './origin.ts';
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

// Keeps the first load off a request, and shows a bad image in the boot log. Off with the
// flag off, so React and Nodemailer are not even loaded.
export async function warmMail(): Promise<void> {
  await warmMailer({ linkOrigin: new URL(appOrigin()), enabled: mailDeliveryEnabled });
}
