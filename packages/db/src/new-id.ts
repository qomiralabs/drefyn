import type { IdKind, IdOf } from '@drefyn/tenancy';
import { notImplemented } from './not-implemented.ts';

// A UUIDv7 for rows whose id is needed before the insert.
export function newId<K extends IdKind>(kind: K): IdOf<K> {
  return notImplemented(`newId(${kind})`);
}
