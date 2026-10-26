import { LIMIT_KEYS, UNLIMITED, limitFor } from '../src/index.ts';
import type { LimitOverrides } from '../src/index.ts';

// UNLIMITED raises every key on every tier, so the whole map passes validation, but the
// check returns early on an unlimited cap.
export const unlimitedMap: LimitOverrides = Object.fromEntries(
  LIMIT_KEYS.map((key) => [key, UNLIMITED]),
);

// Enterprise's own values with a raised email cap: still a full, valid map, and the checked
// cap stays finite, so the comparison and grace arithmetic run too.
export const finiteMap: LimitOverrides = Object.fromEntries(
  LIMIT_KEYS.map((key) => [
    key,
    key === 'status.email_sends_per_month' ? 1_000_000 : limitFor('enterprise', key),
  ]),
);
