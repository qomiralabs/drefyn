import { guardPublic } from '../../server/guard.ts';

// The framework baseline for the bundle check: one server component and nothing else. It
// holds no data, so it sits behind the visitor flag and needs no session.
export default async function BundleBaseline() {
  await guardPublic();
  return null;
}
