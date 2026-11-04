import { fileURLToPath } from 'node:url';

// Fixed ids, because the flag file targets beta by id. The acme values match the placeholder
// shell, so an owner sees every entry and the screenshots do not move.
export const ACME_ID = '01900000-0000-7000-8000-000000000a01';
export const BETA_ID = '01900000-0000-7000-8000-000000000b01';
// The settings spec changes people and keys here, so no other spec reads this organization.
export const KESTREL_ID = '01900000-0000-7000-8000-000000000c01';

export interface Person {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const person = (key: string, suffix: string, name: string, email: string): Person => ({
  key,
  id: `01900000-0000-7000-8000-00000000${suffix}`,
  name,
  email,
});

export const MAYA = person('maya', '0001', 'Maya Okafor', 'maya@acme.dev');
export const ADA = person('ada', '0002', 'Ada Lindqvist', 'ada@acme.dev');
export const SAM = person('sam', '0003', 'Sam Reyes', 'sam@acme.dev');
export const NOOR = person('noor', '0004', 'Noor Haddad', 'noor@beta.dev');
// Belongs to nothing, for the page that person lands on.
export const ZARA = person('zara', '0005', 'Zara Ito', 'zara@example.dev');

export const OMAR = person('omar', '0006', 'Omar Bello', 'omar@kestrel.dev');
export const TESS = person('tess', '0007', 'Tess Moore', 'tess@kestrel.dev');
export const RAFA = person('rafa', '0008', 'Rafa Dias', 'rafa@kestrel.dev');

export const PEOPLE: readonly Person[] = [MAYA, ADA, SAM, NOOR, ZARA, OMAR, TESS, RAFA];

export const stateFile = (who: Person): string =>
  fileURLToPath(new URL(`./.auth/${who.key}.json`, import.meta.url));

export const SIGNED_OUT = { cookies: [], origins: [] };
