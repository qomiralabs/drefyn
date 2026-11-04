import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';

// Each address is tried on its own, so one bad address cannot keep the news from the others.
// failed runs once per missed send and gets no address: logs carry none.
export async function noticeEach(
  mailer: AuthNoticeMailer,
  addresses: readonly string[],
  notice: AuthSecurityNotice,
  failed: () => void,
): Promise<void> {
  for (const to of addresses) {
    try {
      await mailer.sendSecurityNotice(to, notice);
    } catch {
      failed();
    }
  }
}

// How a notice names a member: their display name, or their address when they set none.
export const memberName = (displayName: string | null, email: string): string =>
  displayName === null || displayName === '' ? email : displayName;
