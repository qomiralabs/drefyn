import { parseOrganizationName } from '@drefyn/auth';
import type { OrganizationName } from './auth-mailer.ts';

const UNNAMED_ORGANIZATION = 'Your organization';

// A stored name can predate the rule the mail guard enforces, and the notice matters more
// than the name in it. Kept apart from the adapter, which stays free of auth at run time.
export function mailableOrganizationName(read: OrganizationName): OrganizationName {
  return async (organizationId) => {
    const stored = parseOrganizationName(await read(organizationId));
    return stored.ok ? stored.value : UNNAMED_ORGANIZATION;
  };
}
