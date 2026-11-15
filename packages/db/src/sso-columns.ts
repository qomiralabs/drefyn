import type {
  ColumnType,
  SsoConnectionsTable,
  SsoDomainsTable,
  SsoIdentitiesTable,
  SsoStatesTable,
} from './schema.generated.ts';

// What the sign in role holds on the SSO tables, written once. The catalog allow list and
// AuthSchema are both built from this, so a query can never name a column the role cannot
// touch, and check:catalog holds the migration to the same list.

export const SSO_CONNECTION_AUTH_SELECT = [
  'id',
  'organization_id',
  'protocol',
  'status',
  'display_name',
  'oidc_issuer',
  'oidc_client_id',
  'oidc_endpoints',
  'saml_idp_entity_id',
  'saml_idp_sso_url',
  'saml_idp_certs',
  'jit_enabled',
  'jit_default_project_role',
  'session_max_seconds',
] as const satisfies readonly (keyof SsoConnectionsTable)[];

export const SSO_DOMAIN_AUTH_SELECT = [
  'domain',
  'organization_id',
  'connection_id',
  'verified_at',
] as const satisfies readonly (keyof SsoDomainsTable)[];

export const SSO_IDENTITY_AUTH_SELECT = [
  'id',
  'organization_id',
  'connection_id',
  'user_id',
  'subject',
  'email_normalized',
  'last_used_at',
  'created_at',
] as const satisfies readonly (keyof SsoIdentitiesTable)[];

export const SSO_IDENTITY_AUTH_INSERT = [
  'organization_id',
  'connection_id',
  'user_id',
  'subject',
  'email_normalized',
  'last_used_at',
] as const satisfies readonly (keyof SsoIdentitiesTable)[];

// Sign in marks when a link was last used. Nothing else about a link ever changes.
export const SSO_IDENTITY_AUTH_UPDATE = [
  'last_used_at',
] as const satisfies readonly (keyof SsoIdentitiesTable)[];

export const SSO_STATE_AUTH_SELECT = [
  'state_hash',
  'organization_id',
  'connection_id',
  'protocol',
  'code_verifier',
  'nonce',
  'saml_request_id',
  'browser_hash',
  'return_to',
  'expires_at',
  'created_at',
] as const satisfies readonly (keyof SsoStatesTable)[];

export const SSO_STATE_AUTH_INSERT = [
  'state_hash',
  'organization_id',
  'connection_id',
  'protocol',
  'code_verifier',
  'nonce',
  'saml_request_id',
  'browser_hash',
  'return_to',
  'expires_at',
] as const satisfies readonly (keyof SsoStatesTable)[];

export interface SsoAuthGrant {
  readonly name: string;
  readonly privilege: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly reason: string;
}

// Why the sign in role reaches each table, before anyone is signed in.
const CONNECTION_REASON =
  'discovery and sign in find the connection; never the sealed client secret or a later column';
const DOMAIN_REASON = 'discovery maps a verified domain to its organization and connection';
const IDENTITY_REASON = 'sign in finds the person by subject and links a new one';
const STATE_REASON =
  'the round trip is written at start, consumed once at the callback and swept after expiry';

const columns = (
  table: string,
  privilege: 'SELECT' | 'INSERT' | 'UPDATE',
  list: readonly string[],
  reason: string,
): SsoAuthGrant[] => list.map((column) => ({ name: `app.${table}.${column}`, privilege, reason }));

export const SSO_AUTH_GRANTS: readonly SsoAuthGrant[] = [
  ...columns('sso_connections', 'SELECT', SSO_CONNECTION_AUTH_SELECT, CONNECTION_REASON),
  ...columns('sso_domains', 'SELECT', SSO_DOMAIN_AUTH_SELECT, DOMAIN_REASON),
  ...columns('sso_identities', 'SELECT', SSO_IDENTITY_AUTH_SELECT, IDENTITY_REASON),
  ...columns('sso_identities', 'INSERT', SSO_IDENTITY_AUTH_INSERT, IDENTITY_REASON),
  ...columns(
    'sso_identities',
    'UPDATE',
    SSO_IDENTITY_AUTH_UPDATE,
    'sign in marks when a link was last used',
  ),
  ...columns('sso_states', 'SELECT', SSO_STATE_AUTH_SELECT, STATE_REASON),
  ...columns('sso_states', 'INSERT', SSO_STATE_AUTH_INSERT, STATE_REASON),
  // A state is consumed by delete ... returning, and the expiry cleanup deletes by ctid.
  { name: 'app.sso_states.ctid', privilege: 'SELECT', reason: STATE_REASON },
  { name: 'app.sso_states', privilege: 'DELETE', reason: STATE_REASON },
];

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;
type InsertOf<C> = C extends ColumnType<unknown, infer I, unknown> ? I : C;
type UpdateOf<C> = C extends ColumnType<unknown, unknown, infer U> ? U : C;

type Listed<L, K> = L extends readonly (infer E)[] ? (K extends E ? true : false) : false;

// Readable, insertable and updatable only as granted.
type AuthColumns<
  T,
  S extends readonly (keyof T)[],
  I extends readonly (keyof T)[],
  U extends readonly (keyof T)[] = readonly [],
> = {
  [K in S[number] | I[number] | U[number]]: ColumnType<
    Listed<S, K> extends true ? SelectOf<T[K]> : never,
    Listed<I, K> extends true ? InsertOf<T[K]> : never,
    Listed<U, K> extends true ? UpdateOf<T[K]> : never
  >;
};

export type AuthSsoConnectionsTable = AuthColumns<
  SsoConnectionsTable,
  typeof SSO_CONNECTION_AUTH_SELECT,
  readonly []
>;
export type AuthSsoDomainsTable = AuthColumns<
  SsoDomainsTable,
  typeof SSO_DOMAIN_AUTH_SELECT,
  readonly []
>;
export type AuthSsoIdentitiesTable = AuthColumns<
  SsoIdentitiesTable,
  typeof SSO_IDENTITY_AUTH_SELECT,
  typeof SSO_IDENTITY_AUTH_INSERT,
  typeof SSO_IDENTITY_AUTH_UPDATE
>;
export type AuthSsoStatesTable = AuthColumns<
  SsoStatesTable,
  typeof SSO_STATE_AUTH_SELECT,
  typeof SSO_STATE_AUTH_INSERT
>;
