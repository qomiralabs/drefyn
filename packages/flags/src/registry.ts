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
]);

export type Flags = typeof flags;
export type FlagName = Flags[number]['name'];
