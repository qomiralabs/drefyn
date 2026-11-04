import type { Mailer } from '@drefyn/email';

// A global under a registered symbol, because server.ts and each Next layer load separate
// copies of this module and share only the process. One mailer means one send limit.
const HOLDER = Symbol.for('drefyn.mailer');

interface Holder {
  mailer?: Promise<Mailer | null> | undefined;
  emailOffLogged?: boolean;
}

const global = globalThis as unknown as Record<symbol, Holder | undefined>;
const holder = (): Holder => (global[HOLDER] ??= {});

export function heldMailer(): Promise<Mailer | null> | undefined {
  return holder().mailer;
}

export function holdMailer(mailer: Promise<Mailer | null>): void {
  holder().mailer = mailer;
}

export function forgetMailer(): void {
  holder().mailer = undefined;
}

// True the first time it is asked in this process.
export function firstEmailOff(): boolean {
  const seen = holder().emailOffLogged === true;
  holder().emailOffLogged = true;
  return !seen;
}

export async function drainMailer(deadlineMs: number): Promise<{ readonly dropped: number }> {
  try {
    const mailer = await holder().mailer;
    return mailer === null || mailer === undefined
      ? { dropped: 0 }
      : await mailer.drain(deadlineMs);
  } catch {
    return { dropped: 0 };
  }
}
