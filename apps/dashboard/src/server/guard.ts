import { PLACEHOLDER } from '../fixtures/placeholder.ts';

// TODO(#59): refuse unknown organizations and the flag before anything renders.
export const guardOrganization = (_org: string) => Promise.resolve(PLACEHOLDER.organization);
