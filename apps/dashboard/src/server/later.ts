import type { SecondFactorsDeps } from '@drefyn/auth';
import { after } from 'next/server';

type Later = NonNullable<SecondFactorsDeps['later']>;

// Notices about failed codes run after the response, so a refusal never waits on mail.
// after() only works inside a request; anywhere else the task still runs, just at once.
export const afterResponse: Later = (task) => {
  try {
    after(task);
  } catch {
    void task();
  }
};
