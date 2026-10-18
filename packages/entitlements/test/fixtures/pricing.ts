// Transcribed by hand from the published plan table, the Docs, Studio and Status tier
// tables and the monthly send caps. Kept apart from the package on purpose: if the
// table in src drifts from the pricing, this file is the thing that notices.

export const TIERS = ['free', 'starter', 'growth', 'scale', 'enterprise', 'self_hosted'] as const;
export type FixtureTier = (typeof TIERS)[number];

// Hosted tiers from cheapest to most expensive. self_hosted sits outside the ladder.
export const HOSTED_LADDER = ['free', 'starter', 'growth', 'scale', 'enterprise'] as const;
export type HostedTier = (typeof HOSTED_LADDER)[number];

export const PRODUCTS = ['docs', 'studio', 'status'] as const;

// Storage and bandwidth are in bytes with decimal gigabytes, the way the pricing writes GB.
export const GB = 1_000_000_000;

// A cell the pricing leaves open. It resolves to the most generous value the pricing
// proves and no more: its bound if it has one, otherwise 0 (not entitled until
// calibrated), which is why hosted Studio caps are 0 today.
export interface Placeholder {
  readonly placeholder: true;
  readonly atLeast?: number;
  readonly atMost?: number;
}
export type Cell = number | 'unlimited' | Placeholder;

const open = (bounds: { atLeast?: number; atMost?: number } = {}): Placeholder => ({
  placeholder: true,
  ...bounds,
});

// Every limit counts per organization. Scope names the product that owns the counter,
// not the unit it is counted in.
export interface LimitRow {
  readonly scope: 'org' | 'docs' | 'studio' | 'status';
  readonly direction: 'max' | 'min';
  readonly cells: Readonly<Record<FixtureTier, Cell>>;
}

export const LIMITS = {
  'org.seats': {
    scope: 'org',
    direction: 'max',
    cells: {
      free: 2,
      starter: 5,
      growth: 20,
      scale: 'unlimited',
      enterprise: 'unlimited',
      self_hosted: 'unlimited',
    },
  },
  'org.docs_projects': {
    scope: 'org',
    direction: 'max',
    cells: {
      free: 1,
      starter: 1,
      growth: 3,
      scale: 10,
      enterprise: open({ atLeast: 10 }),
      self_hosted: 'unlimited',
    },
  },
  'org.studio_projects': {
    scope: 'org',
    direction: 'max',
    cells: {
      free: 1,
      starter: 1,
      growth: 3,
      scale: 10,
      enterprise: open({ atLeast: 10 }),
      self_hosted: 'unlimited',
    },
  },
  // Every status page counts here; private pages also count against the next row.
  'org.status_pages': {
    scope: 'org',
    direction: 'max',
    cells: {
      free: 1,
      starter: 2,
      growth: 5,
      scale: 20,
      enterprise: open({ atLeast: 20 }),
      self_hosted: 'unlimited',
    },
  },
  // Free allows one public page only; from Starter pages are of any type.
  'org.private_status_pages': {
    scope: 'org',
    direction: 'max',
    cells: {
      free: 0,
      starter: 2,
      growth: 5,
      scale: 20,
      enterprise: open({ atLeast: 20 }),
      self_hosted: 'unlimited',
    },
  },
  'docs.pages': {
    scope: 'docs',
    direction: 'max',
    cells: {
      free: 50,
      starter: 300,
      growth: open({ atLeast: 300 }),
      scale: open({ atLeast: 300 }),
      enterprise: open({ atLeast: 300 }),
      self_hosted: 'unlimited',
    },
  },
  'docs.storage_bytes': {
    scope: 'docs',
    direction: 'max',
    cells: {
      free: 1 * GB,
      starter: 10 * GB,
      growth: open({ atLeast: 10 * GB }),
      scale: open({ atLeast: 10 * GB }),
      enterprise: open({ atLeast: 10 * GB }),
      self_hosted: 'unlimited',
    },
  },
  'docs.bandwidth_bytes_per_month': {
    scope: 'docs',
    direction: 'max',
    cells: {
      free: 20 * GB,
      starter: 100 * GB,
      growth: open({ atLeast: 100 * GB }),
      scale: open({ atLeast: 100 * GB }),
      enterprise: open({ atLeast: 100 * GB }),
      self_hosted: 'unlimited',
    },
  },
  // The pricing says "sensible caps" and "higher caps" without numbers.
  'studio.items': {
    scope: 'studio',
    direction: 'max',
    cells: {
      free: open(),
      starter: open(),
      growth: open(),
      scale: open(),
      enterprise: open(),
      self_hosted: 'unlimited',
    },
  },
  'studio.assets': {
    scope: 'studio',
    direction: 'max',
    cells: {
      free: open(),
      starter: open(),
      growth: open(),
      scale: open(),
      enterprise: open(),
      self_hosted: 'unlimited',
    },
  },
  'studio.api_requests_per_month': {
    scope: 'studio',
    direction: 'max',
    cells: {
      free: open(),
      starter: open(),
      growth: open(),
      scale: open(),
      enterprise: open(),
      self_hosted: 'unlimited',
    },
  },
  'status.components': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 25,
      starter: open({ atLeast: 25 }),
      growth: open({ atLeast: 25 }),
      scale: open({ atLeast: 25 }),
      enterprise: open({ atLeast: 25 }),
      self_hosted: 'unlimited',
    },
  },
  'status.monitors': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 10,
      starter: 50,
      growth: 200,
      scale: 1000,
      enterprise: open({ atLeast: 1000 }),
      self_hosted: 'unlimited',
    },
  },
  // A floor: the shortest interval a monitor may run at. Unlimited means no floor.
  'status.check_interval_seconds': {
    scope: 'status',
    direction: 'min',
    cells: {
      free: 180,
      starter: 60,
      growth: 30,
      scale: 30,
      enterprise: open({ atMost: 30 }),
      self_hosted: 'unlimited',
    },
  },
  // Growth and up check "from all regions", which is no cap on the count.
  'status.regions': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 3,
      starter: 6,
      growth: 'unlimited',
      scale: 'unlimited',
      enterprise: 'unlimited',
      self_hosted: 'unlimited',
    },
  },
  'status.subscribers': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 500,
      starter: 'unlimited',
      growth: 'unlimited',
      scale: 'unlimited',
      enterprise: 'unlimited',
      self_hosted: 'unlimited',
    },
  },
  'status.private_probes': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 0,
      starter: 1,
      growth: 5,
      scale: 'unlimited',
      enterprise: 'unlimited',
      self_hosted: 'unlimited',
    },
  },
  // Growth does not state its history; it cannot be shorter than Starter's year.
  'status.history_days': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 90,
      starter: 365,
      growth: open({ atLeast: 365 }),
      scale: 'unlimited',
      enterprise: 'unlimited',
      self_hosted: 'unlimited',
    },
  },
  // Enterprise send caps are the published "from" values; contracts raise them.
  'status.email_sends_per_month': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 2000,
      starter: 5000,
      growth: 15000,
      scale: 50000,
      enterprise: 250000,
      self_hosted: 'unlimited',
    },
  },
  'status.sms_sends_per_month': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 0,
      starter: 50,
      growth: 200,
      scale: 750,
      enterprise: 5000,
      self_hosted: 'unlimited',
    },
  },
  'status.voice_minutes_per_month': {
    scope: 'status',
    direction: 'max',
    cells: {
      free: 0,
      starter: 0,
      growth: 30,
      scale: 150,
      enterprise: 1000,
      self_hosted: 'unlimited',
    },
  },
} as const satisfies Record<string, LimitRow>;

export type FixtureLimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as FixtureLimitKey[];

// Keys with the 25 percent grace. Whether a send may use it is the send meter's call.
export const SEND_KEYS = [
  'status.email_sends_per_month',
  'status.sms_sends_per_month',
  'status.voice_minutes_per_month',
] as const satisfies readonly FixtureLimitKey[];

// floor(cap * 25 / 100), so grace never rounds a cap up.
export const GRACE: Readonly<
  Record<HostedTier, Readonly<Record<(typeof SEND_KEYS)[number], number>>>
> = {
  free: {
    'status.email_sends_per_month': 500,
    'status.sms_sends_per_month': 0,
    'status.voice_minutes_per_month': 0,
  },
  starter: {
    'status.email_sends_per_month': 1250,
    'status.sms_sends_per_month': 12,
    'status.voice_minutes_per_month': 0,
  },
  growth: {
    'status.email_sends_per_month': 3750,
    'status.sms_sends_per_month': 50,
    'status.voice_minutes_per_month': 7,
  },
  scale: {
    'status.email_sends_per_month': 12500,
    'status.sms_sends_per_month': 187,
    'status.voice_minutes_per_month': 37,
  },
  enterprise: {
    'status.email_sends_per_month': 62500,
    'status.sms_sends_per_month': 1250,
    'status.voice_minutes_per_month': 250,
  },
};

export interface FeatureRow {
  readonly scope: 'org' | 'docs' | 'studio' | 'status';
  // The cheapest hosted tier that has it; every dearer hosted tier has it too.
  readonly since: HostedTier;
  // Open core features are on for self host; only hosted service features are off.
  readonly selfHosted: boolean;
}

const f = (
  scope: FeatureRow['scope'],
  since: HostedTier,
  selfHosted: FeatureRow['selfHosted'] = true,
) => ({ scope, since, selfHosted }) as const satisfies FeatureRow;

export const FEATURES = {
  'docs.git_editing': f('docs', 'free'),
  'docs.visual_editing': f('docs', 'free'),
  'docs.search': f('docs', 'free'),
  'docs.custom_domain': f('docs', 'free'),
  'docs.remove_badge': f('docs', 'starter'),
  'docs.openapi_reference': f('docs', 'starter'),
  'docs.staleness_basic': f('docs', 'starter'),
  'docs.analytics_basic': f('docs', 'starter'),
  'docs.staleness_automatic': f('docs', 'growth'),
  'docs.versioning': f('docs', 'growth'),
  'docs.editorial_workflow': f('docs', 'growth'),
  'docs.widgets': f('docs', 'growth'),
  'docs.retrieval_api': f('docs', 'growth'),
  'docs.mcp': f('docs', 'growth'),
  'docs.incident_banners': f('docs', 'growth'),
  'docs.localization': f('docs', 'scale'),
  'docs.support_integrations': f('docs', 'scale'),
  'docs.advanced_roles': f('docs', 'scale'),
  'docs.advanced_analytics': f('docs', 'scale'),

  'studio.schema_builder': f('studio', 'free'),
  'studio.rest_api': f('studio', 'free'),
  'studio.graphql_api': f('studio', 'free'),
  'studio.management_ui': f('studio', 'free'),
  'studio.custom_roles': f('studio', 'starter'),
  'studio.realtime_collaboration': f('studio', 'growth'),
  'studio.editorial_workflow': f('studio', 'growth'),
  'studio.retrieval_api': f('studio', 'growth'),
  'studio.mcp': f('studio', 'growth'),
  'studio.localization': f('studio', 'growth'),
  'studio.advanced_permissions': f('studio', 'scale'),
  'studio.advanced_analytics': f('studio', 'scale'),
  'studio.integrations': f('studio', 'scale'),

  'status.statuspage_importer': f('status', 'free'),
  // Free channels stay free on every plan.
  'status.notify_email': f('status', 'free'),
  'status.notify_rss': f('status', 'free'),
  'status.notify_slack': f('status', 'free'),
  'status.notify_webhook': f('status', 'free'),
  'status.notify_teams': f('status', 'free'),
  'status.notify_discord': f('status', 'free'),
  'status.custom_domain': f('status', 'starter'),
  'status.remove_badge': f('status', 'starter'),
  'status.heartbeat_checks': f('status', 'starter'),
  'status.ssl_checks': f('status', 'starter'),
  'status.notify_sms': f('status', 'starter'),
  'status.component_subscriptions': f('status', 'starter'),
  'status.ai_drafted_updates': f('status', 'starter'),
  'status.custom_css': f('status', 'starter'),
  'status.notify_voice': f('status', 'growth'),
  'status.audience_pages': f('status', 'growth'),
  'status.private_page_oidc_login': f('status', 'growth'),
  'status.docs_incident_banners': f('status', 'growth'),
  'status.openapi_components': f('status', 'growth'),
  'status.mcp_and_retrieval': f('status', 'growth'),
  'status.incident_integrations': f('status', 'growth'),
  'status.approval_rules': f('status', 'growth'),
  'status.sla_reports': f('status', 'growth'),
  'status.multi_language_pages': f('status', 'growth'),
  'status.browser_checks': f('status', 'scale'),
  'status.html_templating': f('status', 'scale'),
  'status.white_label': f('status', 'scale'),
  'status.per_customer_sla_reports': f('status', 'scale'),
  'status.escalation_policies': f('status', 'scale'),
  'status.advanced_roles': f('status', 'scale'),
  'status.private_page_saml': f('status', 'enterprise'),
  // Run by the hosted fleet and contract only; a self host has its own IPs and no SLA from us.
  'status.dedicated_probe_ips': f('status', 'enterprise', false),
  'status.contractual_sla': f('status', 'enterprise', false),

  'org.sso_saml': f('org', 'enterprise'),
  'org.audit_logs': f('org', 'enterprise'),
} as const satisfies Record<string, FeatureRow>;

export type FixtureFeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FixtureFeatureKey[];

export function isPlaceholder(cell: Cell): cell is Placeholder {
  return typeof cell === 'object';
}

export function placeholderCells(): { tier: FixtureTier; key: FixtureLimitKey }[] {
  const cells: { tier: FixtureTier; key: FixtureLimitKey }[] = [];
  for (const key of LIMIT_KEYS) {
    const row: LimitRow = LIMITS[key];
    for (const tier of TIERS) {
      if (isPlaceholder(row.cells[tier])) cells.push({ tier, key });
    }
  }
  return cells;
}
