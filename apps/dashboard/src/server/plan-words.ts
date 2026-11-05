import { limitFor, UNLIMITED, type LimitKey, type Tier } from '@drefyn/entitlements';
import { seatMeta, type SeatCount } from '../shell/data.ts';
import type { ProductId } from '../shell/products.ts';
import { PLAN_LABELS } from './plan-labels.ts';

export { seatMeta };

const PROJECT_LIMITS: Readonly<Record<ProductId, LimitKey>> = {
  docs: 'org.docs_projects',
  studio: 'org.studio_projects',
  status: 'org.status_pages',
};

const PROJECT_WORDS: Readonly<Record<ProductId, readonly [string, string]>> = {
  docs: ['Docs project', 'Docs projects'],
  studio: ['Studio project', 'Studio projects'],
  status: ['status page', 'status pages'],
};

export function seatsSentence({ used, limit }: SeatCount): string {
  if (limit === UNLIMITED) return `${String(used)} ${used === 1 ? 'seat' : 'seats'} used.`;
  return `${String(used)} of ${String(limit)} seats used.`;
}

export const seatsPhrase = ({ used, limit }: SeatCount): string =>
  limit === UNLIMITED
    ? `${String(used)} ${used === 1 ? 'seat' : 'seats'}`
    : `${String(used)} of ${String(limit)} seats`;

export function includedSentence(tier: Tier, product: ProductId): string {
  const plan = PLAN_LABELS[tier];
  const limit = limitFor(tier, PROJECT_LIMITS[product]);
  const [one, many] = PROJECT_WORDS[product];
  if (limit === UNLIMITED) return `${plan} has no limit on ${many}.`;
  return `${plan} includes ${String(limit)} ${limit === 1 ? one : many}.`;
}
