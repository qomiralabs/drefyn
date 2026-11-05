import type { OrganizationSchema } from '@drefyn/db';
import type { OrganizationId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';

// Pending invitations that have not expired, plus every membership. The invited address
// can be left out, so a resend never asks for a second seat.
export async function countUsed(
  tx: Transaction<OrganizationSchema>,
  organizationId: OrganizationId,
  except: string | null,
): Promise<{ used: number; tier: string }> {
  const leaveOut = except === null ? sql`` : sql`and email_normalized <> ${except}`;
  const { rows } = await sql<{ used: number; plan_tier: string }>`
    select o.plan_tier,
      ((select count(*) from memberships where organization_id = ${organizationId})
       + (select count(*) from invitations
           where organization_id = ${organizationId} and expires_at > now() ${leaveOut}))::int
        as used
    from organizations o where o.organization_id = ${organizationId}`.execute(tx);
  const row = rows[0];
  if (row === undefined) throw new Error('organization row is missing');
  return { used: row.used, tier: row.plan_tier };
}
