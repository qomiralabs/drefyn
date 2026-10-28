import { redirect } from 'next/navigation';
import { PLACEHOLDER } from '../fixtures/placeholder.ts';
import { requireDashboard } from '../server/gate.ts';

// A first visit lands on the organization overview. Sessions do not exist yet, so the
// placeholder organization stands in for the person's last one.
export default async function Root() {
  await requireDashboard(PLACEHOLDER.organization.id);
  redirect(`/${PLACEHOLDER.organization.slug}`);
}
