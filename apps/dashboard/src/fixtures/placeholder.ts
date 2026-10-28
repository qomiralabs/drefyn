// Placeholder data until the product APIs exist. The e2e specs reach every state through
// these projects, so their slugs and copy are part of the test contract.
export const PLACEHOLDER = {
  organization: { id: 'org_acme', slug: 'acme', name: 'Acme', plan: 'Starter' },
  person: { name: 'Maya Okafor', initials: 'MO', email: 'maya@acme.dev' },
  inbox: { needsYou: 2 },
  projects: {
    // Success: the calm home with an answer.
    'payments-api': {
      id: 'prj_payments',
      product: 'docs',
      name: 'Payments API docs',
      answer: '3 pages are out of date.',
    },
    // Empty: no pages yet.
    'new-docs': { id: 'prj_new', product: 'docs', name: 'New docs', answer: 'No pages yet.' },
    // Error: the project fails to load.
    // Also over the Starter limit, so it is read only.
    unreachable: {
      id: 'prj_unreachable',
      product: 'docs',
      name: 'Partner API docs',
      answer: 'Read only. Nothing was deleted.',
      readOnly: true,
    },
    // Loading: the data never arrives, so the skeleton stays.
    pending: {
      id: 'prj_pending',
      product: 'docs',
      name: 'Pending docs',
      answer: 'Waiting for its first check.',
    },
    'acme-status': {
      id: 'prj_status',
      product: 'status',
      name: 'Acme status',
      answer: 'Everything is running.',
    },
  },
} as const;
