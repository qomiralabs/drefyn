-- The identity tables. None carries organization_id: a person exists before and across
-- organizations. drefyn_auth reaches the tables sign in needs, before anyone is known;
-- drefyn_app reaches the person's own rows under a user context. Default privileges hand
-- drefyn_app DML on every new table, so each table below states its grants in full.

-- Up Migration
create table app.users (
  id uuid primary key default uuidv7(),
  email text not null check (char_length(email) between 3 and 254),
  email_normalized text not null check (char_length(email_normalized) between 3 and 254),
  display_name text check (char_length(display_name) between 1 and 200),
  email_verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_normalized_key unique (email_normalized)
);

alter table app.users enable row level security;
alter table app.users force row level security;

-- Per column, so a column added later is closed to both roles until someone grants it. Only
-- sign up and the email change flow write the address, through drefyn_auth.
revoke all on app.users from drefyn_app;
grant select (id, email, display_name, created_at) on app.users to drefyn_app;
grant update (display_name, updated_at) on app.users to drefyn_app;
grant select (id, email, email_normalized, display_name, email_verified_at, created_at, updated_at)
  on app.users to drefyn_auth;
grant insert (id, email, email_normalized, display_name, email_verified_at)
  on app.users to drefyn_auth;
grant update (email, email_normalized, email_verified_at, updated_at) on app.users to drefyn_auth;

create policy auth_access on app.users to drefyn_auth using (true) with check (true);
create policy self_read on app.users for select to drefyn_app
  using (id = app.current_user_id());
create policy self_update on app.users for update to drefyn_app
  using (id = app.current_user_id()) with check (id = app.current_user_id());

create table app.identities (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app.users (id) on delete cascade,
  provider text not null check (provider in ('github', 'google')),
  provider_subject text not null check (char_length(provider_subject) between 1 and 255),
  provider_email_normalized text not null
    check (char_length(provider_email_normalized) between 3 and 254),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint identities_provider_subject_key unique (provider, provider_subject),
  -- Leads with user_id, so it also serves the cascade and the person's own list.
  constraint identities_user_provider_key unique (user_id, provider)
);

alter table app.identities enable row level security;
alter table app.identities force row level security;

revoke all on app.identities from drefyn_app;
grant select, delete on app.identities to drefyn_app;
grant select, insert on app.identities to drefyn_auth;

create policy auth_access on app.identities to drefyn_auth using (true) with check (true);
create policy self_access on app.identities to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Written after sign in through a user context, so a stolen drefyn_auth credential can
-- never mint a session.
create table app.sessions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app.users (id) on delete cascade,
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  method text not null check (method in ('email', 'password', 'github', 'google', 'cli_link')),
  step_up_method text check (step_up_method in ('email', 'password', 'google', 'github_session')),
  authenticated_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text check (char_length(user_agent) <= 256),
  created_at timestamptz not null default now()
);

create index sessions_user_id_expires_at_idx on app.sessions (user_id, expires_at);

alter table app.sessions enable row level security;
alter table app.sessions force row level security;

-- Stated in full, so a later change to the default privileges cannot change this table.
revoke all on app.sessions from drefyn_app;
grant select, insert, update, delete on app.sessions to drefyn_app;

create policy self_access on app.sessions to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Hashes in a table of their own, which no organization scope reads.
create table app.password_credentials (
  user_id uuid primary key references app.users (id) on delete cascade,
  phc text not null check (char_length(phc) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app.password_credentials enable row level security;
alter table app.password_credentials force row level security;

-- The person sets and changes their password under a user context; sign in only reads the
-- hash and rehashes it when the parameters move up.
revoke all on app.password_credentials from drefyn_app;
grant select (user_id, phc, created_at, updated_at) on app.password_credentials to drefyn_app;
grant insert (user_id, phc) on app.password_credentials to drefyn_app;
grant update (phc, updated_at) on app.password_credentials to drefyn_app;
grant delete on app.password_credentials to drefyn_app;
grant select (user_id, phc) on app.password_credentials to drefyn_auth;
grant update (phc, updated_at) on app.password_credentials to drefyn_auth;

create policy auth_access on app.password_credentials to drefyn_auth
  using (true) with check (true);
create policy self_access on app.password_credentials to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Holds the addresses of people who never signed up, so drefyn_app holds nothing here.
create table app.email_challenges (
  id uuid primary key default uuidv7(),
  email_normalized text not null check (char_length(email_normalized) between 3 and 254),
  -- The CLI links through a session method, so it has no challenge purpose.
  purpose text not null check (purpose in ('sign_in', 'link_identity', 'step_up',
                                           'password_reset', 'email_change')),
  -- The signed in person an email change belongs to, matched to the session at completion.
  user_id uuid references app.users (id) on delete cascade,
  code_hmac bytea not null check (octet_length(code_hmac) = 32),
  browser_hash bytea not null check (octet_length(browser_hash) = 32),
  attempts integer not null default 0 check (attempts between 0 and 5),
  pending_provider text check (pending_provider in ('github', 'google')),
  pending_subject text check (char_length(pending_subject) between 1 and 255),
  return_to text check (char_length(return_to) <= 2048),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_challenges_email_change_user check (purpose <> 'email_change' or user_id is not null)
);

create index email_challenges_email_created_idx on app.email_challenges (email_normalized, created_at);
create index email_challenges_expires_at_idx on app.email_challenges (expires_at);
create index email_challenges_user_id_idx on app.email_challenges (user_id) where user_id is not null;

alter table app.email_challenges enable row level security;
alter table app.email_challenges force row level security;

revoke all on app.email_challenges from drefyn_app;
grant select, insert, update, delete on app.email_challenges to drefyn_auth;

create policy auth_access on app.email_challenges to drefyn_auth using (true) with check (true);

create table app.oauth_states (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  provider text not null check (provider in ('github', 'google')),
  purpose text not null check (purpose in ('sign_in', 'link_identity', 'step_up')),
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  nonce text check (char_length(nonce) between 16 and 128),
  browser_hash bytea not null check (octet_length(browser_hash) = 32),
  return_to text check (char_length(return_to) <= 2048),
  link_user_id uuid references app.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index oauth_states_expires_at_idx on app.oauth_states (expires_at);
create index oauth_states_link_user_id_idx on app.oauth_states (link_user_id)
  where link_user_id is not null;

alter table app.oauth_states enable row level security;
alter table app.oauth_states force row level security;

revoke all on app.oauth_states from drefyn_app;
grant select, insert, update, delete on app.oauth_states to drefyn_auth;

create policy auth_access on app.oauth_states to drefyn_auth using (true) with check (true);

-- Down Migration
drop table app.oauth_states;

drop table app.email_challenges;

drop table app.password_credentials;

drop table app.sessions;

drop table app.identities;

drop table app.users;
