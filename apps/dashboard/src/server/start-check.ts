import { authConfig, checkDashboardConfig } from './auth.ts';
import { checkStart } from './boot.ts';
import { warmMailer } from './auth-mailer.ts';
import { mailDeliveryEnabled } from './gate.ts';
import { logError, logInfo } from './log.ts';
import { appOrigin } from './origin.ts';
import { checkSsoDomainLists } from './sso-domain-lists.ts';
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

// Inside the Next build, where claims are checked, so a start proves the build carries the
// bundled list. Runs after the start check, which has already stopped a bad config.
export async function warmSsoDomainLists(): Promise<void> {
  await checkSsoDomainLists({
    file: authConfig().sso.freeMailDomainsFile,
    exit: (code) => process.exit(code),
    log: (event, context) => {
      if (event === 'dashboard.sso_lists_loaded') logInfo(event, context);
      else logError(event, context);
    },
  });
}
