// Each list is frozen and each union comes from its list, so the database check, the runtime
// value and the type cannot name different sets.

export const NODE_FAMILIES = Object.freeze([
  'docs_page',
  'studio_item',
  'status_component',
  'status_incident',
  'status_incident_update',
  'status_maintenance',
  'status_postmortem',
] as const);
export type NodeFamily = (typeof NODE_FAMILIES)[number];

// Soft deletion is deleted_at, not a state: a node of any state can be restored as it was.
export const NODE_LIFECYCLES = Object.freeze(['draft', 'published', 'archived'] as const);
export type NodeLifecycle = (typeof NODE_LIFECYCLES)[number];

export const ORIGINS = Object.freeze(['human', 'ai', 'git', 'import'] as const);
export type Origin = (typeof ORIGINS)[number];

export const ENGINE_ERROR_CODES = Object.freeze([
  // Also for another tenant's ids, so a caller cannot tell which it was.
  'engine.not_found',
  'engine.forbidden',
  'engine.version_conflict',
  'engine.validation_failed',
  // The same key with different input.
  'engine.idempotency_conflict',
  // Entitlements refused; content stays readable.
  'engine.limit_reached',
  'engine.filter_not_declared',
  'engine.filter_backfilling',
  // Over limit after a downgrade.
  'engine.read_only',
  'engine.too_large',
  // Nothing is wrong with the request: the database or parse host is down or full. Try again.
  'engine.unavailable',
] as const);
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

// Separate from the engine's own codes, so a caller of publish handles exactly these.
export const PUBLISH_ERROR_CODES = Object.freeze([
  // Also for another tenant's ids.
  'publish.not_found',
  'publish.forbidden',
  'publish.approval_required',
  // Model drafted or approval gated content, and an actor that is not a person.
  'publish.human_required',
  'publish.version_conflict',
  'publish.validation_failed',
  // The same key with different input.
  'publish.idempotency_conflict',
  // Over limit after a downgrade: what is live stays live, and nothing new goes out.
  'publish.read_only',
  // The database is down or busy. Nothing was published; try again.
  'publish.unavailable',
] as const);
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];
