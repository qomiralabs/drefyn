import { isPlainAddress } from '@drefyn/address';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { parseOrganizationName } from './organization-rules.ts';

// Said in mail when a person's name cannot be. It is the last step, so no name or address
// can stop a notice.
export const UNNAMED_PERSON = 'A team member';
// Said in place of a stored key name the rules no longer allow. How the key ends still
// identifies it.
export const UNNAMED_KEY = 'Unnamed key';

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

// Display names are typed by people, and a mail client links anything that reads as a
// domain. The organization name rule already refuses those, so it is the test here too.
export function checkedDisplayName(displayName: string | null): string | null {
  if (displayName === null) return null;
  const checked = parseOrganizationName(displayName);
  return checked.ok ? checked.value : null;
}

// Names are checked when a key is made, but the rule has tightened since, and an older key
// must still be revocable with its owners told.
export function storedKeyName(name: string): string {
  return checkedDisplayName(name) ?? UNNAMED_KEY;
}

// The person being named picks both the name and the local part of the address, and this
// notice can be the one that reveals their takeover, so neither may carry a link or get the
// send refused.
export function memberName(displayName: string | null, email: string): string {
  const name = checkedDisplayName(displayName);
  if (name !== null) return name;
  return isPlainAddress(email) ? email : UNNAMED_PERSON;
}
