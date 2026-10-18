// The plan table. Every limit and feature any product checks is one line here, so a
// plan change is one reviewed edit and takes effect in Docs, Studio and Status at once.

export const TIERS = Object.freeze([
  'free',
  'starter',
  'growth',
  'scale',
  'enterprise',
  'self_hosted',
] as const);
export type Tier = (typeof TIERS)[number];
export type HostedTier = Exclude<Tier, 'self_hosted'>;

export const PRODUCTS = Object.freeze(['docs', 'studio', 'status'] as const);
export type Product = (typeof PRODUCTS)[number];
export type Scope = 'org' | Product;

// A string, so it survives JSON and can never be added to or compared with a number.
export const UNLIMITED = 'unlimited';
export type LimitValue = number | typeof UNLIMITED;

// Decimal, the way the plans write GB.
const GB = 1_000_000_000;

// A cell the plans leave open. It resolves to the most generous value they prove and no
// more: the tier below's number (at_least), a stated ceiling (at_most), or 0 when there
// is no bound at all, so nothing runs on a forgotten guess.
export interface Placeholder {
  readonly basis: 'at_least' | 'at_most' | 'unset';
  readonly value: number;
}
const atLeast = (value: number): Placeholder => ({ basis: 'at_least', value });
const atMost = (value: number): Placeholder => ({ basis: 'at_most', value });
const unset: Placeholder = { basis: 'unset', value: 0 };

export type Cell = LimitValue | Placeholder;

export interface LimitRow {
  readonly scope: Scope;
  // min is a floor, such as the shortest check interval; there UNLIMITED means no floor.
  readonly direction: 'max' | 'min';
  // Only the monthly send caps have the 25 percent grace for eligible sends.
  readonly grace: boolean;
  // self_hosted is unlimited by rule; the type stops a guess from landing there.
  readonly cells: Readonly<Record<HostedTier, Cell> & { self_hosted: typeof UNLIMITED }>;
}

const U = UNLIMITED;

// Columns: free, starter, growth, scale, enterprise. Every limit counts per organization;
// scope names the product that owns the counter.
const row = (
  scope: Scope,
  [free, starter, growth, scale, enterprise]: readonly [Cell, Cell, Cell, Cell, Cell],
  options: { readonly direction?: 'min'; readonly grace?: true } = {},
): LimitRow => ({
  scope,
  direction: options.direction ?? 'max',
  grace: options.grace ?? false,
  cells: { free, starter, growth, scale, enterprise, self_hosted: U },
});

export const LIMITS = {
  'org.seats': row('org', [2, 5, 20, U, U]),
  'org.docs_projects': row('org', [1, 1, 3, 10, atLeast(10)]),
  'org.studio_projects': row('org', [1, 1, 3, 10, atLeast(10)]),
  // Every status page counts here; private pages also count against the next row.
  'org.status_pages': row('org', [1, 2, 5, 20, atLeast(20)]),
  // Free allows one public page only; from Starter a page may be of any type.
  'org.private_status_pages': row('org', [0, 2, 5, 20, atLeast(20)]),

  'docs.pages': row('docs', [50, 300, atLeast(300), atLeast(300), atLeast(300)]),
  'docs.storage_bytes': row('docs', [
    1 * GB,
    10 * GB,
    atLeast(10 * GB),
    atLeast(10 * GB),
    atLeast(10 * GB),
  ]),
  'docs.bandwidth_bytes_per_month': row('docs', [
    20 * GB,
    100 * GB,
    atLeast(100 * GB),
    atLeast(100 * GB),
    atLeast(100 * GB),
  ]),

  // Studio caps are promised but not yet numbered, so hosted Studio stays closed.
  'studio.items': row('studio', [unset, unset, unset, unset, unset]),
  'studio.assets': row('studio', [unset, unset, unset, unset, unset]),
  'studio.api_requests_per_month': row('studio', [unset, unset, unset, unset, unset]),

  // A component is one content node with no material cost, so paid tiers carry no cap.
  'status.components': row('status', [25, U, U, U, U]),
  'status.monitors': row('status', [10, 50, 200, 1000, atLeast(1000)]),
  'status.check_interval_seconds': row('status', [180, 60, 30, 30, atMost(30)], {
    direction: 'min',
  }),
  // "All regions" puts no cap on the count.
  'status.regions': row('status', [3, 6, U, U, U]),
  'status.subscribers': row('status', [500, U, U, U, U]),
  'status.private_probes': row('status', [0, 1, 5, U, U]),
  // Growth states no history; it cannot be shorter than Starter's year.
  'status.history_days': row('status', [90, 365, atLeast(365), U, U]),
  // Enterprise carries the published floor; contracts raise it through overrides.
  'status.email_sends_per_month': row('status', [2000, 5000, 15000, 50000, 250000], {
    grace: true,
  }),
  'status.sms_sends_per_month': row('status', [0, 50, 200, 750, 5000], { grace: true }),
  'status.voice_minutes_per_month': row('status', [0, 0, 30, 150, 1000], { grace: true }),
} as const satisfies Record<string, LimitRow>;

export type LimitKey = keyof typeof LIMITS;

export interface FeatureRow {
  readonly scope: Scope;
  // The cheapest hosted tier that has it; every dearer hosted tier has it too.
  readonly since: HostedTier;
  // False only for what the hosted service itself runs; the open core gates nothing.
  readonly openCore: boolean;
}

const feature = (scope: Scope, since: HostedTier, openCore = true): FeatureRow => ({
  scope,
  since,
  openCore,
});

export const FEATURES = {
  'docs.git_editing': feature('docs', 'free'),
  'docs.visual_editing': feature('docs', 'free'),
  'docs.search': feature('docs', 'free'),
  'docs.custom_domain': feature('docs', 'free'),
  'docs.remove_badge': feature('docs', 'starter'),
  'docs.openapi_reference': feature('docs', 'starter'),
  'docs.staleness_basic': feature('docs', 'starter'),
  'docs.analytics_basic': feature('docs', 'starter'),
  'docs.staleness_automatic': feature('docs', 'growth'),
  'docs.versioning': feature('docs', 'growth'),
  'docs.editorial_workflow': feature('docs', 'growth'),
  'docs.widgets': feature('docs', 'growth'),
  'docs.retrieval_api': feature('docs', 'growth'),
  'docs.mcp': feature('docs', 'growth'),
  'docs.incident_banners': feature('docs', 'growth'),
  'docs.localization': feature('docs', 'scale'),
  'docs.support_integrations': feature('docs', 'scale'),
  'docs.advanced_roles': feature('docs', 'scale'),
  'docs.advanced_analytics': feature('docs', 'scale'),

  'studio.schema_builder': feature('studio', 'free'),
  'studio.rest_api': feature('studio', 'free'),
  'studio.graphql_api': feature('studio', 'free'),
  'studio.management_ui': feature('studio', 'free'),
  'studio.custom_roles': feature('studio', 'starter'),
  'studio.realtime_collaboration': feature('studio', 'growth'),
  'studio.editorial_workflow': feature('studio', 'growth'),
  'studio.retrieval_api': feature('studio', 'growth'),
  'studio.mcp': feature('studio', 'growth'),
  'studio.localization': feature('studio', 'growth'),
  'studio.advanced_permissions': feature('studio', 'scale'),
  'studio.advanced_analytics': feature('studio', 'scale'),
  'studio.integrations': feature('studio', 'scale'),

  'status.statuspage_importer': feature('status', 'free'),
  // Email is on for every plan; what it costs is bounded by the monthly email send cap.
  'status.notify_email': feature('status', 'free'),
  // These channels cost us nothing per send, so they stay free on every plan.
  'status.notify_rss': feature('status', 'free'),
  'status.notify_slack': feature('status', 'free'),
  'status.notify_webhook': feature('status', 'free'),
  'status.notify_teams': feature('status', 'free'),
  'status.notify_discord': feature('status', 'free'),
  'status.custom_domain': feature('status', 'starter'),
  'status.remove_badge': feature('status', 'starter'),
  'status.heartbeat_checks': feature('status', 'starter'),
  'status.ssl_checks': feature('status', 'starter'),
  'status.notify_sms': feature('status', 'starter'),
  'status.component_subscriptions': feature('status', 'starter'),
  'status.ai_drafted_updates': feature('status', 'starter'),
  'status.custom_css': feature('status', 'starter'),
  'status.notify_voice': feature('status', 'growth'),
  'status.audience_pages': feature('status', 'growth'),
  'status.private_page_oidc_login': feature('status', 'growth'),
  'status.docs_incident_banners': feature('status', 'growth'),
  'status.openapi_components': feature('status', 'growth'),
  'status.mcp_and_retrieval': feature('status', 'growth'),
  'status.incident_integrations': feature('status', 'growth'),
  'status.approval_rules': feature('status', 'growth'),
  'status.sla_reports': feature('status', 'growth'),
  'status.multi_language_pages': feature('status', 'growth'),
  'status.browser_checks': feature('status', 'scale'),
  'status.html_templating': feature('status', 'scale'),
  'status.white_label': feature('status', 'scale'),
  'status.per_customer_sla_reports': feature('status', 'scale'),
  'status.escalation_policies': feature('status', 'scale'),
  'status.advanced_roles': feature('status', 'scale'),
  'status.private_page_saml': feature('status', 'enterprise'),
  // Run by the hosted probe fleet and our contract; a self host has its own IPs and no SLA from us.
  'status.dedicated_probe_ips': feature('status', 'enterprise', false),
  'status.contractual_sla': feature('status', 'enterprise', false),

  'org.sso_saml': feature('org', 'enterprise'),
  'org.audit_logs': feature('org', 'enterprise'),
} as const satisfies Record<string, FeatureRow>;

export type FeatureKey = keyof typeof FEATURES;
