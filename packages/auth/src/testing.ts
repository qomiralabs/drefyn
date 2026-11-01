import type { AuthMailer, SignInCodePurpose } from './step-up.ts';

// The test transport behind AuthMailer. Real delivery is @drefyn/email's job; this one
// records what auth asked for, and can be slowed or failed to prove the response never
// waits on mail.

export interface SentCode {
  readonly to: string;
  readonly code: string;
  readonly link: URL;
  readonly purpose: SignInCodePurpose;
  readonly linking?: { readonly provider: 'github' | 'google'; readonly account: string };
}

export interface TestAuthMailer {
  readonly mailer: AuthMailer;
  // Every call, delivered or not.
  readonly calls: readonly SentCode[];
  // Only the calls that were delivered.
  readonly sent: readonly SentCode[];
  // The next call rejects, as an SMTP failure would.
  failNext(): void;
}

export function createTestAuthMailer(options: { readonly delayMs?: number } = {}): TestAuthMailer {
  const calls: SentCode[] = [];
  const sent: SentCode[] = [];
  let failures = 0;
  const delayMs = options.delayMs ?? 0;
  const mailer: AuthMailer = {
    async sendSignInCode(to, code, link, purpose, linking) {
      const mail: SentCode = {
        to,
        code,
        link,
        purpose,
        ...(linking === undefined
          ? {}
          : { linking: { provider: linking.provider, account: linking.account } }),
      };
      calls.push(mail);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failures > 0) {
        failures -= 1;
        throw new Error('test transport refused the message');
      }
      sent.push(mail);
    },
  };
  return {
    mailer,
    get calls() {
      return [...calls];
    },
    get sent() {
      return [...sent];
    },
    failNext() {
      failures += 1;
    },
  };
}
