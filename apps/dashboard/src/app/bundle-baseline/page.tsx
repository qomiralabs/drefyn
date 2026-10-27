import { PLACEHOLDER } from '../../fixtures/placeholder.ts';
import { requireDashboard } from '../../server/gate.ts';

// The framework baseline for the bundle check: one server component and nothing else. It
// sits behind the release flag like every other route.
export default async function BundleBaseline() {
  await requireDashboard(PLACEHOLDER.organization.id);
  return null;
}
