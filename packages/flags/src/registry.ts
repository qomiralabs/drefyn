import { defineFlags } from './definitions.ts';

export const flags = defineFlags([
  {
    name: 'product.docs',
    kind: 'release',
    owner: 'Divine572',
    description: 'Drefyn Docs is available to organizations.',
    created: '2026-10-26',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'product.studio',
    kind: 'release',
    owner: 'Divine572',
    description: 'Drefyn Studio is available to organizations.',
    created: '2026-10-26',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'product.status',
    kind: 'release',
    owner: 'Divine572',
    description: 'Drefyn Status is available to organizations.',
    created: '2026-10-26',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'dashboard.shell',
    kind: 'release',
    owner: 'Divine572',
    description: 'The dashboard shell: top bar, sidebar and product homes.',
    created: '2026-10-27',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'email.smtp_delivery',
    kind: 'release',
    owner: 'Divine572',
    description: 'Real mail delivery from the dashboard through the configured SMTP relay.',
    created: '2026-11-04',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'engine.writes',
    kind: 'release',
    owner: 'Divine572',
    description: 'The content engine accepts writes: creating nodes, saves and rollbacks.',
    created: '2026-11-06',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'engine.chunk_at_write',
    kind: 'release',
    owner: 'Divine572',
    description: 'Saves and rollbacks write chunks and an embedding outbox row with the version.',
    created: '2026-11-06',
    removeBy: '2027-06-30',
    safeValue: false,
  },
  {
    name: 'auth.team_sso',
    kind: 'release',
    owner: 'Divine572',
    description: 'Continue with SSO on sign in, and SSO settings for organizations.',
    created: '2026-11-14',
    removeBy: '2027-06-30',
    safeValue: false,
  },
]);

export type Flags = typeof flags;
export type FlagName = Flags[number]['name'];
