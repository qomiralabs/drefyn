import { expect } from '@playwright/test';
import { test as base } from './test.ts';

export interface Violation {
  readonly directive: string;
  readonly blocked: string;
  readonly sample: string;
}

// Engines word CSP console messages differently: Chromium says "violates the following
// Content Security Policy directive", Firefox prefixes "Content-Security-Policy:".
const CSP_MESSAGE = /content.security.policy|violates/i;

// Every page in a spec that uses this test reports CSP violations, and the test fails at the
// end if there were any. A test that expects one reads the list and empties it.
export const test = base.extend<{ cspViolations: Violation[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: Violation[] = [];
      await page.exposeFunction('__drefynCspViolation', (v: Violation) => {
        violations.push(v);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const report = (
            window as unknown as { __drefynCspViolation: (v: unknown) => Promise<void> }
          ).__drefynCspViolation;
          void report({
            directive: event.effectiveDirective,
            blocked: event.blockedURI,
            sample: event.sample,
          });
        });
      });
      page.on('console', (message) => {
        const text = message.text();
        if (CSP_MESSAGE.test(text)) {
          violations.push({ directive: 'console', blocked: message.type(), sample: text });
        }
      });
      await use(violations);
      expect(violations, 'CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});
