import type { Metadata } from 'next';
import { guardPublic } from '../../server/guard.ts';

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return {};
}

// The framework baseline for the bundle check: one server component and nothing else. It
// holds no data, so it sits behind the visitor flag and needs no session.
export default async function BundleBaseline() {
  await guardPublic();
  return null;
}
