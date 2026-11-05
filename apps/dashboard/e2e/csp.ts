import { expect } from '@playwright/test';
import { withoutWebKitSelectArtefact } from './csp-webkit-select.ts';
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
export const test = base.extend<{
  cspViolations: Violation[];
  selectsCreated: { count: number };
}>({
  // A holder, so a test and the teardown read the same count. Through a binding, not a page
  // global, because a count on the page would end with the page. Bindings are async, so a
  // count that falls behind leaves a violation over, which fails rather than hides.
  selectsCreated: [
    async ({ page, browserName }, use) => {
      const selects = { count: 0 };
      if (browserName === 'webkit') {
        await page.exposeFunction('__drefynSelectCreated', () => {
          selects.count += 1;
        });
        await page.addInitScript(() => {
          const prototype = Document.prototype as unknown as {
            createElement: (this: Document, tag: string, options?: object) => Element;
          };
          const create = prototype.createElement;
          prototype.createElement = function (tag, options) {
            if (tag.toLowerCase() === 'select') {
              const page = window as unknown as { __drefynSelectCreated: () => Promise<void> };
              void page.__drefynSelectCreated();
            }
            return create.call(this, tag, options);
          };
        });
      }
      await use(selects);
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ page, browserName, selectsCreated }, use) => {
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
      expect(
        withoutWebKitSelectArtefact(browserName, violations, selectsCreated.count),
        'CSP violations',
      ).toEqual([]);
    },
    { auto: true },
  ],
});
