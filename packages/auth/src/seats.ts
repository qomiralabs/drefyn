import { normalizeAddress } from './address.ts';

// What holds a seat: an accepted member or a pending invitation. Project roles, API keys,
// subscribers and private page viewers have no row here, so they can never count.
export type SeatHolder =
  | { readonly kind: 'member'; readonly userId: string }
  | { readonly kind: 'invitation'; readonly email: string };

// The pure statement of what the SQL count does, kept so property tests can hold the
// database to it. A person is one seat however many products they work in.
export function countSeats(holders: Iterable<SeatHolder>): number {
  const people = new Set<string>();
  const addresses = new Set<string>();
  for (const holder of holders) {
    // Typed callers cannot pass another kind, but a holder built from a row still might.
    const kind: unknown = holder.kind;
    if (kind === 'member' && holder.kind === 'member') {
      people.add(holder.userId);
      continue;
    }
    if (kind !== 'invitation' || holder.kind !== 'invitation') {
      throw new RangeError('unknown seat holder');
    }
    const address = normalizeAddress(holder.email);
    if (address === null) throw new RangeError('an invitation holds an address');
    addresses.add(address);
  }
  return people.size + addresses.size;
}
