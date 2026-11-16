import { parseOrganizationName } from '@drefyn/auth';
import { withOrganization, type Database } from '@drefyn/db';
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

// The stored name, read under the organization's own context.
export function organizationNames(db: Database): OrganizationName {
  return async (organizationId) => {
    const row = await withOrganization(db, { organizationId }, (tx) =>
      tx
        .selectFrom('organizations')
        .select('name')
        .where('organization_id', '=', organizationId)
        .executeTakeFirstOrThrow(),
    );
    return row.name;
  };
}
