import type { Tier } from '@drefyn/entitlements';

export const PLAN_LABELS: Readonly<Record<Tier, string>> = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth',
  scale: 'Scale',
  enterprise: 'Enterprise',
  self_hosted: 'Self hosted',
};
