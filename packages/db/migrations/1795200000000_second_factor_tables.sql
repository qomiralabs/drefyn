-- A person's own second factor. A sign in that needs the factor waits in factor_challenges,
-- so a sessions row still always means a signed in person. Every row is read and written
-- under the person's own user context. The sign in role gets no grant on any of the three,
-- so a stolen sign in credential reads no sealed secret and no recovery hash.

-- Up Migration
create table app.totp_credentials (
  user_id uuid primary key references app.users (id) on delete cascade,
  key_id text not null check (key_id ~ '^[a-z0-9]{1,8}$'),
  secret_nonce bytea not null check (octet_length(secret_nonce) = 12),
  -- A 20 byte secret and the 16 byte tag.
  secret_sealed bytea not null check (octet_length(secret_sealed) = 36),
  -- The replay guard: no step at or below this one is accepted again.
  last_used_step bigint,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 100),
  -- Null while enrolment is pending; only a confirmed row makes the factor required.
  confirmed_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.recovery_codes (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app.users (id) on delete cascade,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index recovery_codes_user_id_idx on app.recovery_codes (user_id);

-- Keyed by person, so each holds one live challenge and the table needs no sweep.
create table app.factor_challenges (
  user_id uuid primary key references app.users (id) on delete cascade,
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  method text not null check (method in ('email', 'password', 'github', 'google', 'cli_link')),
  return_to text check (char_length(return_to) <= 2048),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table app.totp_credentials enable row level security;
alter table app.totp_credentials force row level security;
alter table app.recovery_codes enable row level security;
alter table app.recovery_codes force row level security;
alter table app.factor_challenges enable row level security;
alter table app.factor_challenges force row level security;

-- Per column, so a column added later stays closed until someone grants it. Nothing for
-- drefyn_auth.
revoke all on app.totp_credentials from drefyn_app, drefyn_auth;
grant select (user_id, key_id, secret_nonce, secret_sealed, last_used_step, failed_attempts,
    confirmed_at, last_used_at, created_at, updated_at)
  on app.totp_credentials to drefyn_app;
grant insert (user_id, key_id, secret_nonce, secret_sealed, last_used_step, failed_attempts,
    confirmed_at, last_used_at, created_at, updated_at)
  on app.totp_credentials to drefyn_app;
grant update (key_id, secret_nonce, secret_sealed, last_used_step, failed_attempts,
    confirmed_at, last_used_at, updated_at)
  on app.totp_credentials to drefyn_app;
grant delete on app.totp_credentials to drefyn_app;

-- A code is only ever spent, never rewritten.
revoke all on app.recovery_codes from drefyn_app, drefyn_auth;
grant select (id, user_id, code_hash, used_at, created_at) on app.recovery_codes to drefyn_app;
grant insert (id, user_id, code_hash, used_at, created_at) on app.recovery_codes to drefyn_app;
grant update (used_at) on app.recovery_codes to drefyn_app;
grant delete on app.recovery_codes to drefyn_app;

-- Only the attempt count moves. A new sign in deletes the old challenge and inserts its
-- own, so two racing sign ins collide on the key instead of one quietly replacing the other.
revoke all on app.factor_challenges from drefyn_app, drefyn_auth;
grant select (user_id, secret_hash, method, return_to, attempts, expires_at, created_at)
  on app.factor_challenges to drefyn_app;
grant insert (user_id, secret_hash, method, return_to, attempts, expires_at, created_at)
  on app.factor_challenges to drefyn_app;
grant update (attempts) on app.factor_challenges to drefyn_app;
grant delete on app.factor_challenges to drefyn_app;

create policy self_access on app.totp_credentials to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy self_access on app.recovery_codes to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy self_access on app.factor_challenges to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- The identity migration left this check to Postgres to name. No if exists: a different name
-- must stop the migration rather than leave the old check beside the new one.
alter table app.sessions drop constraint sessions_step_up_method_check;
alter table app.sessions add constraint sessions_step_up_method_check check (step_up_method in
  ('email', 'password', 'google', 'github_session', 'totp', 'recovery_code'));

-- Down Migration
-- Destroys every enrolment, so it is only for use before the factor ships. A session that
-- stepped up with the factor stays signed in but must step up again, since the older check
-- and reader refuse the new values. The migration role matches no policy, so force is lifted
-- around the change or it would touch nothing.
alter table app.sessions no force row level security;
update app.sessions set step_up_method = null
  where step_up_method in ('totp', 'recovery_code');
alter table app.sessions force row level security;
alter table app.sessions drop constraint sessions_step_up_method_check;
alter table app.sessions add constraint sessions_step_up_method_check check (step_up_method in
  ('email', 'password', 'google', 'github_session'));

drop table app.factor_challenges;
drop table app.recovery_codes;
drop table app.totp_credentials;
