-- Team SSO: an organization's identity provider connections, the domains it proved, the
-- people linked through them and the sign in round trips in flight. Every row carries
-- organization_id under the standard policy. The sign in role reads only the columns it
-- needs to find a connection, never the sealed client secret, and is the only role that
-- links an identity, so organization work cannot map its own IdP subject onto anyone.

-- Up Migration
alter table app.organizations
  add column sso_enforcement text not null default 'off'
    check (sso_enforcement in ('off', 'verified_domains', 'everyone')),
  add column sso_enforcement_since timestamptz,
  -- Set exactly while enforcement is on, so "since when" can never disagree with "whether".
  add constraint organizations_sso_enforcement_since
    check ((sso_enforcement = 'off') = (sso_enforcement_since is null));

create table app.sso_connections (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  protocol text not null check (protocol in ('oidc', 'saml')),
  status text not null default 'draft' check (status in ('draft', 'test', 'active', 'disabled')),
  display_name text not null check (char_length(display_name) between 1 and 100),
  oidc_issuer text check (char_length(oidc_issuer) between 1 and 2048),
  oidc_client_id text check (char_length(oidc_client_id) between 1 and 512),
  oidc_client_secret_sealed bytea check (octet_length(oidc_client_secret_sealed) between 1 and 4096),
  -- The cached discovery document's endpoints.
  oidc_endpoints jsonb check (jsonb_typeof(oidc_endpoints) = 'object'),
  saml_idp_entity_id text check (char_length(saml_idp_entity_id) between 1 and 2048),
  saml_idp_sso_url text check (char_length(saml_idp_sso_url) between 1 and 2048),
  -- Up to three, so a certificate can rotate without a gap.
  saml_idp_certs text[]
    check (cardinality(saml_idp_certs) <= 3 and array_position(saml_idp_certs, null) is null),
  jit_enabled boolean not null default false,
  jit_default_project_role text check (jit_default_project_role in ('editor', 'viewer')),
  -- Null means the global session lifetime.
  session_max_seconds integer check (session_max_seconds between 3600 and 2592000),
  version integer not null default 1 check (version >= 1),
  created_by uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sso_connections_organization_id_id_key unique (organization_id, id),
  constraint sso_connections_organization_idempotency_key unique (organization_id, idempotency_key),
  -- Only the creator is cleared when their membership goes, never the connection.
  constraint sso_connections_created_by_fkey foreign key (organization_id, created_by)
    references app.memberships (organization_id, id) on delete set null (created_by)
);

create index sso_connections_created_by_idx on app.sso_connections (organization_id, created_by);

create table app.sso_domains (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  connection_id uuid not null,
  -- ASCII and lower case, punycode for anything else, so one domain has one spelling.
  domain text not null check (
    char_length(domain) <= 253
    and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  txt_token_hash bytea not null check (octet_length(txt_token_hash) = 32),
  verified_at timestamptz,
  last_checked_at timestamptz,
  failed_checks integer not null default 0 check (failed_checks between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A claim is idempotent per organization.
  constraint sso_domains_organization_domain_key unique (organization_id, domain),
  constraint sso_domains_connection_fkey foreign key (organization_id, connection_id)
    references app.sso_connections (organization_id, id) on delete cascade
);

-- Any number of organizations may claim a domain, but only one holds it verified, because
-- the verified owner's IdP is trusted for every address in it.
create unique index sso_domains_verified_domain_key on app.sso_domains (domain)
  where verified_at is not null;
create index sso_domains_connection_idx on app.sso_domains (organization_id, connection_id);

-- Its own table rather than a provider of identities, which is unique per person and
-- provider: a person who works for two organizations holds an SSO link in each.
create table app.sso_identities (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  connection_id uuid not null,
  user_id uuid not null references app.users (id) on delete cascade,
  -- Keyed by subject, never by address, so an IdP that lets users edit their email claim
  -- cannot reach another account.
  subject text not null check (char_length(subject) between 1 and 1024),
  email_normalized text not null check (char_length(email_normalized) between 3 and 254),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sso_identities_subject_key unique (organization_id, connection_id, subject),
  constraint sso_identities_user_key unique (organization_id, connection_id, user_id),
  constraint sso_identities_connection_fkey foreign key (organization_id, connection_id)
    references app.sso_connections (organization_id, id) on delete cascade
);

-- The person's own list, and the cascade from users.
create index sso_identities_user_id_idx on app.sso_identities (user_id);

create table app.sso_states (
  -- Random and looked up before the callback knows its organization.
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  organization_id uuid not null references app.organizations (organization_id),
  connection_id uuid not null,
  protocol text not null check (protocol in ('oidc', 'saml')),
  code_verifier text check (char_length(code_verifier) between 43 and 128),
  nonce text check (char_length(nonce) between 16 and 128),
  saml_request_id text check (char_length(saml_request_id) between 1 and 256),
  browser_hash bytea not null check (octet_length(browser_hash) = 32),
  return_to text check (char_length(return_to) <= 2048),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sso_states_protocol_fields check (
    (protocol = 'oidc' and code_verifier is not null and nonce is not null
      and saml_request_id is null)
    or (protocol = 'saml' and saml_request_id is not null and code_verifier is null
      and nonce is null)),
  constraint sso_states_connection_fkey foreign key (organization_id, connection_id)
    references app.sso_connections (organization_id, id) on delete cascade
);

create index sso_states_expires_at_idx on app.sso_states (expires_at);
create index sso_states_connection_idx on app.sso_states (organization_id, connection_id);

alter table app.sso_connections enable row level security;
alter table app.sso_connections force row level security;
alter table app.sso_domains enable row level security;
alter table app.sso_domains force row level security;
alter table app.sso_identities enable row level security;
alter table app.sso_identities force row level security;
alter table app.sso_states enable row level security;
alter table app.sso_states force row level security;

-- Organization work edits a connection in place, but never moves it, its creator or its
-- idempotency key, and never switches its protocol.
revoke update on app.sso_connections from drefyn_app;
grant update (status, display_name, oidc_issuer, oidc_client_id, oidc_client_secret_sealed,
    oidc_endpoints, saml_idp_entity_id, saml_idp_sso_url, saml_idp_certs, jit_enabled,
    jit_default_project_role, session_max_seconds, version, updated_at)
  on app.sso_connections to drefyn_app;

-- A claimed domain keeps its name and organization; a different name is a new claim.
revoke update on app.sso_domains from drefyn_app;
grant update (connection_id, txt_token_hash, verified_at, last_checked_at, failed_checks,
    updated_at)
  on app.sso_domains to drefyn_app;

-- Only sign in links an identity. Organization work may read and remove a link.
revoke insert, update on app.sso_identities from drefyn_app;

-- Sign in state belongs to the sign in role alone.
revoke all on app.sso_states from drefyn_app;

create policy tenant_isolation on app.sso_connections to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());
create policy tenant_isolation on app.sso_domains to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());
create policy tenant_isolation on app.sso_identities to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());
create policy tenant_isolation on app.sso_states to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- A person lists their own links in every organization from account settings.
create policy self_read on app.sso_identities for select to drefyn_app
  using (user_id = app.current_user_id());

-- Discovery and sign in run before anyone is signed in. Per column, so the sealed secret and
-- any column added later stay closed to the sign in role.
grant select (id, organization_id, protocol, status, display_name, oidc_issuer, oidc_client_id,
    oidc_endpoints, saml_idp_entity_id, saml_idp_sso_url, saml_idp_certs, jit_enabled,
    jit_default_project_role, session_max_seconds)
  on app.sso_connections to drefyn_auth;
create policy auth_read on app.sso_connections for select to drefyn_auth using (true);

-- Discovery only ever answers with a verified domain, so the sign in role sees no claim in
-- progress.
grant select (domain, organization_id, connection_id, verified_at)
  on app.sso_domains to drefyn_auth;
create policy auth_read on app.sso_domains for select to drefyn_auth
  using (verified_at is not null);

grant select (id, organization_id, connection_id, user_id, subject, email_normalized,
    last_used_at, created_at)
  on app.sso_identities to drefyn_auth;
grant insert (organization_id, connection_id, user_id, subject, email_normalized, last_used_at)
  on app.sso_identities to drefyn_auth;
create policy auth_access on app.sso_identities to drefyn_auth using (true) with check (true);

-- A state is consumed with delete ... returning, and the expiry cleanup deletes by ctid.
grant select (ctid, state_hash, organization_id, connection_id, protocol, code_verifier, nonce,
    saml_request_id, browser_hash, return_to, expires_at, created_at)
  on app.sso_states to drefyn_auth;
grant insert (state_hash, organization_id, connection_id, protocol, code_verifier, nonce,
    saml_request_id, browser_hash, return_to, expires_at)
  on app.sso_states to drefyn_auth;
grant delete on app.sso_states to drefyn_auth;
create policy auth_access on app.sso_states to drefyn_auth using (true) with check (true);

-- No foreign key into sso_connections: sessions are global, and a key from a global table
-- into a tenant one is refused by the catalog rules. The pair is checked instead, and the
-- index lets removing a connection find its sessions.
alter table app.sessions
  add column sso_connection_id uuid,
  add column sso_organization_id uuid,
  add constraint sessions_sso_check check (
    (method = 'sso' and sso_connection_id is not null and sso_organization_id is not null)
    or (method <> 'sso' and sso_connection_id is null and sso_organization_id is null));

create index sessions_sso_connection_idx on app.sessions (sso_organization_id, sso_connection_id)
  where sso_connection_id is not null;

-- The identity migration left this check to Postgres to name. No if exists: a different name
-- must stop the migration rather than leave the old check beside the new one.
alter table app.sessions drop constraint sessions_method_check;
alter table app.sessions add constraint sessions_method_check check (method in
  ('email', 'password', 'github', 'google', 'cli_link', 'sso'));

-- Down Migration
-- Destroys every connection, domain claim and link, so it is only for use before SSO ships.
-- Sessions that signed in through SSO end, since the older check and reader refuse them. The
-- migration role matches no policy, so force is lifted around the delete or it would touch
-- nothing.
alter table app.sessions no force row level security;
delete from app.sessions where method = 'sso';
alter table app.sessions force row level security;
alter table app.sessions drop constraint sessions_method_check;
alter table app.sessions add constraint sessions_method_check check (method in
  ('email', 'password', 'github', 'google', 'cli_link'));
drop index app.sessions_sso_connection_idx;
alter table app.sessions
  drop constraint sessions_sso_check,
  drop column sso_organization_id,
  drop column sso_connection_id;

drop table app.sso_states;
drop table app.sso_identities;
drop table app.sso_domains;
drop table app.sso_connections;

alter table app.organizations
  drop constraint organizations_sso_enforcement_since,
  drop column sso_enforcement_since,
  drop column sso_enforcement;
