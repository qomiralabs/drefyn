// Placeholder data until the product APIs exist. The e2e specs reach every state through
// these projects, so their slugs and copy are part of the test contract.
export const PLACEHOLDER = {
  organization: { id: 'org_acme', slug: 'acme', name: 'Acme', plan: 'Starter' },
  person: { name: 'Maya Okafor', initials: 'MO', email: 'maya@acme.dev' },
  inbox: { needsYou: 3 },
  projects: {
    // Success: the calm home with an answer.
    'payments-api': { id: 'prj_payments', product: 'docs', name: 'Payments API docs' },
    // Empty: no pages yet.
    'new-docs': { id: 'prj_new', product: 'docs', name: 'New docs' },
    // Error: the project fails to load.
    unreachable: { id: 'prj_unreachable', product: 'docs', name: 'Partner API docs' },
    // Loading: the data never arrives, so the skeleton stays.
    pending: { id: 'prj_pending', product: 'docs', name: 'Pending docs' },
    'acme-status': { id: 'prj_status', product: 'status', name: 'Acme status' },
  },
} as const;
